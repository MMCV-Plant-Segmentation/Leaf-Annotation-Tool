"""Polyline v1b — EDIT a stroke's vertices, RECOMPUTE the mask (the computed-from-strokes payoff).

Today geometry is computed at CREATE and frozen (reads/erase never recompute; a fused mask can't
be edited — `create_annotation` 422s "a fused mask cannot be edited directly"). v1b adds the one new
capability the unified model unlocks: **move a polyline stroke's vertices → recompute the owning
annotation from its member strokes**, which — because fusion is connected-components — naturally
SPLITS a mask (strokes disconnect) or MERGES with a neighbor (the moved stroke now overlaps it).

Proposed contract (refine as needed — this is the starting spec):
  PATCH /api/projects/<pid>/strokes/<stroke_id>   body { points, strokeWidth, outline? }
  → recomputes the affected annotation(s); returns 200. Edits are stroke-level (a polyline's
    clicked vertices), distinct from the label-only annotation PATCH.

E1. Moving a lone polyline's vertices moves its mask (the mask covers the NEW vertices, not the old).
E2. Two fused polylines: moving one far away SPLITS the mask into two separate annotations.

RED until the stroke-edit endpoint + recompute land.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-polyedit-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from shapely.geometry import Point as _Point, Polygon as _Poly
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


def jdump(r):
    return r.get_json()


def _leaf_png(w=260, h=220) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


r = client.post('/api/projects', json={'name': 'PolyEdit', 'tile_size_px': 128})
pid = jdump(r)['id']
r = client.post(f'/api/projects/{pid}/images/upload',
                data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
                content_type='multipart/form-data')
r.get_data()
image_id = jdump(client.get(f'/api/projects/{pid}'))['images'][0]['id']
r = client.post(f'/api/projects/{pid}/batches', json={'size': 16})
batch_id = jdump(r)['id']
t0 = jdump(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make(points, label, sw=12):
    r2 = client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
        'label': label, 'strokeWidth': sw, 'tool': 'polyline',
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}})
    assert r2.status_code == 201, f'create failed: {jdump(r2)}'
    return jdump(r2)


def stroke_id_of(annotation_id):
    con = db.get_db()
    try:
        return con.execute('SELECT id FROM stroke WHERE annotation_id = ?',
                           (annotation_id,)).fetchone()['id']
    finally:
        db.close_db(con)


def edit_stroke(sid, points, sw=12):
    return client.patch(f'/api/projects/{pid}/strokes/{sid}',
                        json={'points': points, 'strokeWidth': sw})


def anns(label):
    live = jdump(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    return [a for a in live if a['label'] == label]


def mask(a):
    return _Poly(a['rings'][0]) if a.get('rings') and a['rings'][0] else None


# ── E1: moving a lone polyline's vertices moves its mask ─────────────────────────────
a1 = make([[cx - 20, cy], [cx, cy]], label='e1')
sid1 = stroke_id_of(a1['id'])
new_pts = [[cx + 5, cy + 30], [cx + 25, cy + 30]]
r = edit_stroke(sid1, new_pts)
assert r.status_code == 200, f'stroke edit should return 200, got {r.status_code}: {jdump(r)}'
m = mask(anns('e1')[0])
assert m is not None and m.contains(_Point(cx + 15, cy + 30)), 'mask must cover the NEW vertices'
assert not m.contains(_Point(cx - 20, cy)), 'mask must no longer cover the OLD position'
print('E1 OK — editing a polyline vertex recomputes its mask')

# ── E2: separating two fused polylines SPLITS the annotation ─────────────────────────
make([[cx - 60, cy - 40], [cx - 40, cy - 40]], label='e2')      # S1
make([[cx - 45, cy - 40], [cx - 25, cy - 40]], label='e2')      # S2 overlaps S1 → fuse
fused = anns('e2')
assert len(fused) == 1, f'the two overlapping polylines should fuse into one, got {len(fused)}'
s1 = stroke_id_of(fused[0]['id'])  # NB: after fusion both strokes hang off the one annotation
# move S1 far away so it no longer touches S2 → the mask must split into two annotations
r = edit_stroke(s1, [[cx + 70, cy + 60], [cx + 90, cy + 60]])
assert r.status_code == 200, f'edit should 200, got {r.status_code}: {jdump(r)}'
after = anns('e2')
assert len(after) == 2, f'separating the fused strokes must SPLIT into two annotations, got {len(after)}'
print('E2 OK — separating fused polyline strokes splits the mask')

print('\npolyline-edit (v1b) contract tests passed.')
