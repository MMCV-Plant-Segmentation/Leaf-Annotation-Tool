"""
Thin SQLite helper for app.db.

- WAL mode for concurrent reads.
- Connection-per-request via get_db() / close_db().
- Row factory returns plain dicts.
- auto_create_schema() is called once on startup — builds/upgrades the schema via
  Alembic (see alembic/versions/0001_baseline.py and docs/plans/Plan — Adopt Alembic
  (baseline + forward migrations).md).
- migrate_manifest() imports manifest.json rows into annotation_set idempotently.
"""

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import AppConfig, default_data_dir

BASE    = Path(__file__).parent.parent

# The Alembic revision ID for `alembic/versions/0001_baseline.py` — the squash of every
# migrate_*() below into one clean starting point (see docs/plans/Plan — Adopt Alembic
# (baseline + forward migrations).md). Used by auto_create_schema() to stamp an existing
# (pre-Alembic) DB onto this revision without re-running its DDL, and is the single
# source of truth webapp/version.py reads back as `schemaVersion` — no separate constant.
BASELINE_REVISION = '0001_baseline'

# ── Config (module singleton — one process, one config; see webapp/config.py) ────────────

_cfg: AppConfig | None = None


def configure(cfg: AppConfig) -> None:
    """Set the active config. Call once, before any get_db()/auto_create_schema()."""
    global _cfg
    _cfg = cfg


def _env_default_config() -> AppConfig:
    """Fallback used only if configure() was never called — reproduces the pre-refactor
    behavior (HT_DATA_DIR env override, else the NFS-safe XDG default) so any caller that
    still imports webapp.db without going through create_app() keeps working unchanged.
    """
    data_dir = Path(os.environ['HT_DATA_DIR']) if os.environ.get('HT_DATA_DIR') else default_data_dir()
    return AppConfig(data_dir=data_dir)


def get_config() -> AppConfig:
    """The active config — resolved lazily (NOT at import time), defaulting to
    _env_default_config() if configure() was never called."""
    global _cfg
    if _cfg is None:
        _cfg = _env_default_config()
    return _cfg


def _db_path() -> Path:
    return get_config().data_dir / 'app.db'


# ── Row factory ───────────────────────────────────────────────────────────────

def _dict_factory(cursor, row):
    return {col[0]: value for col, value in zip(cursor.description, row)}


# ── Connection management ─────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    """Open a new connection for the current request.

    journal_mode=WAL is a *persistent* database property — it is set once in
    auto_create_schema(), NOT per connection. Re-asserting it on every connection
    takes a database lock and needlessly serializes concurrent requests.
    """
    con = sqlite3.connect(str(_db_path()))
    con.row_factory = _dict_factory
    con.execute('PRAGMA foreign_keys=ON')
    # Wait up to 5s for a write lock instead of failing immediately. WAL means reads never
    # block, but two writers still serialize; without this an abandoned/slow import would
    # flood concurrent writers with "database is locked" instead of letting them queue.
    con.execute('PRAGMA busy_timeout=5000')
    return con


def close_db(con: sqlite3.Connection) -> None:
    con.close()


# ── Schema ────────────────────────────────────────────────────────────────────
# The DDL that used to live here now lives ONLY in alembic/versions/0001_baseline.py
# (the hand-written baseline revision) — see auto_create_schema() below. It ran a
# `CREATE TABLE IF NOT EXISTS` executescript() + a hand-ordered migrate_*() list; both
# are superseded by Alembic upgrade/stamp.


def _alembic_config():
    """Build an Alembic Config pointed at this repo's alembic/ dir. The DB URL itself is
    NOT set here — alembic/env.py resolves it from the active AppConfig (db.get_config()),
    same as every other module in this file."""
    from alembic.config import Config as AlembicConfig  # deferred: only needed at boot

    cfg = AlembicConfig(str(BASE / 'alembic.ini'))
    cfg.set_main_option('script_location', str(BASE / 'alembic'))
    return cfg


def auto_create_schema() -> None:
    """Create/upgrade the schema via Alembic. Safe to call on every startup.

    - Fresh DB (no tables at all) -> `alembic upgrade head` builds the baseline (+ any
      later revisions) from nothing.
    - Pre-Alembic DB (tables already exist — today's prod/dev shape — but no
      `alembic_version`) -> `alembic stamp <baseline>` records "already here" WITHOUT
      re-running any DDL (data-preserving), then `upgrade head` picks up anything AFTER
      the baseline.
    - Already-versioned DB -> `upgrade head` is a no-op unless new revisions landed.

    A failed upgrade/stamp raises (not caught here) — this must never serve a
    half-migrated DB. The old hand-rolled migrate_*() call list this replaced is now
    baked into alembic/versions/0001_baseline.py; the function bodies stay below only as
    that revision's source-of-truth (and for the standalone tests that still exercise
    them directly) — they are no longer part of the startup path.
    """
    from alembic import command

    _db_path().parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(_db_path()))
    try:
        tables = {
            r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
    finally:
        con.close()

    alembic_cfg = _alembic_config()
    if tables and 'alembic_version' not in tables:
        command.stamp(alembic_cfg, BASELINE_REVISION)
    command.upgrade(alembic_cfg, 'head')

    con = get_db()
    try:
        con.execute('PRAGMA journal_mode=WAL')  # persistent; set once here, not per-connection
        con.commit()
    finally:
        close_db(con)


# ── Migrations ────────────────────────────────────────────────────────────────
#
# Schema migrations now live in alembic/ (auto_create_schema() runs them on boot).
# The old hand-rolled incremental migrate_* functions (add_user_fk, project_*,
# annotation_stroke_width/outline, …) were folded into 0001_baseline and deleted.
# What remains here is NOT schema DDL: meta bookkeeping + data import.

def migrate_meta() -> None:
    """Create the `meta` key/value table (if needed) and record app_version.

    Runs on every startup (called from app.py's _startup(), after auto_create_schema());
    the upsert is idempotent so repeated calls just refresh app_version to whatever build
    is currently running. schema_version is NOT written here anymore — the Alembic
    revision (alembic_version.version_num) is the single source of truth for schema
    identity now; see webapp/version.py's get_version() and db.BASELINE_REVISION.
    """
    from .version import app_version  # local import: version.py has no dependency on db.py

    con = get_db()
    try:
        con.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
        con.execute(
            'INSERT INTO meta (key, value) VALUES (?, ?) '
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ('app_version', app_version()),
        )
        con.commit()
    finally:
        close_db(con)


def migrate_manifest(manifest_path: Path) -> int:
    """
    Import annotation_set rows from manifest.json.

    Each manifest entry maps to:
      kind='raw', created_by='legacy', created_at = uploaded_at

    Idempotent: rows already present (by id) are skipped.
    Returns the number of rows actually inserted.
    """
    if not manifest_path.exists():
        return 0

    try:
        entries = json.loads(manifest_path.read_text())
    except Exception as exc:
        print(f'[db.migrate_manifest] could not read manifest: {exc}')
        return 0

    con = get_db()
    inserted = 0
    try:
        for entry in entries:
            row_id       = entry.get('id')
            display_name = entry.get('display_name', '')
            image_hash   = entry.get('image_hash', '')
            image_ext    = entry.get('image_ext', '')
            uploaded_at  = entry.get('uploaded_at') or datetime.now(timezone.utc).isoformat()

            if not row_id or not image_hash:
                continue

            existing = con.execute(
                'SELECT id FROM annotation_set WHERE id = ?', (row_id,)
            ).fetchone()
            if existing:
                continue

            con.execute(
                '''INSERT INTO annotation_set
                     (id, display_name, image_hash, image_ext,
                      kind, provenance, created_by, created_at, terminal)
                   VALUES (?, ?, ?, ?, 'raw', NULL, 'legacy', ?, 0)''',
                (row_id, display_name, image_hash, image_ext, uploaded_at),
            )
            inserted += 1

        con.commit()
    finally:
        close_db(con)

    if inserted:
        print(f'[db.migrate_manifest] imported {inserted} row(s) into annotation_set')
    else:
        print('[db.migrate_manifest] all rows already present, nothing to import')
    return inserted
