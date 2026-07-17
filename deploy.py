#!/usr/bin/env python3
"""deploy.py — one tool to run the Leaf Annotation stack.

Owns everything situational (config source, containerization, mode dev/prod, services).
The webapp package knows NOTHING about prod/dev/test/gate — it's a library exposing
`webapp.run(cfg)`; deploy.py + deploy_lib + container_entry.py build the AppConfig for
each mode and hand it to webapp.run.

Runs prod as YOU + a shared group (app_group in the [deploy] section of app.config.toml),
so data + backups are group-owned, never root — no UID typed or hardcoded, and no sudo
needed (works even on a host you don't own, as long as you're in app_group).

Config: sectioned, versioned app.config.toml (create/upgrade via create-config / migrate-config).
deploy_lib.resolve()
flattens each service's slice; secrets never leave the resolved config file (which the
prod path writes to an ephemeral /tmp dir and hands to compose as an `app-config` secret,
mounted read-only at /run/secrets/app-config — never via env, which leaks through
`docker inspect`).

  ./deploy.py create-config                    # interactively write app.config.toml (versioned)
  ./deploy.py migrate-config                   # upgrade a legacy/flat config to the current schema
  ./deploy.py dev                              # in-process dev server (no container)
  ./deploy.py prod                             # build + run prod containers
  ./deploy.py prod --with-backup               # + the litestream/lsyncd backup sidecars
  ./deploy.py prod --admin-password '…'        # + seed the admin on a FRESH DB (never overwrites one)
  ./deploy.py start test --data-mode reset --admin-password '…'  # fresh volume + seed the admin
  ./deploy.py start test --data-mode restore   # ...against data restored from BACKUP_DIR (admin comes with it)
  ./deploy.py start test --data-mode keep      # ...reusing whatever's already in the test volume
  ./deploy.py start test --data-mode fixture   # ...on the in-repo synthetic dataset (subagents)
  ./deploy.py start test --data-mode reset --branch feat/foo   # build+test a branch
  ./deploy.py stop prod | test
  ./deploy.py restore                          # seed a fresh/wiped prod host FROM an existing backup

admin_password is CLI-ONLY (never in the config file): --admin-password seeds the admin on a
fresh/empty DB and is a no-op on an existing one. `config_version` guards against reading a stale
config — run migrate-config if deploy.py says your config is out of date.
"""
import argparse
import getpass
import grp
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import deploy_lib
from webapp.seed import free_port

ROOT = Path(__file__).resolve().parent
IMAGE = "leaf-annotation:latest"
TEST_CT = "leaf-testenv"
TEST_VOL = "leaf-test-data"
CONFIG_FILE = ROOT / "app.config.toml"
# In-repo synthetic dataset for subagent test envs — DISJOINT from prod by construction, never
# sourced from prod's volume or backups. Rebuild/extend: webapp/tests/build_subagent_fixture.py.
FIXTURE_DIR = ROOT / "webapp" / "tests" / "fixtures" / "subagent_dataset"


def die(msg):
    sys.exit(f"deploy.py: {msg}")


def load_master():
    """Load + version-validate the sectioned master config. On a missing/old config_version,
    fail loudly with the migrate-config instruction (never a downstream parse crash)."""
    try:
        master = deploy_lib.load_master(CONFIG_FILE)
    except deploy_lib.ConfigVersionError as e:
        die(str(e))
    if (master.get("app") or {}).get("admin_password"):
        print("deploy.py: WARNING — [app].admin_password is set but IGNORED (admin_password is "
              "CLI-only now; pass --admin-password to seed a fresh admin). Remove it from the config.",
              file=sys.stderr)
    return master


def _inject_admin_password(resolved, admin_password):
    """Put the operator's --admin-password into the resolved app slice for THIS run only
    (seed semantics: build_appconfig sets admin_password without force, so it creates the
    admin only when none exists and never overwrites one). Never written to app.config.toml."""
    if admin_password:
        resolved["app"]["admin_password"] = admin_password


def sh(cmd, **kw):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


def git_sha(root=ROOT):
    """SHA of `root`'s checked-out HEAD — pass the actual build_root (main checkout, or a
    --branch worktree) so the baked-in version identity matches what was ACTUALLY built, not
    always the main checkout's HEAD."""
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True)
        return out.stdout.strip()
    except Exception:
        return ""


def identity(master):
    """(uid, gid) to run prod containers as: your uid + the [deploy].app_group gid.
    No sudo, nothing hardcoded."""
    deploy_section = master.get("deploy") or {}
    group = deploy_section.get("app_group")
    if not group:
        die("[deploy].app_group not set in app.config.toml — run: ./deploy.py create-config")
    try:
        gid = grp.getgrnam(group).gr_gid
    except KeyError:
        die(f"group '{group}' not found on this host (are you a member?)")
    return str(os.getuid()), str(gid)


def compose_project_name(master):
    return (master.get("deploy") or {}).get("compose_project_name", "leaf-annotation-tool")


def base_compose_env(master, root=ROOT):
    """Host-side env for `docker compose` interpolation. NEVER injected into the container
    itself (the container config comes from the mounted `app-config` secret file). Only
    non-secret orchestration values: version identity, project name."""
    e = dict(os.environ)
    e.update(GIT_SHA=git_sha(root), BUILD_TIME=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    e.setdefault("COMPOSE_PROJECT_NAME", compose_project_name(master))
    return e


def prod_compose_env(master, app_config_file, resolved_app):
    """base_compose_env + run-as identity + PORT (for the compose `ports:` interpolation)
    + APP_CONFIG_FILE (for the compose `secrets: file:` reference) + BACKUP_DIR (only if
    set — the compose.backup.yaml sidecar mounts need it). Only non-secret values leak into
    this env; the app's SECRET_KEY / ADMIN_PASSWORD ride inside app_config_file, mounted as
    a compose secret."""
    puid, pgid = identity(master)
    e = base_compose_env(master)
    e["PUID"] = puid
    e["PGID"] = pgid
    e["PORT"] = str(resolved_app.get("port", 5000))
    e["APP_CONFIG_FILE"] = str(app_config_file)
    backup = master.get("backup") or {}
    if backup.get("backup_dir"):
        e["BACKUP_DIR"] = backup["backup_dir"]
    return e


def _placeholder_app_config():
    """A tiny empty compose-secret file for maintenance ops (stop/restore) that don't need
    the real app config but must still satisfy compose's `secrets: file:` at parse time.
    Written to an ephemeral /tmp dir (0700) so it's cleaned up by the OS."""
    tmpdir = deploy_lib.make_ephemeral_config_dir()
    dest = tmpdir / "app-config.toml"
    dest.write_text("# placeholder — maintenance op, not the real app config\n")
    dest.chmod(0o600)
    return dest


def resolve_build_root(branch):
    """(build_root, worktree_dir_or_None) for bake(). No --branch: build the current checkout,
    unchanged. With --branch: check out that ref into a throwaway git worktree so the build reads
    that ref's tree without disturbing the user's working tree — --detach so this works even if
    --branch names the branch currently checked out in the main worktree (git normally refuses to
    check out the same branch twice; a detached worktree sidesteps that)."""
    if not branch:
        return ROOT, None
    wt_dir = Path(tempfile.mkdtemp(prefix="leaf-deploy-build-"))
    wt_dir.rmdir()  # git worktree add wants to create this path itself
    sh(["git", "-C", str(ROOT), "worktree", "add", "--detach", str(wt_dir), branch])
    return wt_dir, wt_dir


def cleanup_worktree(wt_dir):
    if wt_dir is None:
        return
    subprocess.run(["git", "-C", str(ROOT), "worktree", "remove", "--force", str(wt_dir)],
                    capture_output=True)
    shutil.rmtree(wt_dir, ignore_errors=True)


def bake(master, root=ROOT):
    # -f docker-bake.hcl only: bake otherwise also loads compose.yaml and demands
    # APP_CONFIG_FILE + BACKUP_DIR (compose interpolation) even to build just `app`. cwd=root
    # so the "." build context (docker-bake.hcl) resolves against the ref being built.
    sh(["docker", "buildx", "bake", "-f", "docker-bake.hcl", "app"],
       cwd=str(root), env=base_compose_env(master, root))


def _ensure_prod_volume(penv, name):
    """First-boot only: create + chown a prod named volume if it doesn't exist yet, so a
    non-root sidecar (running as PUID:PGID — see prod_compose_env()) can write into it.

    Idempotent + non-destructive: only acts when the volume does NOT already exist. On an
    existing volume (not first boot) this is a no-op — never wipe, never blanket re-chown."""
    project = penv.get("COMPOSE_PROJECT_NAME", "leaf-annotation-tool")
    vol = f"{project}_{name}"
    if subprocess.run(["docker", "volume", "inspect", vol], capture_output=True).returncode == 0:
        return  # already exists — not first boot; never touch (no wipe, no re-chown)
    print(f"prod {name!r} volume {vol!r} doesn't exist yet — creating it (first boot)…")
    sh(["docker", "volume", "create",
        "--label", f"com.docker.compose.project={project}",
        "--label", f"com.docker.compose.volume={name}",
        vol])
    sh(["docker", "run", "--rm", "-v", f"{vol}:/data", "alpine",
        "chown", "-R", f"{penv['PUID']}:{penv['PGID']}", "/data"])


def start_prod(master, with_backup, branch, admin_password=None):
    """Build image + write resolved app config to an ephemeral /tmp secret file + compose up.
    The container reads its config from the mounted /run/secrets/app-config, not from env."""
    resolved = deploy_lib.resolve(master, "prod")
    _inject_admin_password(resolved, admin_password)
    resolved_app = resolved["app"]
    # Required-ness validated AFTER resolve. secret_key is mandatory for the app to boot;
    # fail here with a clear message rather than letting the container crash-loop.
    if not resolved_app.get("secret_key"):
        die("[app].secret_key not set in app.config.toml — prod can't start without it. "
            "Run: ./deploy.py create-config")

    build_root, worktree = resolve_build_root(branch)
    try:
        bake(master, root=build_root)
        version = git_sha(build_root) or "dev"
    finally:
        cleanup_worktree(worktree)

    # Write the resolved app slice to an ephemeral /tmp file (0600 in a 0700 dir). Compose
    # mounts this as the `app-config` secret at /run/secrets/app-config inside the container;
    # container_entry.py reads it back via deploy_lib.launch_from_config_file. Secrets never
    # touch the container's env (docker inspect would leak them) or the CLI (ps would).
    tmpdir = deploy_lib.make_ephemeral_config_dir()
    app_config_file = tmpdir / "app-config.toml"
    deploy_lib.write_service_config(resolved_app, app_config_file)

    penv = prod_compose_env(master, app_config_file, resolved_app)
    _ensure_prod_volume(penv, "leaf-data")

    up = ["docker", "compose", "-f", "compose.yaml"]
    if with_backup:
        up += ["-f", "compose.backup.yaml"]
        _ensure_prod_volume(penv, "lsyncd-status")
    up += ["up", "-d"]
    sh(up, cwd=str(ROOT), env=penv)
    print(f"prod up (version {version}). backup: {'on' if with_backup else 'off'}.")
    print(f"  app-config secret: {app_config_file}  (0600, ephemeral)")


def start_dev(master, admin_password=None):
    """Dev = in-process, no container. Resolve [app]+[dev] → AppConfig → webapp.run(cfg).
    Same webapp.run path prod uses in-container and the gate uses ephemerally — differ only
    in the config source."""
    resolved = deploy_lib.resolve(master, "dev")
    _inject_admin_password(resolved, admin_password)
    resolved_app = resolved["app"]
    if not resolved_app.get("secret_key"):
        die("[app].secret_key not set in app.config.toml — dev can't start without it. "
            "Run: ./deploy.py create-config")
    cfg = deploy_lib.build_appconfig(resolved_app)
    from webapp.wsgi import run
    print(f"dev up on http://{cfg.host}:{cfg.port}  (in-process, no container)")
    return run(cfg)


def _reset_test_volume(puid, pgid):
    """Fresh, empty test volume. No prod involvement — matches seed.py's _seed_clean semantics
    (wipe-then-empty) but at the Docker-volume level, since the test container boots the prod
    image (db_seed='existing' inside container_entry) and just needs an empty /data to seed
    itself onto. A freshly-created named volume is root-owned; the app container runs as the
    personal puid:pgid (not root), so chown it first or auto_create_schema's sqlite3.connect()
    fails with 'unable to open database file'."""
    subprocess.run(["docker", "volume", "rm", TEST_VOL], capture_output=True)
    sh(["docker", "volume", "create", TEST_VOL])
    sh(["docker", "run", "--rm", "-v", f"{TEST_VOL}:/data", "alpine",
        "chown", "-R", f"{puid}:{pgid}", "/data"])


def _restore_test_volume(master, puid, pgid):
    """Populate the test volume from the host BACKUP (litestream file replica + lsyncd file
    mirror) — the SAME mechanism prod restore/webapp/restore.py use — never from prod's live
    volume. Mirrors compose.backup.yaml's one-shot `restore` service, retargeted at TEST_VOL."""
    backup_dir = (master.get("backup") or {}).get("backup_dir")
    if not backup_dir:
        die("--data-mode restore needs [backup].backup_dir set in app.config.toml (the host "
            "backup root: <backup_dir>/db is the litestream replica, <backup_dir>/files is the "
            "file mirror) — test restores from BACKUP, never from prod's live volume.")
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
    cmd += " && rm -f /data/app.db.tmp-* && echo '[restore] done'"
    sh(["docker", "run", "--rm", *mounts, "--user", f"{puid}:{pgid}",
        "--entrypoint", "/bin/sh", "litestream/litestream:0.3.13", "-c", cmd])


def _fixture_test_volume(puid, pgid):
    """Populate the test volume from the in-repo synthetic FIXTURE (webapp/tests/fixtures/…).
    This is the SUBAGENT data source: disjoint from prod by construction, never prod's volume or
    backups. Copies the fixture dir wholesale into a fresh, chowned volume."""
    if not (FIXTURE_DIR / "app.db").is_file():
        die(f"--data-mode fixture: no fixture at {FIXTURE_DIR} — build it first with "
            f"`uv run python webapp/tests/build_subagent_fixture.py`.")
    _reset_test_volume(puid, pgid)  # fresh, chowned volume to copy onto
    sh(["docker", "run", "--rm", "-v", f"{FIXTURE_DIR}:/src:ro", "-v", f"{TEST_VOL}:/data",
        "alpine", "sh", "-c", f"cp -a /src/. /data/ && chown -R {puid}:{pgid} /data"])


def _test_volume_exists():
    return subprocess.run(["docker", "volume", "inspect", TEST_VOL], capture_output=True).returncode == 0


def _prep_test_data(mode, master, puid, pgid):
    if mode == "keep":
        if not _test_volume_exists():
            print("test volume doesn't exist yet — creating it empty (first run)…")
            _reset_test_volume(puid, pgid)
        return
    if mode == "reset":
        print("resetting test volume to empty…")
        _reset_test_volume(puid, pgid)
    elif mode == "restore":
        print("restoring test volume from backup…")
        _restore_test_volume(master, puid, pgid)
    elif mode == "fixture":
        print("loading test volume from the in-repo synthetic fixture (disjoint from prod)…")
        _fixture_test_volume(puid, pgid)
    else:
        raise ValueError(f"unknown data-mode: {mode!r}")


def start_test(master, port, data_mode, branch, admin_password=None):
    """Throwaway test container against the SAME image prod would get. Test mounts its own
    resolved-config file at /run/secrets/app-config via a plain bind-mount (no compose here —
    this is a bare `docker run` for concurrency-safety and simpler teardown). Config values
    (SECRET_KEY / ADMIN_PASSWORD / PORT) still ride in that file, not in env."""
    if data_mode is None:
        die("start test requires --data-mode {keep|reset|restore|fixture} (no default — this is a "
            "wipe-guard, since reset/restore/fixture replace the test volume).")
    puid, pgid = str(os.getuid()), str(os.getgid())  # personal identity — test data isn't shared
    build_root, worktree = resolve_build_root(branch)
    try:
        bake(master, root=build_root)
    finally:
        cleanup_worktree(worktree)
    subprocess.run(["docker", "rm", "-f", TEST_CT], capture_output=True)  # release the volume first
    _prep_test_data(data_mode, master, puid, pgid)
    if port is None:
        port = free_port()

    # Resolve a "prod-shaped" test app config, then override the transient bits (port,
    # secret_key) for this test run. admin_password inherits from [app] (harmless — only
    # takes effect on fresh 'reset' data; no-op on keep/restore).
    resolved = deploy_lib.resolve(master, "prod")
    resolved_app = dict(resolved["app"])
    resolved_app["port"] = port
    resolved_app["secret_key"] = f"testenv-{secrets.token_hex(8)}"
    # --admin-password seeds the admin ONLY on a fresh/empty DB (reset/fixture) — never
    # overwrites one, so it's a no-op on restore/keep (whose DBs already carry their admin).
    if admin_password:
        resolved_app["admin_password"] = admin_password

    tmpdir = deploy_lib.make_ephemeral_config_dir()
    app_config_file = tmpdir / "app-config.toml"
    deploy_lib.write_service_config(resolved_app, app_config_file)

    sh(["docker", "run", "-d", "--rm", "--name", TEST_CT,
        "-p", f"{port}:{port}",
        "--user", f"{puid}:{pgid}", "-v", f"{TEST_VOL}:/data",
        "-v", f"{app_config_file}:/run/secrets/app-config:ro",
        IMAGE])
    print(f"test up on http://localhost:{port}  (data-mode={data_mode}; prod not required, not touched).")
    print(f"  logs: docker logs -f {TEST_CT}   |   stop: ./deploy.py stop test")


def stop(master, target):
    if target == "prod":
        # -f compose.backup.yaml too, so `down` also removes the backup sidecars if they're up;
        # without it they linger and hold the network. Placeholder APP_CONFIG_FILE + BACKUP_DIR
        # satisfy compose's parse-time interpolation guards (down mounts nothing).
        e = base_compose_env(master)
        e.setdefault("BACKUP_DIR", "/unused-for-down")
        e.setdefault("APP_CONFIG_FILE", str(_placeholder_app_config()))
        e.setdefault("PORT", str(((master.get("app") or {}).get("port")) or 5000))
        e.setdefault("PUID", str(os.getuid()))
        e.setdefault("PGID", str(os.getgid()))
        sh(["docker", "compose", "-f", "compose.yaml", "-f", "compose.backup.yaml",
            "down", "--remove-orphans"], cwd=str(ROOT), env=e)
    else:
        subprocess.run(["docker", "rm", "-f", TEST_CT])
        subprocess.run(["docker", "volume", "rm", TEST_VOL], capture_output=True)


def restore(master):
    # restore lives in compose.backup.yaml (see its header) — always composed with the base.
    # It runs the litestream image (not the app), so it never reads app-config; supply a
    # placeholder so compose's parse-time `secrets: file:` interpolation succeeds.
    placeholder = _placeholder_app_config()
    resolved_app = deploy_lib.resolve(master, "prod")["app"]
    penv = prod_compose_env(master, placeholder, resolved_app)
    sh(["docker", "compose", "-f", "compose.yaml", "-f", "compose.backup.yaml", "run", "--rm", "restore"],
       cwd=str(ROOT), env=penv)


def create_config():
    """Interactively write a versioned, sectioned app.config.toml. Non-destructive: pre-fills
    from any existing config (flat or sectioned), collects everything first, and only confirms
    the overwrite at the END — the old file is untouched until you say yes. admin_password is
    NOT stored (CLI-only); the wizard prompts for it on the FRESH path only, to seed the admin."""
    existing = deploy_lib.load_master_raw(CONFIG_FILE)              # tolerant — may be flat/legacy
    pre, _ = deploy_lib.migrate_master(existing) if existing else ({}, False)  # reuse routing to pre-fill
    pre_app, pre_backup, pre_deploy = pre.get("app", {}), pre.get("backup", {}), pre.get("deploy", {})

    print(f"Configuring {CONFIG_FILE}")
    print("(writes ONLY this file, in this directory — does not touch any other clone.)\n")

    def ask(prompt, default=""):
        d = f" [{default}]" if default else ""
        return input(f"{prompt}{d}: ").strip() or default

    port = ask("port", str(pre_app.get("port", 5000)))
    group = ask("[deploy].app_group (shared unix group that co-owns data + backups)", pre_deploy.get("app_group", ""))
    if not group:
        die("app_group is required")
    backup = ask("[backup].backup_dir (absolute host path for backups; blank = none)", pre_backup.get("backup_dir", ""))
    cpn = pre_deploy.get("compose_project_name", "leaf-annotation-tool")
    secret_key = pre_app.get("secret_key") or secrets.token_urlsafe(32)

    data_source = ""
    while data_source not in ("fresh", "restore"):
        data_source = (ask("data source — 'fresh' (new empty DB) or 'restore' (from a backup)", "fresh")).lower()
    admin_password = None
    if data_source == "fresh":
        admin_password = getpass.getpass("admin_password to SEED the new admin (used once on the fresh DB, NOT stored in the config): ")
        while not admin_password:
            admin_password = getpass.getpass("admin_password can't be empty for a fresh DB: ")
    elif not backup:
        die("restore needs a backup_dir — re-run and set [backup].backup_dir")

    master = {
        "config_version": deploy_lib.CURRENT_CONFIG_VERSION,
        "app": {"port": int(port), "secret_key": secret_key},
        "deploy": {"app_group": group, "compose_project_name": cpn},
        "dev": {"host": "127.0.0.1"},
    }
    if backup:
        master["backup"] = {"backup_dir": backup}
    text = deploy_lib.dumps_master(master)

    print("\n--- about to write app.config.toml ---")
    print(text)
    if CONFIG_FILE.exists() and input(f"{CONFIG_FILE} exists — overwrite it? [y/N] ").strip().lower() != "y":
        die("aborted — existing config left untouched")
    CONFIG_FILE.write_text(text)
    os.chmod(CONFIG_FILE, 0o600)
    print(f"wrote {CONFIG_FILE} (secret_key {'kept' if pre_app.get('secret_key') else 'generated'}).")

    # Offer to set up a test env end-to-end (config + data + admin), per the intended flow.
    mode = "reset" if data_source == "fresh" else "restore"
    if input(f"\nset up a test environment now (start test --data-mode {mode})? [y/N] ").strip().lower() == "y":
        master = load_master()  # reload the just-written (now-valid) config
        start_test(master, None, mode, None, admin_password)
    else:
        if data_source == "fresh":
            print("\nNext — seed the admin on a fresh DB (admin_password is a CLI flag, not stored):")
            print("  ./deploy.py start test --data-mode reset --admin-password '<the password you entered>'")
            print("  # prod equivalent:  ./deploy.py prod --admin-password '…'")
        else:
            print("\nNext — restore data + admin from your backup:")
            print("  ./deploy.py start test --data-mode restore")


def migrate_config():
    """Upgrade a legacy (flat or unversioned) app.config.toml to the current sectioned,
    versioned schema. Lossless except admin_password, which is dropped (CLI-only now). Backs
    up the original first."""
    if not CONFIG_FILE.exists():
        die(f"no {CONFIG_FILE} to migrate — run ./deploy.py create-config for a fresh one.")
    raw = deploy_lib.load_master_raw(CONFIG_FILE)
    if raw.get("config_version") == deploy_lib.CURRENT_CONFIG_VERSION:
        print(f"{CONFIG_FILE} is already config_version {deploy_lib.CURRENT_CONFIG_VERSION} — nothing to do.")
        return
    migrated, dropped = deploy_lib.migrate_master(raw)
    backup = CONFIG_FILE.with_name(CONFIG_FILE.name + ".bak")
    n = 1
    while backup.exists():
        backup = CONFIG_FILE.with_name(f"{CONFIG_FILE.name}.bak{n}")
        n += 1
    shutil.copy2(CONFIG_FILE, backup)
    CONFIG_FILE.write_text(deploy_lib.dumps_master(migrated))
    os.chmod(CONFIG_FILE, 0o600)
    print(f"migrated {CONFIG_FILE} -> config_version {deploy_lib.CURRENT_CONFIG_VERSION}. original backed up: {backup}")
    if dropped:
        print("\nNOTE: admin_password was removed — it is CLI-only now. This does NOT change any\n"
              "existing admin. On a FRESH DB, seed the admin with:\n"
              "  ./deploy.py start test --data-mode reset --admin-password '…'   (or ./deploy.py prod --admin-password '…')")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    # admin_password is CLI-only (never in the config file); --admin-password SEEDS the admin
    # on a fresh/empty DB and is a no-op on an existing one (restore/keep). Shared by prod/dev/start.
    admin_help = ("seed the 'admin' user's password on a FRESH/empty DB (never overwrites an "
                  "existing admin; omit when restoring — the backup carries the admin). Not stored.")

    # `prod` — build + compose up.
    pp = sub.add_parser("prod", help="build + run prod containers (compose)")
    pp.add_argument("--with-backup", action="store_true", help="also run the backup sidecars")
    pp.add_argument("--admin-password", default=None, help=admin_help)
    pp.add_argument("--branch", default=None,
                    help="git ref to build the image from (via a throwaway worktree), instead of "
                         "the current checkout — e.g. deploy a feature branch without merging it.")

    # `dev` — in-process, no container.
    pd = sub.add_parser("dev", help="in-process dev server (no container)")
    pd.add_argument("--admin-password", default=None, help=admin_help)

    # `start test` — kept as its own subcommand (throwaway container).
    ps = sub.add_parser("start", help="throwaway test container (test only; prod is now `./deploy.py prod`)")
    ps.add_argument("target", choices=["test"])
    ps.add_argument("--port", type=int, default=None,
                    help="test: host port (default: auto-assigned free port, so multiple test envs don't collide)")
    ps.add_argument("--data-mode", choices=["keep", "reset", "restore", "fixture"], default=None,
                    help="REQUIRED for test: keep (reuse test data as-is), reset (fresh empty "
                         "data), restore (populate from BACKUP_DIR), fixture (in-repo synthetic "
                         "dataset, disjoint from prod — for subagents). No default (wipe-guard).")
    ps.add_argument("--admin-password", default=None, help=admin_help)
    ps.add_argument("--branch", default=None,
                    help="git ref to build the image from (via a throwaway worktree).")

    st = sub.add_parser("stop"); st.add_argument("target", choices=["prod", "test"])
    sub.add_parser("restore", help="seed a fresh prod host from an existing backup")
    sub.add_parser("create-config", help="interactively write app.config.toml (versioned, sectioned)")
    sub.add_parser("migrate-config", help="upgrade a legacy/flat app.config.toml to the current schema")

    a = ap.parse_args()
    if a.cmd == "create-config":
        create_config()
        return
    if a.cmd == "migrate-config":
        migrate_config()
        return
    master = load_master()
    if a.cmd == "prod":
        start_prod(master, a.with_backup, a.branch, a.admin_password)
    elif a.cmd == "dev":
        rc = start_dev(master, a.admin_password)
        raise SystemExit(rc or 0)
    elif a.cmd == "start":
        start_test(master, a.port, a.data_mode, a.branch, a.admin_password)
    elif a.cmd == "stop":
        stop(master, a.target)
    elif a.cmd == "restore":
        restore(master)


if __name__ == "__main__":
    main()
