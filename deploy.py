#!/usr/bin/env python3
"""deploy.py — one tool to run the Leaf Annotation stack: prod, or a throwaway test copy.

Runs the stack as YOU + a shared group (APP_GROUP in .env), so data + backups are group-owned,
never root — no UID typed or hardcoded, and no sudo needed (works even on a host you don't own,
as long as you're in APP_GROUP). Auto-computes the build version. Stdlib only, no dependencies.

Test is fully decoupled from prod: it does NOT require prod to be running, and it never copies
prod's live volume. Test's data comes from --data-mode, not from prod.

  ./deploy.py create-dot-env                  # interactively write a .env (generates SECRET_KEY)
  ./deploy.py start prod                       # build (auto-version) + run prod as you+group
  ./deploy.py start prod --with-backup         # + the litestream/lsyncd backup sidecars
  ./deploy.py start test --data-mode reset     # run the real image against a fresh empty volume
  ./deploy.py start test --data-mode restore   # ...against data restored from BACKUP_DIR
  ./deploy.py start test --data-mode keep      # ...reusing whatever's already in the test volume
  ./deploy.py stop prod | test
  ./deploy.py restore                          # seed a fresh/wiped prod host FROM an existing backup
"""
import argparse
import getpass
import grp
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IMAGE = "leaf-annotation:latest"
TEST_CT = "leaf-testenv"
TEST_VOL = "leaf-test-data"


def die(msg):
    sys.exit(f"deploy.py: {msg}")


def load_env():
    env = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k] = v
    return env


def sh(cmd, **kw):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


def git_sha():
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True)
        return out.stdout.strip()
    except Exception:
        return ""


def identity(env):
    """(uid, gid) to run as: your uid + the APP_GROUP gid. No sudo, nothing hardcoded."""
    group = env.get("APP_GROUP")
    if not group:
        die("APP_GROUP not set in .env — run: ./deploy.py create-dot-env")
    try:
        gid = grp.getgrnam(group).gr_gid
    except KeyError:
        die(f"group '{group}' not found on this host (are you a member?)")
    return str(os.getuid()), str(gid)


def base_env(env):
    """Version + project pin for build/compose. No identity → `test` and `stop` work without
    APP_GROUP or a .env (test runs as your personal uid/gid; stop doesn't start containers)."""
    e = dict(os.environ)
    e.update(GIT_SHA=git_sha(), BUILD_TIME=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    e.setdefault("COMPOSE_PROJECT_NAME", env.get("COMPOSE_PROJECT_NAME", "leaf-annotation-tool"))
    return e


def prod_env(env):
    """base_env + run-as identity (your uid + the APP_GROUP gid) for running prod containers."""
    puid, pgid = identity(env)
    e = base_env(env)
    e.update(PUID=puid, PGID=pgid)
    return e


def bake(env):
    # -f docker-bake.hcl only: bake otherwise also loads compose.yaml and demands BACKUP_DIR
    # (from the backup services) even to build just `app`.
    sh(["docker", "buildx", "bake", "-f", "docker-bake.hcl", "app"], cwd=str(ROOT), env=base_env(env))


def start_prod(env, with_backup):
    bake(env)
    up = ["docker", "compose"] + (["--profile", "backup"] if with_backup else []) + ["up", "-d"]
    sh(up, cwd=str(ROOT), env=prod_env(env))
    print(f"prod up (version {git_sha() or 'dev'}). backup: {'on' if with_backup else 'off'}.")


def _reset_test_volume(puid, pgid):
    """Fresh, empty test volume. No prod involvement — matches seed.py's _seed_clean semantics
    (wipe-then-empty) but at the Docker-volume level, since the test container boots the prod
    image (db_seed='existing' inside wsgi.py) and just needs an empty /data to seed itself onto.
    A freshly-created named volume is root-owned; the app container runs as the personal
    puid:pgid (not root), so chown it first or auto_create_schema's sqlite3.connect() fails with
    'unable to open database file'."""
    subprocess.run(["docker", "volume", "rm", TEST_VOL], capture_output=True)
    sh(["docker", "volume", "create", TEST_VOL])
    sh(["docker", "run", "--rm", "-v", f"{TEST_VOL}:/data", "alpine",
        "chown", "-R", f"{puid}:{pgid}", "/data"])


def _restore_test_volume(env, puid, pgid):
    """Populate the test volume from the host BACKUP (litestream file replica + lsyncd file
    mirror) — the SAME mechanism prod restore/webapp/restore.py use — never from prod's live
    volume. Mirrors compose.yaml's one-shot `restore` service, retargeted at TEST_VOL."""
    backup_dir = env.get("BACKUP_DIR")
    if not backup_dir:
        die("--data-mode restore needs BACKUP_DIR set in .env (the host backup root: "
            "<BACKUP_DIR>/db is the litestream replica, <BACKUP_DIR>/files is the file mirror) — "
            "test restores from BACKUP, never from prod's live volume.")
    db_backup = Path(backup_dir) / "db"
    files_backup = Path(backup_dir) / "files"
    if not db_backup.is_dir():
        die(f"--data-mode restore: no litestream replica at {db_backup}")
    _reset_test_volume(puid, pgid)  # restore always targets a clean, chowned volume (mirrors webapp/restore.py)
    mounts = ["-v", f"{TEST_VOL}:/data",
              "-v", f"{ROOT / 'ops' / 'litestream.yml'}:/etc/litestream.yml:ro",
              "-v", f"{db_backup}:/backup/db:ro"]
    cmd = "litestream restore -if-db-not-exists -config /etc/litestream.yml /data/app.db"
    if files_backup.is_dir():
        mounts += ["-v", f"{files_backup}:/backup/files:ro"]
        cmd += " && (cd /backup/files && tar cf - . | tar xf - -C /data)"
    else:
        print(f"[restore] WARNING: no file backup at {files_backup} — DB restored, but "
              f"images/jsons/manifest.json were NOT (nothing to copy from).")
    # litestream leaves app.db.tmp-shm/app.db.tmp-wal sidecars from applying WAL against its temp
    # path (harmless — SQLite looks for app.db-wal/app.db-shm, not .tmp-* — but stray); same
    # cleanup webapp/restore.py does for the native-Python restore path.
    cmd += " && rm -f /data/app.db.tmp-* && echo '[restore] done'"
    # --entrypoint override: the image's default ENTRYPOINT is `litestream` itself (see
    # compose.yaml's `restore` service, which overrides it the same way), so plain `sh -c ...`
    # as the command would run as an argument TO litestream, not as a shell.
    sh(["docker", "run", "--rm", *mounts, "--user", f"{puid}:{pgid}",
        "--entrypoint", "/bin/sh", "litestream/litestream:0.3.13", "-c", cmd])


def _test_volume_exists():
    return subprocess.run(["docker", "volume", "inspect", TEST_VOL], capture_output=True).returncode == 0


def _prep_test_data(mode, env, puid, pgid):
    if mode == "keep":
        if not _test_volume_exists():
            # First-ever test run: a bare `docker run -v <new-name>:/data` would auto-create the
            # volume root-owned, and the app (running as puid:pgid, not root) can't open its DB
            # file in a root-owned dir — so this still needs the create+chown, just never a wipe
            # of anything that already exists.
            print("test volume doesn't exist yet — creating it empty (first run)…")
            _reset_test_volume(puid, pgid)
        return  # otherwise: reuse the volume exactly as-is, no wipe, no seed
    if mode == "reset":
        print("resetting test volume to empty…")
        _reset_test_volume(puid, pgid)
    elif mode == "restore":
        print("restoring test volume from backup…")
        _restore_test_volume(env, puid, pgid)
    else:
        raise ValueError(f"unknown data-mode: {mode!r}")


def start_test(env, port, data_mode):
    if data_mode is None:
        die("start test requires --data-mode {keep|reset|restore} (no default — this is a "
            "wipe-guard, since 'reset' deletes the test volume). Choose: "
            "keep (reuse test data as-is), reset (fresh empty data), "
            "or restore (populate from BACKUP_DIR).")
    puid, pgid = str(os.getuid()), str(os.getgid())  # personal identity — test data isn't shared
    bake(env)  # test the CURRENT code, same image prod would get
    subprocess.run(["docker", "rm", "-f", TEST_CT], capture_output=True)  # release the volume first
    _prep_test_data(data_mode, env, puid, pgid)
    admin_pw = env.get("ADMIN_PASSWORD")  # only takes effect if no admin exists yet (fresh 'reset'
    admin_flags = [] if not admin_pw else ["-e", f"ADMIN_PASSWORD={admin_pw}"]  # data); no-op on keep/restore
    sh(["docker", "run", "-d", "--rm", "--name", TEST_CT,
        "-p", f"{port}:{port}", "-e", f"PORT={port}",
        "-e", f"SECRET_KEY=testenv-{secrets.token_hex(8)}", *admin_flags,
        "--user", f"{puid}:{pgid}", "-v", f"{TEST_VOL}:/data", IMAGE])
    print(f"test up on http://localhost:{port}  (data-mode={data_mode}; prod not required, not touched).")
    print(f"  logs: docker logs -f {TEST_CT}   |   stop: ./deploy.py stop test")


def stop(env, target):
    if target == "prod":
        # --profile backup so `down` also removes the backup sidecars; without it they linger and
        # hold the network. Dummy BACKUP_DIR only satisfies interpolation (down mounts nothing).
        e = base_env(env)
        e.setdefault("BACKUP_DIR", "/unused-for-down")
        sh(["docker", "compose", "--profile", "backup", "down", "--remove-orphans"],
           cwd=str(ROOT), env=e)
    else:
        subprocess.run(["docker", "rm", "-f", TEST_CT])
        subprocess.run(["docker", "volume", "rm", TEST_VOL], capture_output=True)


def restore(env):
    sh(["docker", "compose", "run", "--rm", "restore"], cwd=str(ROOT), env=prod_env(env))


def create_dot_env():
    f = ROOT / ".env"
    if f.exists() and input(".env already exists — overwrite? [y/N] ").strip().lower() != "y":
        die("aborted")
    port = input("PORT [5000]: ").strip() or "5000"
    group = input("APP_GROUP (shared unix group that co-owns data + backups): ").strip()
    if not group:
        die("APP_GROUP is required")
    backup = input("BACKUP_DIR (absolute host path for backups; blank = no backup): ").strip()
    admin = getpass.getpass("ADMIN_PASSWORD (first-boot admin login): ")
    while not admin:
        admin = getpass.getpass("ADMIN_PASSWORD can't be empty: ")
    lines = [f"PORT={port}", f"APP_GROUP={group}"]
    if backup:
        lines.append(f"BACKUP_DIR={backup}")
    lines += [f"SECRET_KEY={secrets.token_urlsafe(32)}", f"ADMIN_PASSWORD={admin}",
              "COMPOSE_PROJECT_NAME=leaf-annotation-tool"]
    f.write_text("\n".join(lines) + "\n")
    os.chmod(f, 0o600)
    print(f"wrote {f} (SECRET_KEY generated for you). Next: ./deploy.py start prod")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ps = sub.add_parser("start", help="build + run prod, or a throwaway test copy")
    ps.add_argument("target", choices=["prod", "test"])
    ps.add_argument("--with-backup", action="store_true", help="prod: also run the backup sidecars")
    ps.add_argument("--port", type=int, default=5001, help="test: host port (default 5001)")
    ps.add_argument("--data-mode", choices=["keep", "reset", "restore"], default=None,
                    help="REQUIRED for test: keep (reuse test data as-is), reset (fresh empty "
                         "data), restore (populate from BACKUP_DIR). No default (wipe-guard). "
                         "Ignored for prod.")
    st = sub.add_parser("stop"); st.add_argument("target", choices=["prod", "test"])
    sub.add_parser("restore", help="seed a fresh prod host from an existing backup")
    sub.add_parser("create-dot-env", help="interactively write a .env")
    a = ap.parse_args()
    env = load_env()
    if a.cmd == "create-dot-env":
        create_dot_env()
    elif a.cmd == "start":
        (start_prod(env, a.with_backup) if a.target == "prod" else start_test(env, a.port, a.data_mode))
    elif a.cmd == "stop":
        stop(env, a.target)
    elif a.cmd == "restore":
        restore(env)


if __name__ == "__main__":
    main()
