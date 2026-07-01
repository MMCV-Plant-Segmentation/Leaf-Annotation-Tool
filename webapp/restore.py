"""restore_from_backup(cfg) — populate cfg.data_dir from the HOST backup (db_seed='restore').

NUANCE (verified against ops/litestream.yml + compose.yaml's `restore` service before
writing this): the continuous backup is a **Litestream file replica** (a `generations/`
tree), not a plain `app.db`. So DB restore shells out to the `litestream` CLI —
`litestream restore -o <data_dir>/app.db file://<replica_dir>` — it is NOT a file copy.
Images/jsons/manifest/i18n are NOT inside the Litestream replica; they come from a
separate host file-backup tree (the lsyncd mirror), copied wholesale — mirroring what
compose.yaml's `restore` service does natively for Docker (`litestream restore` + a
plain recursive copy of the file mirror).

If litestream isn't on PATH, the replica dir doesn't exist, or the backup isn't readable
by this process's user, this fails LOUDLY with a RuntimeError — it never silently falls
back to some other (wrong) source.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .config import AppConfig

# Standard host backup location (see docs/plans/Task — Entrypoint + environment
# consolidation (build).md and compose.yaml's BACKUP_DIR-mounted `restore` service).
DEFAULT_BACKUP_ROOT = Path('/deltos/e/leaf-annotation-tool/backup')
DEFAULT_DB_REPLICA  = DEFAULT_BACKUP_ROOT / 'db'      # litestream file-replica root (generations/…)
DEFAULT_FILES_DIR   = DEFAULT_BACKUP_ROOT / 'files'   # images/ jsons/ manifest.json i18n/ (lsyncd mirror)


def restore_from_backup(cfg: AppConfig) -> None:
    replica_dir = cfg.restore_source or DEFAULT_DB_REPLICA
    # files_dir is always the sibling 'files' dir next to whichever 'db' replica dir is in
    # play — that's the host backup layout (backup/db, backup/files) and matches
    # compose.yaml (BACKUP_DIR/db, BACKUP_DIR/files).
    files_dir = replica_dir.parent / 'files'

    if shutil.which('litestream') is None:
        raise RuntimeError(
            "restore: 'litestream' binary not found on PATH — cannot restore the DB from "
            f"the Litestream replica at {replica_dir}. Install litestream (or run this on a "
            "host that has it); refusing to silently fall back to some other DB source."
        )
    if not replica_dir.is_dir():
        raise RuntimeError(f'restore: Litestream replica dir not found: {replica_dir}')

    # Fresh restore target: wipe any stale content first (mirrors --seed clean's semantics).
    if cfg.data_dir.exists():
        shutil.rmtree(cfg.data_dir)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    db_path = cfg.data_dir / 'app.db'

    proc = subprocess.run(
        ['litestream', 'restore', '-o', str(db_path), f'file://{replica_dir}'],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'restore: `litestream restore` failed (exit {proc.returncode}) reading '
            f'{replica_dir} — the backup contents are often root-owned on the host and may '
            f'not be readable by this user. Refusing to fall back to a different DB source.\n'
            f'stderr:\n{proc.stderr.strip()}'
        )
    # litestream leaves `app.db.tmp-shm`/`app.db.tmp-wal` sidecars from applying WAL against
    # its temp path (only the final db file itself gets renamed) — harmless (SQLite looks for
    # `app.db-wal`/`app.db-shm`, not `.tmp-*`) but stray; clean them up.
    for stray in cfg.data_dir.glob('app.db.tmp-*'):
        stray.unlink(missing_ok=True)

    if not files_dir.is_dir():
        print(f'[restore] WARNING: no file backup at {files_dir} — DB restored, '
              f'but images/jsons/manifest.json were NOT (nothing to copy from).')
        return

    try:
        for entry in files_dir.iterdir():
            dst = cfg.data_dir / entry.name
            if entry.is_dir():
                shutil.copytree(entry, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(entry, dst)
    except PermissionError as exc:
        raise RuntimeError(
            f'restore: DB restored OK, but the file backup at {files_dir} is not readable '
            f'by this user ({exc}). images/jsons/manifest.json were NOT restored.'
        ) from exc
