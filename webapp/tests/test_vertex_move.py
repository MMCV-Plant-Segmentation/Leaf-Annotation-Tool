"""Vertex snapping — PHASE 3a (BACKEND): move a shared vertex → all referencing masks follow (t50).

Christian, 2026-07-20: "snapping should result in the vertices being locked together so that moving
one moves the other." Phases 1/2a/2b made a snap create a SHARED vertex (one `vertex` row referenced by
several strokes). This phase delivers the payoff: moving that shared vertex's canonical position
re-fuses EVERY annotation whose stroke references it — so both marks move together, transitively.

The `vertex` row is the single source of truth for position; a stroke's mask is computed from its
points (which read through to the vertex). So a move must (a) update the vertex row and (b) recompute
every referencing annotation's fused mask (the same recompute a stroke edit runs).

Contract (a new member-gated route, e.g. PATCH /api/projects/<pid>/vertices/<vertexId> {x,y}):
  V1. The vertex row's canonical position updates.
  V2. EVERY annotation referencing that vertex re-fuses: its mask now covers the NEW position and no
      longer the OLD — for ALL sharers (move one → move all), across different labels.
  V3. The response returns the affected annotations (so the FE can patch every moved mask at once).
  V4. A vertex referenced by only ONE stroke moves just that mask; unrelated marks are untouched.

RED until the vertex-move route + propagation land. Standalone-script style; the subagent implements
against it and does NOT edit it.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-vmove-test-')
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


def j(r):
    return r.get_json()


def _leaf_png(w=360, h=320) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


pid = j(client.post('/api/projects', json={'name': 'VMove', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make(points, refs=None, label='v', sw=14, tool='polyline'):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
            'label': label, 'strokeWidth': sw, 'tool': tool,
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if refs is not None:
        body['vertexRefs'] = refs
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)


def stroke_out(annotation_id):
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    a = next(x for x in live if x['id'] == annotation_id)
    return a['strokes'][0]


def masks(label):
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    return [_Poly(a['rings'][0]) for a in live
            if a['label'] == label and a.get('rings') and a['rings'][0]]


def vertex_xy(vertex_id):
    con = db.get_db()
    try:
        row = con.execute('SELECT x, y FROM vertex WHERE id = ?', (vertex_id,)).fetchone()
        return (row['x'], row['y']) if row else None
    finally:
        db.close_db(con)


def move_vertex(vertex_id, x, y):
    return client.patch(f'/api/projects/{pid}/vertices/{vertex_id}', json={'x': x, 'y': y})


# ── set-up: A ('la') and B ('lb') snap-share their first vertex; C ('lc') is unrelated ──
aA = make([[cx - 40, cy, 14.0], [cx, cy - 20, 14.0]], label='la')
vShared, vA1 = stroke_out(aA['id'])['vertexIds']
aB = make([[cx - 40, cy, 14.0], [cx - 40, cy + 60, 14.0]], refs=[vShared, None], label='lb')
assert stroke_out(aB['id'])['vertexIds'][0] == vShared, 'setup: B must share A\'s first vertex'
aC = make([[cx + 70, cy + 70, 14.0], [cx + 100, cy + 70, 14.0]], label='lc')  # far away, unshared

old_x, old_y = cx - 40, cy
new_x, new_y = cx + 40, cy + 90

# ── V1 + V2 + V3: moving the shared vertex moves BOTH masks (different labels) ─────────
r = move_vertex(vShared, new_x, new_y)
assert r.status_code == 200, f'vertex move should 200, got {r.status_code}: {j(r)}'
assert vertex_xy(vShared) == (new_x, new_y), f'V1: vertex row must update, got {vertex_xy(vShared)}'
returned = {a['id'] for a in (j(r).get('annotations') or [])}
assert returned, 'V3: the response must return the affected (re-fused) annotations'

for lab in ('la', 'lb'):
    ms = masks(lab)
    assert ms, f'V2: {lab} must still have a mask after the move'
    assert any(m.buffer(1).contains(_Point(new_x, new_y)) for m in ms), \
        f'V2: {lab} mask must cover the NEW shared-vertex position (move one → move all)'
    assert not any(m.contains(_Point(old_x, old_y)) for m in ms), \
        f'V2: {lab} mask must no longer cover the OLD position'
print('V1/V2/V3 OK — moving a shared vertex re-fuses every referencing mask (transitive lock)')

# ── V4: moving a NON-shared vertex touches only its own mask; unrelated C is untouched ──
cbefore = masks('lc')
r = move_vertex(vA1, cx + 10, cy - 60)
assert r.status_code == 200, f'move should 200, got {r.status_code}: {j(r)}'
assert any(m.buffer(1).contains(_Point(cx + 10, cy - 60)) for m in masks('la')), \
    'V4: A\'s mask follows its own (non-shared) vertex'
assert [m.bounds for m in masks('lc')] == [m.bounds for m in cbefore], \
    'V4: an unrelated mark (C) must be untouched by moving another mark\'s vertex'
print('V4 OK — a non-shared vertex moves only its own mask; unrelated marks untouched')

print('\nALL VERTEX-MOVE (phase 3a) CHECKS PASSED')
