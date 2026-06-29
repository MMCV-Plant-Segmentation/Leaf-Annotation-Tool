"""
Thin SQLite helper for app.db.

- WAL mode for concurrent reads.
- Connection-per-request via get_db() / close_db().
- Row factory returns plain dicts.
- auto_create_schema() is called once on startup.
- migrate_manifest() imports manifest.json rows into annotation_set idempotently.
"""

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BASE    = Path(__file__).parent.parent


def _default_data_dir() -> Path:
    """Default data location: a LOCAL XDG dir.

    The SQLite DB must NOT live on a network filesystem (NFS/SMB/FUSE): POSIX
    advisory file locking there is unreliable, so concurrent requests stall ~30s
    contending for locks (see docs/). Keep the live store on local disk and back
    it up to network/cloud storage out-of-band (litestream/lsyncd).
    """
    xdg = os.environ.get('XDG_DATA_HOME')
    root = Path(xdg) if xdg else Path.home() / '.local' / 'share'
    return root / 'leaf-annotation'


DATA_DIR = Path(os.environ['HT_DATA_DIR']) if os.environ.get('HT_DATA_DIR') else _default_data_dir()
DB_PATH  = DATA_DIR / 'app.db'

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
    con = sqlite3.connect(str(DB_PATH))
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

_DDL = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  created_at REAL NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires REAL NOT NULL,
  created_at REAL NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT, updated_at REAL NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS annotation_set (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  image_hash   TEXT NOT NULL,
  image_ext    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('raw','merged','reannotated')),
  provenance   TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  terminal     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_annotation_set_image_hash
  ON annotation_set (image_hash);

CREATE TABLE IF NOT EXISTS merge (
  id          TEXT PRIMARY KEY,
  set_id      TEXT REFERENCES annotation_set(id),
  image_hash  TEXT NOT NULL,
  doc         TEXT NOT NULL,
  created_by  TEXT,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_set_id
  ON merge (set_id);

CREATE TABLE IF NOT EXISTS reannot_session (
  id            TEXT PRIMARY KEY,
  merge_id      TEXT NOT NULL REFERENCES merge(id),
  image_hash    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','complete')),
  planned_order TEXT NOT NULL,
  active_pile   TEXT,
  result_set_id TEXT REFERENCES annotation_set(id),
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_reannot_session_merge_id
  ON reannot_session (merge_id);

CREATE TABLE IF NOT EXISTS reannot_pile (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES reannot_session(id),
  source_pile_id TEXT,
  order_index    INTEGER NOT NULL,
  bbox           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','done')),
  resolved_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reannot_pile_session_id
  ON reannot_pile (session_id);

CREATE TABLE IF NOT EXISTS reannot_generation (
  id         TEXT PRIMARY KEY,
  pile_id    TEXT NOT NULL REFERENCES reannot_pile(id),
  gen_index  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reannot_generation_pile_id
  ON reannot_generation (pile_id);

CREATE TABLE IF NOT EXISTS reannot_polygon (
  id            TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES reannot_generation(id),
  participant   TEXT NOT NULL,
  points        TEXT NOT NULL,
  bbox          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reannot_polygon_generation_id
  ON reannot_polygon (generation_id);

-- ── Annotator pipeline (projects → tiles → batches) ──────────────────────────
-- See docs/Annotator Plan.md. `annotation.kind` is intentionally FREE TEXT (no CHECK)
-- so new primitives (stroke, point, …) are added without a migration.

CREATE TABLE IF NOT EXISTS project (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  tile_size_px     INTEGER NOT NULL DEFAULT 128,
  black_threshold  INTEGER NOT NULL DEFAULT 0,       -- Minimum Luminance Threshold (MLT)
  classes_json     TEXT NOT NULL DEFAULT '[]',      -- v1: flat per-project class list
  tiling_confirmed INTEGER NOT NULL DEFAULT 0,      -- 1 once user saves tiling settings
  created_by       TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_annotator (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  byline     TEXT NOT NULL,   -- cached username; used for annotation attribution
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_image (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  image_hash  TEXT NOT NULL,
  image_ext   TEXT NOT NULL,
  source_name TEXT,           -- legacy filename (kept for display)
  source_path TEXT,           -- full server path at import time (provenance)
  width       INTEGER,
  height      INTEGER,
  origin_y    INTEGER NOT NULL DEFAULT 0,
  leaf_x INTEGER, leaf_y INTEGER, leaf_w INTEGER, leaf_h INTEGER,
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, image_hash)
);

CREATE INDEX IF NOT EXISTS idx_project_image_project ON project_image (project_id);

-- Full tile bbox is stored at batch-creation time (NOT derived) so historical tiles keep
-- their coordinates even if project params change later.
CREATE TABLE IF NOT EXISTS tile (
  id               TEXT PRIMARY KEY,
  project_image_id TEXT NOT NULL REFERENCES project_image(id) ON DELETE CASCADE,
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
  UNIQUE (project_image_id, x, y)
);

CREATE TABLE IF NOT EXISTS batch (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,                       -- 1-based ordinal within the project
  size       INTEGER NOT NULL DEFAULT 5,
  status     TEXT NOT NULL DEFAULT 'annotation_in_progress',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batch_project ON batch (project_id);

-- Tile GEOMETRY is shared across annotators in a batch (so their results are comparable).
CREATE TABLE IF NOT EXISTS batch_tile (
  id       TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  tile_id  TEXT NOT NULL REFERENCES tile(id) ON DELETE CASCADE,
  UNIQUE (batch_id, tile_id)
);

CREATE INDEX IF NOT EXISTS idx_batch_tile_batch ON batch_tile (batch_id);

-- Per-annotator PRIVATE progress row (holds no shapes). Annotators are blind until merge.
CREATE TABLE IF NOT EXISTS annotator_tile (
  id            TEXT PRIMARY KEY,
  batch_tile_id TEXT NOT NULL REFERENCES batch_tile(id) ON DELETE CASCADE,
  annotator     TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'assigned',    -- assigned | completed | dirty
  updated_at    TEXT,
  UNIQUE (batch_tile_id, annotator)
);

CREATE INDEX IF NOT EXISTS idx_annotator_tile_bt ON annotator_tile (batch_tile_id);

-- One drawn shape per row (so soft-delete is per-shape). labelme JSON is a derived export.
CREATE TABLE IF NOT EXISTS annotation (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  project_image_id TEXT REFERENCES project_image(id) ON DELETE CASCADE,  -- coord space of points
  annotator     TEXT NOT NULL,
  kind          TEXT NOT NULL,                        -- polygon | line | point | stroke | …
  pass_no       INTEGER,                              -- 1 rough-area pass, 2 precise-polygon pass
  points_json   TEXT NOT NULL,
  label         TEXT,
  viewport_json TEXT,
  hsv_hist_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT                                  -- soft delete only
);

CREATE INDEX IF NOT EXISTS idx_annotation_project ON annotation (project_id, annotator);

-- Materialized "which tiles each annotation intersects" — drives shapes-in-tile + dirty-propagation.
CREATE TABLE IF NOT EXISTS annotation_tile (
  annotation_id TEXT NOT NULL REFERENCES annotation(id) ON DELETE CASCADE,
  tile_id       TEXT NOT NULL REFERENCES tile(id) ON DELETE CASCADE,
  PRIMARY KEY (annotation_id, tile_id)
);
"""


def auto_create_schema() -> None:
    """Create all tables if they don't exist. Safe to call on every startup."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = get_db()
    try:
        con.execute('PRAGMA journal_mode=WAL')  # persistent; set once here, not per-connection
        con.executescript(_DDL)
        con.commit()
    finally:
        close_db(con)
    # Additive / destructive migrations (idempotent; order matters).
    migrate_add_user_fk()
    migrate_project_annotator_user_fk()
    migrate_project_image_source_path()
    migrate_project_tiling_confirmed()
    migrate_backfill_project_creator_annotator()


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
    that already exist via INSERT OR IGNORE.
    """
    con = get_db()
    try:
        rows = con.execute(
            '''SELECT p.id project_id, p.created_by_user_id, u.username
               FROM project p
               JOIN users u ON u.id = p.created_by_user_id
               WHERE p.created_by_user_id IS NOT NULL
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
