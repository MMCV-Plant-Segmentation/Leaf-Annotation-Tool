"""seed_data(cfg) — populate cfg.data_dir per cfg.db_seed, BEFORE create_app(cfg) runs
(create_app/_startup build schema + migrations on top of whatever's on disk).

resolve_port(cfg) — bind-port policy shared by the same callers (main(), and later the
gate's ephemeral launcher): 'strict' takes cfg.port as-is (Werkzeug/Granian raise if it's
taken); 'auto' grabs a free port via bind(:0) if the requested one is unavailable.
"""
from __future__ import annotations

import shutil
import socket

from .config import AppConfig


def seed_data(cfg: AppConfig) -> None:
    if cfg.db_seed == 'existing':
        return
    if cfg.db_seed == 'clean':
        _seed_clean(cfg)
    elif cfg.db_seed == 'restore':
        from .restore import restore_from_backup  # deferred: pulls in subprocess/litestream plumbing
        restore_from_backup(cfg)
    else:
        raise ValueError(f'unknown db_seed: {cfg.db_seed!r}')


def _seed_clean(cfg: AppConfig) -> None:
    """Ensure data_dir exists and is empty. auto_create_schema() (called from
    create_app→_startup) builds a fresh DB + schema on top of it."""
    if cfg.data_dir.exists():
        shutil.rmtree(cfg.data_dir)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
            return True
        except OSError:
            return False


def free_port(host: str = '') -> int:
    """Grab a free TCP port by binding to :0 and reading it back."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def resolve_port(cfg: AppConfig) -> int:
    """Port to actually bind, per cfg.port_policy.

    'strict' (prod / anything that must fail loudly on conflict): return cfg.port as-is;
    the server call itself raises OSError if it's taken.
    'auto' (dev/gate/ephemeral): return cfg.port if free, else a free port via bind(:0).
    """
    if cfg.port_policy == 'strict':
        return cfg.port
    if _port_free(cfg.host, cfg.port):
        return cfg.port
    return free_port(cfg.host)
