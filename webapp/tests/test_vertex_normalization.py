"""Vertex normalization — PHASE 1 of vertex snapping / shared-identity locking (t50).

Christian, 2026-07-20. Snapping must LOCK vertices together (move one → move all), transitively,
scoped across ANY annotation on an image. He chose FULL NORMALIZATION over a link table: a vertex
becomes a first-class shared entity ("a separate points table will pay off in the long run").

This phase adds the storage + backfill with ZERO behaviour change (no snapping yet — that's phase 2).
The model (see docs/plans/Task — Polyline vertex snapping (P-4 t50).md):

  Table `vertex(id, x, y)`  — a first-class geometric vertex; canonical position at full sub-pixel
      precision. Identity, NOT coordinate-dedup: two vertices at the same spot are DISTINCT rows
      until a snap makes one reference the other (phase 2).
  Table `stroke_vertex(stroke_id, seq, vertex_id, size)` — a stroke references an ORDERED list of
      vertices. `size` is that vertex's own brush diameter (t62 per-point width) and lives on the
      REFERENCE, not the shared vertex (two strokes may share a POSITION but keep independent sizes;
      only position is shared/locked). `size` NULL = a legacy 2-tuple point (falls back to strokeWidth).
  A shared/locked vertex = one `vertex.id` referenced by >= 2 `stroke_vertex` rows.

Contract for phase 1:
  N1. Creating a stroke populates vertex + stroke_vertex (ordered, exact coords, per-point sizes),
      one distinct vertex per point — NO sharing at creation.
  N2. The read payload round-trips the exact points (sub-pixel + per-vertex size preserved) — the
      regression guard that normalization is transparent.
  N3. The normalized tables are the SOURCE OF TRUTH: mutating a vertex row's position changes what
      reads return (points_json is no longer authoritative).
  N4. Editing a stroke's vertices writes THROUGH to the normalized tables.
  M1. The 0010 migration BACKFILLS every existing stroke's inline points_json into vertex +
      stroke_vertex, 1:1, no sharing, coords + per-point sizes preserved (existing data survives).

RED until phase 1 lands: there is no `vertex`/`stroke_vertex` table; points live only in
`stroke.points_json`. Standalone-script style (mirrors test_polyline_edit.py / test_compound_id.py).
The subagent implements against this; it does NOT edit this test.
"""
import io
import os
import tempfile
from pathlib import Path

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-vertexnorm-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True
client = app.test_client()
with client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'


def j(r):
    return r.get_json()


def _leaf_png(w=320, h=280) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


r = client.post('/api/projects', json={'name': 'VertexNorm', 'tile_size_px': 128})
pid = j(r)['id']
r = client.post(f'/api/projects/{pid}/images/upload',
                data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
                content_type='multipart/form-data')
r.get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make(points, label='v', sw=12, tool='polyline'):
    r2 = client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
        'label': label, 'strokeWidth': sw, 'tool': tool,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}})
    assert r2.status_code == 201, f'create failed: {j(r2)}'
    return j(r2)


def stroke_id_of(annotation_id):
    con = db.get_db()
    try:
        return con.execute('SELECT id FROM stroke WHERE annotation_id = ?',
                           (annotation_id,)).fetchone()['id']
    finally:
        db.close_db(con)


def stroke_vertices(sid):
    """Ordered [(seq, vertex_id, x, y, size), ...] for a stroke, from the normalized tables."""
    con = db.get_db()
    try:
        rows = con.execute(
            '''SELECT sv.seq AS seq, sv.vertex_id AS vertex_id, v.x AS x, v.y AS y, sv.size AS size
               FROM stroke_vertex sv JOIN vertex v ON v.id = sv.vertex_id
               WHERE sv.stroke_id = ? ORDER BY sv.seq''', (sid,)).fetchall()
        return [(row['seq'], row['vertex_id'], row['x'], row['y'], row['size']) for row in rows]
    finally:
        db.close_db(con)


def read_points(annotation_id):
    """The stroke's vertices as the read payload exposes them (what the FE draws handles from)."""
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    a = next(x for x in live if x['id'] == annotation_id)
    return a['strokes'][0]['points']


# ── N1: creating a stroke normalizes its vertices (ordered, exact, per-point size, no sharing) ──
pts1 = [[cx - 40 + 0.5, cy + 0.25, 10.0], [cx + 0.0, cy - 10.0, 14.0], [cx + 40.0, cy + 0.0, 18.0]]
a1 = make(pts1, label='n1')
sid1 = stroke_id_of(a1['id'])
sv1 = stroke_vertices(sid1)
assert [s[0] for s in sv1] == [0, 1, 2], f'stroke_vertex seq must be 0..n in order, got {sv1}'
assert [[s[2], s[3]] for s in sv1] == [[p[0], p[1]] for p in pts1], \
    f'vertex coords must match the drawn points exactly (sub-pixel), got {[(s[2], s[3]) for s in sv1]}'
assert [s[4] for s in sv1] == [10.0, 14.0, 18.0], f'per-point size must land on the reference, got {[s[4] for s in sv1]}'
assert len({s[1] for s in sv1}) == 3, 'the three points must be three DISTINCT vertex ids (no coord-dedup)'
_con = db.get_db()
_shared = _con.execute(
    'SELECT vertex_id, COUNT(*) c FROM stroke_vertex GROUP BY vertex_id HAVING c > 1').fetchall()
db.close_db(_con)
assert not _shared, f'no vertex may be shared at creation time (phase 1), got {[dict(x) for x in _shared]}'
print('N1 OK — create normalizes vertices: ordered, exact coords, per-point size, distinct, unshared')

# ── N2: the read payload round-trips the exact points (regression: normalization is transparent) ──
assert read_points(a1['id']) == pts1, f'read must round-trip the exact drawn points, got {read_points(a1["id"])}'
# a legacy-style 2-tuple stroke (no per-point size) must round-trip as 2-tuples too
pts2 = [[cx - 30, cy + 40], [cx + 30, cy + 40]]
a2 = make(pts2, label='n2')
assert read_points(a2['id']) == pts2, f'2-tuple points must round-trip unchanged, got {read_points(a2["id"])}'
print('N2 OK — points round-trip exactly (sub-pixel + per-point size + legacy 2-tuple)')

# ── N3: the normalized tables are the SOURCE OF TRUTH (points_json is no longer authoritative) ──
vid0 = sv1[0][1]
con = db.get_db()
con.execute('UPDATE vertex SET x = ?, y = ? WHERE id = ?', (999.0, 888.0, vid0))
con.commit()
db.close_db(con)
after = read_points(a1['id'])
assert after[0][0] == 999.0 and after[0][1] == 888.0, \
    f'moving the vertex row must change what reads return (reads come from the vertex table), got {after[0]}'
assert after[0][2] == 10.0, f"the point's own size must be unaffected by a position move, got {after[0]}"
print('N3 OK — vertex table is the source of truth (points_json demoted)')

# ── N4: editing a stroke writes THROUGH to the normalized tables ──────────────────────────
newpts = [[cx - 50.0, cy - 50.0, 20.0], [cx + 50.0, cy - 50.0, 24.0]]
re = client.patch(f'/api/projects/{pid}/strokes/{sid1}', json={'points': newpts, 'strokeWidth': 12})
assert re.status_code == 200, f'stroke edit should 200, got {re.status_code}: {j(re)}'
sv1b = stroke_vertices(sid1)
assert [[s[2], s[3], s[4]] for s in sv1b] == newpts, \
    f'editing must rewrite the normalized vertices, got {[(s[2], s[3], s[4]) for s in sv1b]}'
print('N4 OK — stroke edit writes through to vertex + stroke_vertex')

# ── M1: the 0010 migration backfills existing inline points_json → vertex + stroke_vertex ──
import sqlite3
from alembic import command
from alembic.config import Config as _AlembicConfig

REPO = Path(__file__).resolve().parents[2]
mdir = tempfile.mkdtemp(prefix='leaf-anno-vertexmig-test-')
os.environ['HT_DATA_DIR'] = mdir  # M1 runs LAST — after this the app client above must not be reused
_acfg = _AlembicConfig(str(REPO / 'alembic.ini'))
_acfg.set_main_option('script_location', str(REPO / 'alembic'))

# Build the schema as it stood BEFORE this feature (rev 0009), then plant a legacy stroke whose
# vertices live only in points_json — exactly what a pre-migration user DB looks like.
command.upgrade(_acfg, '0009_annotation_compound_id')
legacy_pts = [[11.5, 22.25, 8.0], [33.0, 44.0]]  # a 3-tuple + a legacy 2-tuple

raw = sqlite3.connect(str(db._db_path()))
raw.row_factory = sqlite3.Row
cols = raw.execute('PRAGMA table_info(stroke)').fetchall()
provided = {'id': 'leg-stroke-1', 'kind': 'polyline', 'points_json': __import__('json').dumps(legacy_pts),
            'created_at': '2026-01-01T00:00:00', 'stroke_width': 12.0, 'tool': 'polyline'}
names = {c['name'] for c in cols}
for c in cols:  # satisfy any other NOT NULL column generically, so this stays robust to schema drift
    if c['notnull'] and c['dflt_value'] is None and c['name'] not in provided:
        provided[c['name']] = 0 if 'INT' in (c['type'] or '').upper() or 'REAL' in (c['type'] or '').upper() else ''
use = {k: v for k, v in provided.items() if k in names}
raw.execute(f"INSERT INTO stroke ({','.join(use)}) VALUES ({','.join('?' for _ in use)})",
            tuple(use.values()))
raw.commit()
raw.close()

command.upgrade(_acfg, 'head')  # runs 0010 — must backfill the legacy stroke

chk = sqlite3.connect(str(db._db_path()))
chk.row_factory = sqlite3.Row
bf = chk.execute(
    '''SELECT sv.seq AS seq, v.x AS x, v.y AS y, sv.size AS size
       FROM stroke_vertex sv JOIN vertex v ON v.id = sv.vertex_id
       WHERE sv.stroke_id = ? ORDER BY sv.seq''', ('leg-stroke-1',)).fetchall()
shared = chk.execute(
    'SELECT vertex_id, COUNT(*) c FROM stroke_vertex GROUP BY vertex_id HAVING c > 1').fetchall()
chk.close()
assert [[b['x'], b['y']] for b in bf] == [[11.5, 22.25], [33.0, 44.0]], \
    f'migration must backfill vertex coords 1:1 (sub-pixel preserved), got {[(b["x"], b["y"]) for b in bf]}'
assert [b['size'] for b in bf] == [8.0, None], \
    f'backfill: per-point size preserved, legacy 2-tuple → NULL, got {[b["size"] for b in bf]}'
assert not shared, 'backfill must NOT share vertices (identity is created only by a snap, phase 2)'
print('M1 OK — 0010 migration backfills legacy points_json into vertex + stroke_vertex (1:1)')

print('\nALL VERTEX-NORMALIZATION (phase 1) CHECKS PASSED')
