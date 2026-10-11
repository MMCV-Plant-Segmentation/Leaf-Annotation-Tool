"""t103 Phase D — the wire `outline` is retired; the SERVER computes stroke geometry.

Phase C made *fusion* server-authoritative but the stroke CONTOUR still came from the
browser: the create/edit wire bodies carry an `outline` polygon (JS perfect-freehand for
brush, a JS buffer for polyline) and the server trusts it, only falling back to its own
engine when none is sent. Phase D makes the committed wasm engine the SINGLE source of
stroke geometry — the server derives the contour itself from points+size+tool and IGNORES
any `outline` on the wire.

These tests pin that contract (property-based, matching the codebase's script style):
  W1  a create carrying a GARBAGE outline is stored from its POINTS, not the outline.
  W2  a BRUSH stroke's stored mask matches the engine's BRUSH op (not the polyline fallback).
  W3  a POLYLINE with per-vertex sizes stores a VARIABLE-width mask with NO wire outline
      (t62 width must survive server-side, where today it survives only via the wire outline).
  W4  an EDIT carrying a garbage outline is stored from its new POINTS, not the outline.
  W5  FREEZE regression: a new stroke fused into an existing mask keeps the existing mask's
      stored geometry (fusion uses stored geometry, never a recompute-from-points).

Run: uv run python webapp/tests/test_wire_outline_retired.py
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-wire-outline-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from shapely.geometry import Point as _Point, Polygon as _Poly
from shapely.ops import unary_union
from webapp import db, app as appmod, geo_engine

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


pid = j(client.post('/api/projects', json={'name': 'WireOutline', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2

# A deliberately WRONG outline: a tiny triangle near the tile corner, nowhere near any
# stroke below. On-tile (so a server that WRONGLY trusts it still returns 201), so the
# assertions — not a 4xx — are what distinguish trust-the-wire from compute-from-points.
GARBAGE = [[tx + 2.0, ty + 2.0], [tx + 12.0, ty + 2.0], [tx + 7.0, ty + 12.0]]
GARBAGE_INSIDE = _Point(tx + 7.0, ty + 4.0)


def rings_poly(rings):
    """Union of a rings list's exterior polygons (mirrors the server's exterior-only mask)."""
    ps = [_Poly(r) for r in rings if r and len(r) >= 3]
    ps = [_Poly(p.exterior).buffer(0) for p in ps if p.is_valid and not p.is_empty]
    ps = [p for p in ps if not p.is_empty]
    return unary_union(ps) if ps else None


def live():
    return j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']


def mask_of(aid):
    a = next(x for x in live() if x['id'] == aid)
    return rings_poly(a.get('rings') or [])


def masks(label='thing'):
    return [m for m in (rings_poly(a.get('rings') or []) for a in live() if a['label'] == label)
            if m is not None and not m.is_empty]


def create(points, *, tool, sw, outline=None, label='thing'):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
            'label': label, 'strokeWidth': sw, 'tool': tool,
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if outline is not None:
        body['outline'] = outline
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)


# ── W1: a garbage wire outline has NO effect — the mask is built from the POINTS ──────────
bpts = [[cx - 25.0, cy], [cx - 8.0, cy], [cx + 8.0, cy], [cx + 25.0, cy]]
w1 = create(bpts, tool='brush', sw=20.0, outline=GARBAGE)
m1 = mask_of(w1['id'])
assert m1 is not None and not m1.is_empty, f'W1: expected a mask, got {m1}'
assert m1.buffer(1).contains(_Point(cx, cy)), \
    f'W1: the mask must cover the stroke centerline — geometry must come from the POINTS, not the '\
    f'wire outline (current mask sits at {list(m1.exterior.coords)[:3]}…)'
assert not m1.contains(GARBAGE_INSIDE), \
    'W1: the mask must NOT sit at the garbage-outline triangle (the wire outline was ignored)'
assert m1.area > 50, f'W1: the brush mask must have real area, got {m1.area:.1f}'
print('PASS W1 — a garbage wire `outline` is ignored; the mask is computed from the points')

# ── W2: a BRUSH mask matches the engine's BRUSH op, not the polyline fallback ─────────────
exp_brush = rings_poly(geo_engine.outline_brush([[p[0], p[1]] for p in bpts], 20.0))
exp_poly = rings_poly(geo_engine.outline_polyline([[p[0], p[1]] for p in bpts], [10.0] * len(bpts)))
assert exp_brush is not None
sd_brush = m1.symmetric_difference(exp_brush).area
sd_poly = m1.symmetric_difference(exp_poly).area
assert sd_brush < 0.05 * m1.area, \
    f'W2: brush mask must match the engine BRUSH outline (symdiff {sd_brush:.2f} vs area {m1.area:.2f})'
assert sd_brush <= sd_poly + 1e-6, \
    f'W2: mask must fit the BRUSH op at least as well as the polyline op ({sd_brush:.2f} vs {sd_poly:.2f})'
print('PASS W2 — a brush mask is the engine BRUSH outline (not the round-capped polyline fallback)')

# ── W3: a per-vertex-width POLYLINE keeps its taper server-side with NO wire outline ──────
p0 = [cx - 30.0, cy, 20.0]   # radius ~10 at the start
p1 = [cx + 30.0, cy, 60.0]   # radius ~30 at the end
w3 = create([p0, p1], tool='polyline', sw=20.0)   # NO outline on the wire
m3 = mask_of(w3['id'])
assert m3 is not None and not m3.is_empty, 'W3: a polyline mask must exist'
# narrow at the small-size start (r ~10)
assert m3.buffer(0.5).contains(_Point(cx - 30.0, cy + 8.0)), 'W3: start half-width must reach ~+8'
assert not m3.contains(_Point(cx - 30.0, cy + 20.0)), 'W3: start must NOT reach +20 (r~10, not the wide end)'
# wide at the big-size end (r ~30) — a constant-width fallback (r~10) would FAIL this
assert m3.buffer(0.5).contains(_Point(cx + 30.0, cy + 25.0)), \
    'W3: end half-width must reach ~+25 (per-vertex size honored server-side, not a constant radius)'
assert not m3.contains(_Point(cx + 30.0, cy + 45.0)), 'W3: end must not reach +45'
print('PASS W3 — a variable-width polyline keeps its per-vertex taper with no wire outline')

# ── W4: an EDIT carrying a garbage outline is stored from its new POINTS ──────────────────
w4 = create([[cx - 20.0, cy - 30.0], [cx + 20.0, cy - 30.0]], tool='brush', sw=16.0)
sid = w4['createdStrokeId']
new_pts = [[cx - 20.0, cy + 30.0], [cx + 20.0, cy + 30.0]]
r = client.patch(f'/api/projects/{pid}/strokes/{sid}',
                 json={'points': new_pts, 'strokeWidth': 16.0, 'outline': GARBAGE})
assert r.status_code == 200, f'W4: edit should 200, got {r.status_code}: {j(r)}'
after = [m for m in (rings_poly(a.get('rings') or []) for a in live()) if m is not None and not m.is_empty]
assert any(m.buffer(1).contains(_Point(cx, cy + 30.0)) for m in after), \
    'W4: the edited mask must follow the NEW points'
assert not any(m.contains(_Point(cx, cy - 30.0)) for m in after), \
    'W4: the OLD position must be vacated (points, not a stale/garbage outline)'
assert not any(m.contains(GARBAGE_INSIDE) for m in after), \
    'W4: the edit must ignore the garbage wire outline'
print('PASS W4 — an edit ignores the wire outline; the mask follows the new points')

# ── W5: FREEZE — a new stroke fused into an existing mask keeps the existing geometry ─────
a5 = create([[cx - 45.0, cy + 5.0], [cx - 22.0, cy + 5.0]], tool='brush', sw=20.0, label='thing')
pA = _Point(cx - 45.0, cy + 5.0)   # the far-left end of A, outside B's footprint below
assert mask_of(a5['id']).buffer(1).contains(pA), 'W5 setup: A must cover its own left end'
create([[cx - 22.0, cy + 5.0], [cx + 8.0, cy + 5.0]], tool='brush', sw=20.0, label='thing')  # fuses into A
ms = masks('thing')
assert any(m.buffer(1).contains(pA) for m in ms), \
    'W5: A must survive the fusion (the existing mask geometry is honored, not recomputed away)'
assert any(m.buffer(1).contains(_Point(cx + 8.0, cy + 5.0)) for m in ms), 'W5: B must be present too'
print('PASS W5 — fusion preserves an existing mask (stored geometry honored — freeze)')

print('ALL PASS test_wire_outline_retired')
