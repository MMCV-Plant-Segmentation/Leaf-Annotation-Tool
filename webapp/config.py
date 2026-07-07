"""AppConfig — one resolved config object threaded through create_app(), db.configure(),
and seed_data(), instead of each launcher hand-rolling env setup before import.

Built once per process (by webapp/app.py:main(), webapp/wsgi.py, or scripts/gate.py) and
passed explicitly from there on — nothing downstream re-reads environment variables.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

PortPolicy = Literal['strict', 'auto']
DbSeed     = Literal['existing', 'clean', 'restore']


def default_data_dir() -> Path:
    """Default data location: a LOCAL XDG dir.

    The SQLite DB must NOT live on a network filesystem (NFS/SMB/FUSE): POSIX
    advisory file locking there is unreliable, so concurrent requests stall ~30s
    contending for locks (see docs/). Keep the live store on local disk and back
    it up to network/cloud storage out-of-band (litestream/lsyncd).
    """
    xdg = os.environ.get('XDG_DATA_HOME')
    root = Path(xdg) if xdg else Path.home() / '.local' / 'share'
    return root / 'leaf-annotation'


@dataclass
class AppConfig:
    """Orthogonal knobs, sensible defaults. See docs/plans/Plan — Entrypoint +
    environment consolidation.md for the rationale.

    data_dir        Where app.db + images/jsons/i18n live. Must stay on local disk.
    host / port     Bind address for the dev/gate Flask server (Granian owns its own
                    socket in prod; still recorded here for uniformity / logging).
    port_policy     'strict' = bind exact-or-exit (prod). 'auto' = fall back to a free
                    port via bind(:0) if the requested one is taken (dev/gate).
    db_seed         'existing' = never touch (prod). 'clean' = ensure an empty data_dir
                    (gate/ephemeral). 'restore' = populate data_dir from the host backup.
    restore_source  Path to the Litestream replica dir (db_seed='restore'); the sibling
                    image/json backup is resolved relative to it unless overridden.
    backup          Asserted invariant only — prod refuses to run silently without it.
                    Backup itself (Litestream/lsyncd) is a compose sidecar, not this code.
    secret_key      Flask session secret. Required by create_app().
    admin_password  Seeds the 'admin' user on first boot if set (no admin exists yet).
                    Does NOT overwrite an existing admin's password — see
                    admin_password_force.
    admin_password_force
                    When True, admin_password force-updates an already-existing admin's
                    password instead of only seeding on first boot. Set by an explicit
                    `--admin-password` CLI flag (operator intent), never by the env-sourced
                    ADMIN_PASSWORD default.
    backup_dir      Host backup root. deploy.py uses it for real — the litestream/lsyncd
                    sidecars (start prod --with-backup) and --data-mode restore both read it
                    (as BACKUP_DIR); the webapp only DISPLAYS it in the admin settings panel
                    (read-only there). None/'' means "not configured" for this instance.
    backup_status_url
                    URL of the `backup-status` sidecar polled by GET /api/sync-status.
                    None means "use sync_status.py's compose-network default".
    """
    data_dir: Path = field(default_factory=default_data_dir)
    host: str = '127.0.0.1'
    port: int = 5000
    port_policy: PortPolicy = 'strict'
    db_seed: DbSeed = 'existing'
    restore_source: Path | None = None
    backup: bool = False
    secret_key: str | None = None
    admin_password: str | None = None
    admin_password_force: bool = False
    backup_dir: str | None = None
    backup_status_url: str | None = None
