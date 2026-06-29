"""
Seed script: create a deterministic, lab-free fixture data directory for e2e tests.

Usage: python3 seed.py <output_dir>

Creates:
  <output_dir>/app.db           — SQLite registry with annotation sets + admin user
  <output_dir>/images/          — tiny synthetic PNG for the legacy pipeline
  <output_dir>/jsons/           — labelme JSON files for each raw set
  <output_dir>/nested-images/   — synthetic leaf PNGs in subdirectories for the
                                  recursive-import browser test

IDs are stable (used by test specs in e2e/fixtures/ids.ts).
No real lab data, no colleague names.
"""
import json
import sqlite3
import struct
import sys
import zlib
from datetime import datetime, timezone
from pathlib import Path

# ── Stable IDs (must match e2e/fixtures/ids.ts) ───────────────────────────────
IMG_HASH   = 'aaaaaaaaaaaa'
IMG_EXT    = 'png'

SET_ALPHA  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'   # raw set 1
SET_BETA   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'   # raw set 2
SET_MERGED = 'cccccccc-cccc-cccc-cccc-cccccccccccc'   # merged set
MERGE_ID   = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()

# ── Synthetic 100×100 greyscale PNG (stdlib only, no Pillow) ──────────────────
def _make_png(width: int = 100, height: int = 100) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        length = struct.pack('>I', len(data))
        payload = tag + data
        crc = struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)
        return length + payload + crc

    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
    raw  = (b'\x00' + b'\x80' * width) * height  # filter=0, grey=128
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    return b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend


# ── Labelme JSON (v6.3.1) ─────────────────────────────────────────────────────
def _shape(label: str, points: list) -> dict:
    return {'label': label, 'points': points, 'group_id': None,
            'description': '', 'shape_type': 'polygon', 'flags': {}, 'mask': None}

def _labelme(shapes: list) -> dict:
    return {'version': '6.3.1', 'flags': {}, 'shapes': shapes,
            'imagePath': 'image.png', 'imageData': None,
            'imageHeight': 100, 'imageWidth': 100}


# ── Merge doc ─────────────────────────────────────────────────────────────────
# Two piles, each with one polygon from SET_ALPHA and one from SET_BETA.
# Pile 1: (10,10)→(30,30) vs (20,20)→(40,40) — partial overlap → k=1 and k=2 regions
# Pile 2: (60,60)→(90,90) vs (55,55)→(85,85) — larger overlap
ANNOTATIONS = [
    {'id': 'ann-a1', 'setId': SET_ALPHA, 'label': 'lesion',
     'points': [[10,10],[30,10],[30,30],[10,30]], 'bbox': [10,10,30,30]},
    {'id': 'ann-b1', 'setId': SET_BETA,  'label': 'lesion',
     'points': [[20,20],[40,20],[40,40],[20,40]], 'bbox': [20,20,40,40]},
    {'id': 'ann-a2', 'setId': SET_ALPHA, 'label': 'lesion',
     'points': [[60,60],[90,60],[90,90],[60,90]], 'bbox': [60,60,90,90]},
    {'id': 'ann-b2', 'setId': SET_BETA,  'label': 'lesion',
     'points': [[55,55],[85,55],[85,85],[55,85]], 'bbox': [55,55,85,85]},
]
MERGE_DOC = {
    'imageHash': IMG_HASH,
    'annotations': ANNOTATIONS,
    'piles': {
        'pile-1': {'annotationIds': ['ann-a1', 'ann-b1']},
        'pile-2': {'annotationIds': ['ann-a2', 'ann-b2']},
    },
}

ADMIN_PW = 'e2e-admin-pw'  # must match playwright.config.ts webServer env

# ── Schema (mirrors db.py; update if DDL changes) ────────────────────────────
DDL = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  password_hash TEXT, created_at REAL NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL, expires REAL NOT NULL,
  created_at REAL NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT, updated_at REAL NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS annotation_set (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, image_hash TEXT NOT NULL,
  image_ext TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('raw','merged','reannotated')),
  provenance TEXT, created_by TEXT, created_at TEXT NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0, created_by_user_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS merge (
  id TEXT PRIMARY KEY, set_id TEXT REFERENCES annotation_set(id),
  image_hash TEXT NOT NULL, doc TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reannot_session (
  id TEXT PRIMARY KEY, merge_id TEXT, image_hash TEXT,
  status TEXT DEFAULT 'active', planned_order TEXT, active_pile TEXT,
  result_set_id TEXT, created_by TEXT, created_at TEXT, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS reannot_pile (
  id TEXT PRIMARY KEY, session_id TEXT, source_pile_id TEXT,
  order_index INTEGER, bbox TEXT, status TEXT DEFAULT 'pending', resolved_count INTEGER
);
CREATE TABLE IF NOT EXISTS reannot_generation (
  id TEXT PRIMARY KEY, pile_id TEXT, gen_index INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS reannot_polygon (
  id TEXT PRIMARY KEY, generation_id TEXT, participant TEXT, points TEXT, bbox TEXT
);

-- ── Annotator pipeline (mirrors webapp/db.py; update if DDL changes) ──────────
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  tile_size_px INTEGER NOT NULL DEFAULT 128,
  black_threshold INTEGER NOT NULL DEFAULT 0,
  classes_json TEXT NOT NULL DEFAULT '[]',
  tiling_confirmed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_annotator (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  byline TEXT NOT NULL, UNIQUE (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS project_image (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  image_hash TEXT NOT NULL, image_ext TEXT NOT NULL,
  source_name TEXT, source_path TEXT, width INTEGER, height INTEGER,
  origin_y INTEGER NOT NULL DEFAULT 0,
  leaf_x INTEGER, leaf_y INTEGER, leaf_w INTEGER, leaf_h INTEGER,
  created_at TEXT NOT NULL, UNIQUE (project_id, image_hash)
);
CREATE TABLE IF NOT EXISTS tile (
  id TEXT PRIMARY KEY,
  project_image_id TEXT NOT NULL REFERENCES project_image(id) ON DELETE CASCADE,
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
  UNIQUE (project_image_id, x, y)
);
CREATE TABLE IF NOT EXISTS batch (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'annotation_in_progress', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_tile (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  tile_id TEXT NOT NULL REFERENCES tile(id) ON DELETE CASCADE,
  UNIQUE (batch_id, tile_id)
);
CREATE TABLE IF NOT EXISTS annotator_tile (
  id TEXT PRIMARY KEY,
  batch_tile_id TEXT NOT NULL REFERENCES batch_tile(id) ON DELETE CASCADE,
  annotator TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'assigned',
  updated_at TEXT, UNIQUE (batch_tile_id, annotator)
);
CREATE TABLE IF NOT EXISTS annotation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  project_image_id TEXT REFERENCES project_image(id) ON DELETE CASCADE,
  annotator TEXT NOT NULL, kind TEXT NOT NULL, pass_no INTEGER,
  points_json TEXT NOT NULL, label TEXT, viewport_json TEXT, hsv_hist_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS annotation_tile (
  annotation_id TEXT NOT NULL REFERENCES annotation(id) ON DELETE CASCADE,
  tile_id TEXT NOT NULL REFERENCES tile(id) ON DELETE CASCADE,
  PRIMARY KEY (annotation_id, tile_id)
);
"""


def _make_leaf_png_pillow(path: Path, w: int = 200, h: int = 180) -> None:
    """Write a synthetic leaf PNG using Pillow (available in the uv venv)."""
    import numpy as np
    from PIL import Image
    arr = np.zeros((h, w), np.uint8)
    arr[30:h - 30, 20:w - 20] = 210   # bright rectangle = leaf region
    Image.fromarray(arr, 'L').save(str(path))


def _seed_nested_images(out_dir: Path) -> None:
    """Create nested-images/ with three leaf PNGs in subdirectories.

    Used by the recursive-import browser test (path: <fixture>/nested-images).
    Images have different dimensions so they get different content hashes.
    """
    root = out_dir / 'nested-images'
    sub1 = root / 'sub1'
    sub2 = sub1 / 'sub2'
    sub2.mkdir(parents=True, exist_ok=True)
    _make_leaf_png_pillow(root / 'leaf0.png', w=200, h=180)
    _make_leaf_png_pillow(sub1 / 'leaf1.png', w=220, h=160)
    _make_leaf_png_pillow(sub2 / 'leaf2.png', w=240, h=200)
    # A non-image file that should be silently ignored
    (root / 'notes.txt').write_text('ignore me')


def _seed_flat_images(out_dir: Path) -> None:
    """Create flat-images/ with three leaf PNGs for the browser upload test.

    Used by the upload e2e test (setInputFiles). Different dimensions → different hashes.
    """
    root = out_dir / 'flat-images'
    root.mkdir(exist_ok=True)
    _make_leaf_png_pillow(root / 'upload0.png', w=202, h=182)
    _make_leaf_png_pillow(root / 'upload1.png', w=222, h=162)
    _make_leaf_png_pillow(root / 'upload2.png', w=242, h=202)


def seed(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'images').mkdir(exist_ok=True)
    (out_dir / 'jsons').mkdir(exist_ok=True)

    (out_dir / 'images' / f'{IMG_HASH}.{IMG_EXT}').write_bytes(_make_png())

    alpha_shapes = [_shape('lesion', [[10,10],[30,10],[30,30],[10,30]]),
                    _shape('lesion', [[60,60],[90,60],[90,90],[60,90]])]
    beta_shapes  = [_shape('lesion', [[20,20],[40,20],[40,40],[20,40]]),
                    _shape('lesion', [[55,55],[85,55],[85,85],[55,85]])]
    (out_dir / 'jsons' / f'{SET_ALPHA}.json').write_text(json.dumps(_labelme(alpha_shapes)))
    (out_dir / 'jsons' / f'{SET_BETA}.json').write_text(json.dumps(_labelme(beta_shapes)))

    # Synthetic leaf images for the recursive-import browser test
    _seed_nested_images(out_dir)
    # Flat leaf images for the browser-upload test (setInputFiles)
    _seed_flat_images(out_dir)

    from werkzeug.security import generate_password_hash
    admin_hash = generate_password_hash(ADMIN_PW)

    con = sqlite3.connect(str(out_dir / 'app.db'))
    con.executescript(DDL)
    # INSERT OR IGNORE: tolerate re-runs (webServer may have started before globalSetup
    # and created the schema via app._startup(); rows inserted here are visible per-request).
    # Upsert admin password so it always matches ADMIN_PW even on re-runs.
    con.execute(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)'
        ' ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash',
        ('admin', admin_hash),
    )
    con.executemany(
        'INSERT OR IGNORE INTO annotation_set (id,display_name,image_hash,image_ext,kind,provenance,created_by,created_at,terminal) VALUES (?,?,?,?,?,?,?,?,?)',
        [
            (SET_ALPHA,  'Alpha Set',  IMG_HASH, IMG_EXT, 'raw',    None, 'SeedBot', NOW, 0),
            (SET_BETA,   'Beta Set',   IMG_HASH, IMG_EXT, 'raw',    None, 'SeedBot', NOW, 0),
            (SET_MERGED, 'Merged Set', IMG_HASH, IMG_EXT, 'merged', None, 'SeedBot', NOW, 0),
        ],
    )
    con.execute(
        'INSERT OR IGNORE INTO merge VALUES (?,?,?,?,?,?)',
        (MERGE_ID, SET_MERGED, IMG_HASH, json.dumps(MERGE_DOC), 'SeedBot', NOW),
    )
    con.commit()
    con.close()
    print(f'[seed] fixture written to {out_dir}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: python3 seed.py <output_dir>', file=sys.stderr)
        sys.exit(1)
    seed(Path(sys.argv[1]))
