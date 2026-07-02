#!/usr/bin/env python3
"""deploy.py — one tool to run the Leaf Annotation stack: prod, or a throwaway test copy.

Runs the stack as YOU + a shared group (APP_GROUP in .env), so data + backups are group-owned,
never root — no UID typed or hardcoded, and no sudo needed (works even on a host you don't own,
as long as you're in APP_GROUP). Auto-computes the build version. Stdlib only, no dependencies.

  ./deploy.py create-dot-env            # interactively write a .env (generates SECRET_KEY for you)
  ./deploy.py start prod                # build (auto-version) + run prod as you+group
  ./deploy.py start prod --with-backup  # + the litestream/lsyncd backup sidecars
  ./deploy.py start test [--port N]     # run the real image against a THROWAWAY copy of prod's data
  ./deploy.py stop prod | test
  ./deploy.py restore                   # seed a fresh/wiped prod host FROM an existing backup
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


def prod_names(env):
    proj = env.get("COMPOSE_PROJECT_NAME", "leaf-annotation-tool")
    return f"{proj}-app-1", f"{proj}_leaf-data"


def bake(env):
    # -f docker-bake.hcl only: bake otherwise also loads compose.yaml and demands BACKUP_DIR
    # (from the backup services) even to build just `app`.
    sh(["docker", "buildx", "bake", "-f", "docker-bake.hcl", "app"], cwd=str(ROOT), env=base_env(env))


def start_prod(env, with_backup):
    bake(env)
    up = ["docker", "compose"] + (["--profile", "backup"] if with_backup else []) + ["up", "-d"]
    sh(up, cwd=str(ROOT), env=prod_env(env))
    print(f"prod up (version {git_sha() or 'dev'}). backup: {'on' if with_backup else 'off'}.")


def start_test(env, port):
    prod_ct, prod_vol = prod_names(env)
    if subprocess.run(["docker", "inspect", prod_ct], capture_output=True).returncode != 0:
        die(f"prod container {prod_ct} isn't running — test copies its data from the live volume.")
    puid, pgid = str(os.getuid()), str(os.getgid())  # personal identity — test data isn't shared
    bake(env)  # test the CURRENT code, same image prod would get
    print("snapshotting prod DB + copying its volume into a throwaway test volume…")
    sh(["docker", "exec", prod_ct, "python3", "-c",
        "import sqlite3\n"
        "s=sqlite3.connect('/data/app.db'); d=sqlite3.connect('/data/.snap.db')\n"
        "s.backup(d); d.close(); s.close()"])
    subprocess.run(["docker", "rm", "-f", TEST_CT], capture_output=True)
    subprocess.run(["docker", "volume", "rm", TEST_VOL], capture_output=True)
    sh(["docker", "volume", "create", TEST_VOL])
    sh(["docker", "run", "--rm", "-v", f"{prod_vol}:/src:ro", "-v", f"{TEST_VOL}:/dst", "alpine",
        "sh", "-c",
        "cp -a /src/. /dst/ && mv -f /dst/.snap.db /dst/app.db && "
        "rm -rf /dst/.app.db-litestream /dst/app.db-* /dst/app.db.bak-* 2>/dev/null; "
        f"chown -R {puid}:{pgid} /dst"])
    subprocess.run(["docker", "exec", prod_ct, "rm", "-f", "/data/.snap.db"])
    sh(["docker", "run", "-d", "--rm", "--name", TEST_CT,
        "-p", f"{port}:{port}", "-e", f"PORT={port}",
        "-e", f"SECRET_KEY=testenv-{secrets.token_hex(8)}",
        "--user", f"{puid}:{pgid}", "-v", f"{TEST_VOL}:/data", IMAGE])
    print(f"test up on http://localhost:{port}  (throwaway copy — prod untouched).")
    print(f"  logs: docker logs -f {TEST_CT}   |   stop: ./deploy.py stop test")


def stop(env, target):
    if target == "prod":
        sh(["docker", "compose", "down"], cwd=str(ROOT), env=base_env(env))
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
    st = sub.add_parser("stop"); st.add_argument("target", choices=["prod", "test"])
    sub.add_parser("restore", help="seed a fresh prod host from an existing backup")
    sub.add_parser("create-dot-env", help="interactively write a .env")
    a = ap.parse_args()
    env = load_env()
    if a.cmd == "create-dot-env":
        create_dot_env()
    elif a.cmd == "start":
        (start_prod(env, a.with_backup) if a.target == "prod" else start_test(env, a.port))
    elif a.cmd == "stop":
        stop(env, a.target)
    elif a.cmd == "restore":
        restore(env)


if __name__ == "__main__":
    main()
