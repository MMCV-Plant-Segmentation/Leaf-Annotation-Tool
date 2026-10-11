"""t78 regression (Christian, 2026-07-20/21 demo): dragging a just-snapped SHARED vertex
moves the handle but the fused MASK keeps its OLD perimeter.

Root cause: a stroke stores an `outline` polygon (the FE's perfect-freehand / polyline
outline), and the fused-scope recompute PREFERS that outline over the stroke's points
(`_stroke_polygon`). `do_move_vertex` synced `points_json` to the moved vertex but left
`outline_json` describing the OLD shape, so the re-fusion rebuilt the OLD mask.

`test_vertex_move` never caught this because its `make()` stores NO outline (so the
recompute always fell back to points). This test sends a real outline — the exact FE
condition — and asserts the fused mask FOLLOWS the moved shared vertex.

Standalone-script style. Run: uv run python webapp/tests/test_vertex_move_outline.py
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-vmove-outline-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from shapely.geometry import Point as _Point, Polygon as _Poly, LineString as _Line
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
    s['user_id'] = 2
    s['username'] = 'alice'


def j(r):
    return r.get_json()


def _leaf_png(w=360, h=320) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


pid = j(client.post('/api/projects', json={'name': 'VMoveOutline', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def _outline(points, sw):
    """A real outline polygon, exactly as the FE ships one (buffer of the centerline). Its
    PRESENCE is what triggers t78 — the recompute prefers it over the moved points."""
    pts = [(p[0], p[1]) for p in points]
    g = _Point(pts[0]).buffer(sw / 2) if len(pts) == 1 else _Line(pts).buffer(sw / 2)
    return [[round(x, 2), round(y, 2)] for x, y in g.exterior.coords]


def make(points, refs=None, label='thing', sw=14.0):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
            'label': label, 'strokeWidth': sw, 'tool': 'polyline', 'outline': _outline(points, sw),
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if refs is not None:
        body['vertexRefs'] = refs
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)


def live():
    return j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']


def stroke_out(aid):
    return next(x for x in live() if x['id'] == aid)['strokes'][0]


def masks(label='thing'):
    return [_Poly(a['rings'][0]) for a in live()
            if a['label'] == label and a.get('rings') and a['rings'][0]]


# ── A and B share the elbow vertex; SAME label 'thing' → they fuse into ONE mask. ─────
aA = make([[cx - 40, cy, 14.0], [cx, cy, 14.0]], label='thing')
_vA0, vElbow = stroke_out(aA['id'])['vertexIds']
make([[cx, cy, 14.0], [cx, cy + 40, 14.0]], refs=[vElbow, None], label='thing')

old_x, old_y = cx, cy
new_x, new_y = cx + 45, cy + 45

assert masks(), 'setup: a fused mask must exist'
assert any(m.buffer(1).contains(_Point(old_x, old_y)) for m in masks()), \
    'setup: the fused mask covers the elbow before the move'

r = client.patch(f'/api/projects/{pid}/vertices/{vElbow}', json={'x': new_x, 'y': new_y})
assert r.status_code == 200, f'move should 200, got {r.status_code}: {j(r)}'

# The fused mask must FOLLOW the moved shared vertex — not stay pinned by a stale outline.
ms = masks()
assert ms, 'the fused mask must still exist after the move'
assert any(m.buffer(1).contains(_Point(new_x, new_y)) for m in ms), \
    't78: the fused mask must cover the NEW shared-vertex position (outline was rebuilt)'
assert not any(m.contains(_Point(old_x, old_y)) for m in ms), \
    't78: the fused mask must no longer be pinned at the OLD elbow (stale outline dropped)'

# The returned payload the FE splices in must ALSO carry the moved geometry (the FE trusts
# it directly — it does not re-GET), so its rings must cover the new position too.
returned = [_Poly(a['rings'][0]) for a in (j(r).get('annotations') or [])
            if a.get('rings') and a['rings'][0]]
assert returned, 'the response must return the re-fused mask'
assert any(m.buffer(1).contains(_Point(new_x, new_y)) for m in returned), \
    't78: the returned (spliced-in) mask must already cover the NEW position'

print('PASS t78 — a shared-vertex move rebuilds the stale outline; the fused mask follows')
print('ALL PASS test_vertex_move_outline')
