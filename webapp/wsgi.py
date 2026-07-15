"""Launcher + prod entry point.

All three serve paths — dev (`webapp.app:main` → `uv run leaf-annotation`), gate
(`webapp.app:run_ephemeral`, driven by scripts/gate.py), and prod (`python -m webapp.wsgi`,
the Dockerfile CMD) — go through `launch_granian(cfg)` below. That's the ONE serving path:
Granian-ASGI serving webapp.asgi:app (the composite Flask+WS app), one worker, one SQLite
writer.

The AppConfig handoff to the worker process is the launch ledger: `launch_granian` writes a
`starting` record (JSONL) at `<data_dir>/launch-log.jsonl`, sets HT_LAUNCH_LOG to that path
in the child env (the ONE launcher-set env var — worker imports find the ledger via it),
then spawns granian. `webapp/asgi.py`'s import reads the LATEST starting record and
reconstitutes AppConfig — no ambient env sniffing, no in-memory handoff (granian re-imports
the target in a forked worker).

CRITICAL — sandbox-reaper workaround: the harness/host sandbox reaps forked children of the
current session with SIGSTKFLT (exit 144). Granian internally forks a worker; if granian
were a same-session child, its worker would get reaped. `start_new_session=True` puts
granian in its own process group and session so the reaper never sees it; teardown is
`os.killpg(getpgid(pid), SIGTERM)` from our SIGTERM/SIGINT handler.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

from .config import AppConfig, default_data_dir
from .config_file import load_file_config
from .seed import resolve_port, seed_data

_ROOT = Path(__file__).resolve().parent.parent

# The single env var the launcher hands to the granian worker (launcher-set, not
# operator-sniffed — the operator passes the ledger via config/flags, not this var).
LAUNCH_LOG_ENV = 'HT_LAUNCH_LOG'


# ── Ledger serialization ──────────────────────────────────────────────────────

def _serialize_cfg(cfg: AppConfig) -> dict:
    return {
        'data_dir':             str(cfg.data_dir),
        'host':                 cfg.host,
        'port':                 cfg.port,
        'port_policy':          cfg.port_policy,
        'db_seed':              cfg.db_seed,
        'restore_source':       str(cfg.restore_source) if cfg.restore_source else None,
        'backup':               cfg.backup,
        'secret_key':           cfg.secret_key,
        'admin_password':       cfg.admin_password,
        'admin_password_force': cfg.admin_password_force,
        'backup_dir':           cfg.backup_dir,
        'backup_status_url':    cfg.backup_status_url,
    }


def _deserialize_cfg(d: dict) -> AppConfig:
    return AppConfig(
        data_dir=Path(d['data_dir']),
        host=d.get('host', '127.0.0.1'),
        port=int(d.get('port', 5000)),
        port_policy=d.get('port_policy', 'strict'),
        db_seed=d.get('db_seed', 'existing'),
        restore_source=Path(d['restore_source']) if d.get('restore_source') else None,
        backup=bool(d.get('backup', False)),
        secret_key=d.get('secret_key'),
        admin_password=d.get('admin_password'),
        admin_password_force=bool(d.get('admin_password_force', False)),
        backup_dir=d.get('backup_dir'),
        backup_status_url=d.get('backup_status_url'),
    )


def _append_record(path: Path, record: dict) -> None:
    """Append-only: never rewrite a line. One JSON record per line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as fh:
        fh.write(json.dumps(record) + '\n')


def write_launch_ledger(cfg: AppConfig) -> tuple[Path, str]:
    """Append a `starting` record; return (ledger_path, launch_id).

    The ledger lives on LOCAL disk (cfg.data_dir — same NFS-safety invariant as the SQLite
    DB). Concurrent gate runs each get their own per-run temp data_dir, so their ledgers
    can't collide.
    """
    ledger_path = cfg.data_dir / 'launch-log.jsonl'
    launch_id = uuid4().hex
    _append_record(ledger_path, {
        'ts':     time.time(),
        'id':     launch_id,
        'config': _serialize_cfg(cfg),
        'status': 'starting',
    })
    return ledger_path, launch_id


def cfg_from_ledger(ledger_path: Path) -> tuple[AppConfig, str]:
    """Return (cfg, launch_id) from the LATEST `starting` record. Called from the granian
    worker (webapp/asgi.py) at import time to reconstitute AppConfig."""
    latest = None
    with ledger_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get('status') == 'starting':
                latest = rec
    if latest is None:
        raise RuntimeError(f'no `starting` record in launch ledger {ledger_path}')
    return _deserialize_cfg(latest['config']), latest['id']


def mark_ready(launch_id: str) -> None:
    """Append a `ready` outcome record. Called by the worker on successful boot."""
    env_path = os.environ.get(LAUNCH_LOG_ENV)
    if not env_path:
        return
    _append_record(Path(env_path), {'ts': time.time(), 'id': launch_id, 'event': 'ready'})


def mark_failed(launch_id: str, err: str) -> None:
    """Append a `failed` outcome record. Called by the worker on boot failure."""
    env_path = os.environ.get(LAUNCH_LOG_ENV)
    if not env_path:
        return
    _append_record(Path(env_path), {'ts': time.time(), 'id': launch_id, 'event': 'failed', 'err': err})


# ── The one launcher path ─────────────────────────────────────────────────────

def launch_granian(cfg: AppConfig, wait: bool = True) -> int:
    """seed data → write ledger → spawn granian-asgi in a new session → wait.

    Returns the granian exit code (0 if wait=False and spawn succeeded).

    Invoked as `sys.executable -m granian ...` so the worker inherits the SAME Python
    interpreter/venv as the launcher: without this, PATH resolution picks up whatever
    `granian` binary happens to be first and spawns a foreign python that can't see our
    venv-installed deps (this is exactly how the granian-worker asgiref ImportError
    surfaced during Phase 0 bring-up).
    """
    seed_data(cfg)
    port = resolve_port(cfg)
    ledger_path, _launch_id = write_launch_ledger(cfg)
    cmd = [
        sys.executable, '-m', 'granian',
        '--interface', 'asgi',
        '--host', cfg.host,
        '--port', str(port),
        '--workers', '1',
        '--ws',
        'webapp.asgi:app',
    ]
    env = {**os.environ, LAUNCH_LOG_ENV: str(ledger_path)}
    proc = subprocess.Popen(cmd, env=env, start_new_session=True)

    def _handle_signal(_signum, _frame):
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    signal.signal(signal.SIGINT,  _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    try:
        return proc.wait() if wait else 0
    finally:
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                proc.wait(timeout=5)
            except (ProcessLookupError, PermissionError):
                pass
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass


# ── Prod entry point (Dockerfile CMD: `python -m webapp.wsgi`) ────────────────

def _prod_cfg_from_env() -> AppConfig:
    """Prod AppConfig builder. deploy.py injects the container env from app.config.toml /
    .env via compose; for a bare-metal `python -m webapp.wsgi` run from the repo root we
    also fall back to app.config.toml (or a legacy .env) read from that root, so the one
    config file works for this entrypoint too. This is a legitimate env boundary — the
    permanent test_no_env_reads guard allowlists this file for exactly that reason.
    """
    file_cfg = load_file_config(_ROOT)

    def pick(env_name: str) -> str | None:
        return os.environ.get(env_name) or file_cfg.get(env_name)

    data_dir = pick('HT_DATA_DIR')
    port     = pick('PORT')
    return AppConfig(
        data_dir=Path(data_dir) if data_dir else default_data_dir(),
        host='0.0.0.0',
        port=int(port) if port else 5000,
        port_policy='strict',
        db_seed='existing',
        backup=True,
        secret_key=pick('SECRET_KEY'),
        admin_password=pick('ADMIN_PASSWORD'),
        backup_dir=pick('BACKUP_DIR'),
        backup_status_url=pick('BACKUP_STATUS_URL'),
    )


def main() -> int:
    """`python -m webapp.wsgi` — the prod launcher. Same launch_granian pipeline dev/gate
    use, just with an env-sourced AppConfig instead of CLI flags."""
    return launch_granian(_prod_cfg_from_env())


if __name__ == '__main__':
    raise SystemExit(main())
