"""Annotation bbox spatial index (t68-i1) — BACKEND.

Christian, 2026-07-21. A persisted per-annotation bbox (min_x/min_y/max_x/max_y) + composite
index replaces the O(n) geometry scans in the create-fuse candidate lookup and the eraser with a
bbox-pruned candidate lookup + exact shapely test. Tile-size-independent. This pins:
  - bbox columns are MAINTAINED on create + on re-fuse (edit) + on the generic points PATCH;
  - `_annotations_overlapping` returns EXACTLY the brute-force scan's set (parity), while touching
    fewer candidates (the prune works);
  - end-to-end fuse/erase behaviour is unchanged (a distant mark neither fuses nor erases).

Standalone-script style (mirrors test_polyline_splice.py).
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-bbox-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod
from webapp.projects import _annotations_overlapping, _annotation_geom, _UNSET

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


def _leaf_png(w=640, h=480) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


pid = j(client.post('/api/projects', json={'name': 'Bbox', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 64}))['id']
tiles = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles']
assert len(tiles) >= 7, f'need several tiles, got {len(tiles)}'


def centre(t):
    return t['x'] + t['w'] // 2, t['y'] + t['h'] // 2


def dot(cx, cy, sw=10, label='v'):
    """Create a small stroke mask centred at (cx,cy). Returns the create response."""
    t = tiles[0]
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
            'points': [[cx, cy, sw]], 'label': label, 'strokeWidth': sw, 'tool': 'brush',
            'viewport': {'x': t['x'], 'y': t['y'], 'w': t['w'], 'h': t['h']}}
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)


def bbox_of(aid):
    con = db.get_db()
    try:
        r = con.execute('SELECT min_x, min_y, max_x, max_y FROM annotation WHERE id = ?',
                        (aid,)).fetchone()
        return (r['min_x'], r['min_y'], r['max_x'], r['max_y'])
    finally:
        db.close_db(con)


def brute(geom, annotator=None, kind='stroke', label=_UNSET):
    """Reference: exact shapely scan over EVERY live annotation on the image."""
    con = db.get_db()
    try:
        rows = con.execute('SELECT * FROM annotation WHERE project_image_id = ? '
                           'AND deleted_at IS NULL', (image_id,)).fetchall()
        out = []
        for r in rows:
            if annotator is not None and r['annotator'] != annotator:
                continue
            if kind is not None and r['kind'] != kind:
                continue
            if label is not _UNSET and r['label'] != label:
                continue
            g = _annotation_geom(r)
            if g is not None and not g.is_empty and g.intersects(geom):
                out.append(r['id'])
        return sorted(out)
    finally:
        db.close_db(con)


# ── bbox is set on create, and matches the stored geometry's bounds ───────────────────────
a0 = dot(*centre(tiles[0]))
b = bbox_of(a0['id'])
assert None not in b, f'bbox must be populated on create, got {b}'
con = db.get_db()
try:
    g0 = _annotation_geom(con.execute('SELECT * FROM annotation WHERE id = ?', (a0['id'],)).fetchone())
finally:
    db.close_db(con)
assert abs(b[0] - g0.bounds[0]) < 1e-6 and abs(b[2] - g0.bounds[2]) < 1e-6, (b, g0.bounds)
print('B1 OK — bbox populated on create + matches geometry bounds')

# ── a spread of marks across distinct tiles; parity of index vs brute force ────────────────
made = [a0['id']]
for tl in tiles[1:5]:
    made.append(dot(*centre(tl))['id'])

con = db.get_db()
try:
    # query around the FIRST tile's mark — should hit only near marks, never all
    q = _annotation_geom(con.execute('SELECT * FROM annotation WHERE id = ?', (a0['id'],)).fetchone())
    q = q.buffer(30)
    idx = sorted(r['id'] for r, _g in _annotations_overlapping(con, image_id, q, annotator='alice'))
finally:
    db.close_db(con)
assert idx == brute(q, annotator='alice'), f'index != brute: {idx} vs {brute(q, annotator="alice")}'
assert a0['id'] in idx and len(idx) < len(made), f'prune should exclude far marks: {idx} of {made}'
print(f'B2 OK — index==brute parity; pruned to {len(idx)} of {len(made)} marks')

# ── create-fuse: a stroke overlapping a0 CONSUMES it; a far stroke does not ────────────────
cx0, cy0 = centre(tiles[0])
overlap = dot(cx0 + 3, cy0 + 3)   # right on top of a0 → should fuse (consume a0)
assert a0['id'] in overlap['consumedAnnotationIds'], \
    f'overlapping create must consume a0: {overlap["consumedAnnotationIds"]}'
far = dot(*centre(tiles[6]))
assert far['consumedAnnotationIds'] == [], f'far create must not consume: {far["consumedAnnotationIds"]}'
print('B3 OK — create-fuse consumes only the overlapping mask (via the index)')

# ── eraser: erasing over a far tile deletes only that mark ─────────────────────────────────
cxF, cyF = centre(tiles[6])
er = client.post(f'/api/projects/{pid}/annotations/erase-stroke', json={
    'imageId': image_id, 'annotator': 'alice', 'points': [[cxF, cyF, 12]], 'strokeWidth': 12})
assert er.status_code == 200, j(er)
deleted = j(er)['deletedAnnotationIds']
assert far['createdStrokeId'] and deleted, 'eraser should delete the far mark'
# nothing near tile[0] should be in the erase set
assert overlap['id'] not in deleted, f'eraser must not delete the distant tile[0] mask: {deleted}'
print('B4 OK — eraser deletes only the overlapped mark (via the index)')

# ── bbox refreshed after an edit (re-fuse mints a fresh annotation with its own bbox) ──────
sidF = None
con = db.get_db()
try:
    # find a live stroke to edit (the overlapping fused mask around tile0)
    row = con.execute("SELECT s.id sid FROM stroke s JOIN annotation a ON a.id=s.annotation_id "
                      "WHERE a.project_image_id=? AND a.deleted_at IS NULL LIMIT 1", (image_id,)).fetchone()
    sidF = row['sid']
finally:
    db.close_db(con)
re = client.patch(f'/api/projects/{pid}/strokes/{sidF}',
                  json={'points': [[cx0, cy0, 40]], 'strokeWidth': 40})
assert re.status_code == 200, j(re)
# the recomputed mask(s) must all carry a bbox
con = db.get_db()
try:
    live = con.execute('SELECT id, min_x FROM annotation WHERE project_image_id=? '
                       'AND deleted_at IS NULL', (image_id,)).fetchall()
    assert live and all(r['min_x'] is not None for r in live), 'every live mask must have a bbox after edit'
finally:
    db.close_db(con)
print('B5 OK — bbox maintained across an edit re-fuse')

print('\nALL ANNOTATION-BBOX-INDEX (t68-i1) CHECKS PASSED')
