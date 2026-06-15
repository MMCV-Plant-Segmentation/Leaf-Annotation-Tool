"""
Thin SQLite helper for app.db.

- WAL mode for concurrent reads.
- Connection-per-request via get_db() / close_db().
- Row factory returns plain dicts.
- auto_create_schema() is called once on startup.
- migrate_manifest() imports manifest.json rows into annotation_set idempotently.
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BASE    = Path(__file__).parent.parent
DB_PATH = BASE / 'data' / 'app.db'

# ── Row factory ───────────────────────────────────────────────────────────────

def _dict_factory(cursor, row):
    return {col[0]: value for col, value in zip(cursor.description, row)}


# ── Connection management ─────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    """Open a new connection for the current request."""
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = _dict_factory
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA foreign_keys=ON')
    return con


def close_db(con: sqlite3.Connection) -> None:
    con.close()


# ── Schema ────────────────────────────────────────────────────────────────────

_DDL = """
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
"""


def auto_create_schema() -> None:
    """Create all tables if they don't exist. Safe to call on every startup."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = get_db()
    try:
        con.executescript(_DDL)
        con.commit()
    finally:
        close_db(con)


# ── Migration ─────────────────────────────────────────────────────────────────

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
