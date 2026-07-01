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

def migrate_add_user_fk() -> None:
    """Add created_by_user_id FK column to annotation_set if it doesn't exist yet."""
    con = get_db()
    try:
        cols = {r['name'] for r in con.execute('PRAGMA table_info(annotation_set)').fetchall()}
        if 'created_by_user_id' not in cols:
            con.execute(
                'ALTER TABLE annotation_set ADD COLUMN'
                ' created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'
            )
            con.commit()
    finally:
        close_db(con)


def migrate_project_annotator_user_fk() -> None:
    """Destructive migration: rebuild project_annotator with user_id FK.

    Foundation data is throwaway — if user_id column is missing the table is
    dropped and recreated with the new schema.  Any existing roster rows are lost.
    """
    con = get_db()
    try:
        cols = {r['name'] for r in con.execute('PRAGMA table_info(project_annotator)').fetchall()}
        if 'user_id' not in cols:
            con.executescript('''
                DROP TABLE IF EXISTS project_annotator;
                CREATE TABLE project_annotator (
                  id         TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
                  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  byline     TEXT NOT NULL,
                  UNIQUE (project_id, user_id)
                );
            ''')
            con.commit()
    finally:
        close_db(con)


def migrate_project_image_source_path() -> None:
    """Add source_path column to project_image for full-path provenance."""
    con = get_db()
    try:
        cols = {r['name'] for r in con.execute('PRAGMA table_info(project_image)').fetchall()}
        if 'source_path' not in cols:
            con.execute('ALTER TABLE project_image ADD COLUMN source_path TEXT')
            con.commit()
    finally:
        close_db(con)


def migrate_project_tiling_confirmed() -> None:
    """Add tiling_confirmed flag to project.

    Auto-confirms projects that already have images (so existing projects with
    batches remain accessible without requiring the user to re-confirm).
    """
    con = get_db()
    try:
        cols = {r['name'] for r in con.execute('PRAGMA table_info(project)').fetchall()}
        if 'tiling_confirmed' not in cols:
            con.execute(
                'ALTER TABLE project ADD COLUMN tiling_confirmed INTEGER NOT NULL DEFAULT 0'
            )
            # Auto-confirm projects that already have ≥1 image.
            con.execute(
                'UPDATE project SET tiling_confirmed = 1 '
                'WHERE id IN (SELECT DISTINCT project_id FROM project_image)'
            )
            con.commit()
    finally:
        close_db(con)


def migrate_backfill_project_creator_annotator() -> None:
    """Backfill: add the creator to project_annotator for projects that pre-date auto-add.

    For each project with created_by_user_id NOT NULL and no existing project_annotator
    row for that user, insert one (byline = users.username).  Idempotent — skips rows
    that already exist via INSERT OR IGNORE.  Admin is excluded: admin sees every project
    via the membership bypass, so the roster stays real-annotators-only.
    """
    con = get_db()
    try:
        rows = con.execute(
            '''SELECT p.id project_id, p.created_by_user_id, u.username
               FROM project p
               JOIN users u ON u.id = p.created_by_user_id
               WHERE p.created_by_user_id IS NOT NULL
                 AND u.username != 'admin'
                 AND NOT EXISTS (
                   SELECT 1 FROM project_annotator pa
                   WHERE pa.project_id = p.id AND pa.user_id = p.created_by_user_id
                 )'''
        ).fetchall()
        import uuid as _uuid
        for r in rows:
            con.execute(
                'INSERT OR IGNORE INTO project_annotator (id, project_id, user_id, byline)'
                ' VALUES (?, ?, ?, ?)',
                (str(_uuid.uuid4()), r['project_id'], r['created_by_user_id'], r['username']),
            )
        if rows:
            con.commit()
    finally:
        close_db(con)


def migrate_annotation_stroke_width() -> None:
    """Add nullable stroke_width REAL column to annotation table (Phase 1 brush rework)."""
    con = get_db()
    try:
        cols = {r['name'] for r in con.execute('PRAGMA table_info(annotation)').fetchall()}
        if 'stroke_width' not in cols:
            con.execute('ALTER TABLE annotation ADD COLUMN stroke_width REAL')
            con.commit()
    finally:
        close_db(con)


def migrate_annotation_outline() -> None:
    """Add nullable outline_json TEXT column to annotation table (perfect-freehand outline geometry)."""
    con = get_db()
    try:
        cols = {r['name'] for r in con.execute('PRAGMA table_info(annotation)').fetchall()}
        if 'outline_json' not in cols:
            con.execute('ALTER TABLE annotation ADD COLUMN outline_json TEXT')
            con.commit()
    finally:
        close_db(con)


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
