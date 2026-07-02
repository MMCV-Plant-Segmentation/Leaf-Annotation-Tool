"""
Backend tests for the brush eraser under the annotation/stroke fused-mask model.

POST /api/projects/<project_id>/annotations/erase-stroke builds the eraser's footprint
with the same `_stroke_polygon` helper used for paint strokes, and soft-deletes the WHOLE
of every one of the requesting annotator's LIVE annotations (any kind) whose own geometry
intersects it. There is no stroke-level logic and no area-subtraction: a fused mask is
deleted entirely if touched at all — splits are impossible by construction (see
docs/plans/Plan — Annotation-stroke model (fused masks).md).

Covers:
  E1. One eraser drag sweeping over 2 separate (disjoint) annotations -> both soft-deleted
      in a single request.
  E2. Erasing over PART of a fused mask (a "+" of 2 crossing strokes merged into ONE
      annotation) removes the WHOLE mask — not just the touched member — while a second,
      untouched annotation stays intact.
  E3. An eraser stroke that touches nothing -> deletedAnnotationIds empty, nothing changes.
  E4. Erasing in an already-completed tile flips it back to 'dirty' (tileStates non-empty)
      — same BUGS #16 contract as create/mutate/delete.
  E5. Ownership: erase-stroke is scoped to the REQUESTING annotator's own annotations only
      — another project member's identically-placed eraser stroke deletes nothing of a
      different annotator's work.
  E6. Loop-fills-solid: a self-intersecting eraser outline that CIRCLES a lesion — the
      eraser centerline/outline never touches the lesion's own strokes, but the loop
      encloses it — still soft-deletes the whole enclosed annotation (matches the brush's
      loop-fills-solid behavior). A lesion clearly OUTSIDE the loop survives.

Run with: uv run python3 webapp/tests/test_eraser.py
"""

import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-eraser-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.execute("INSERT INTO users (id, username) VALUES (3, 'bob')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True

admin_client = app.test_client()
with admin_client.session_transaction() as s:
    s['user_id'] = 1; s['username'] = 'admin'

alice_client = app.test_client()
with alice_client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'

bob_client = app.test_client()
with bob_client.session_transaction() as s:
    s['user_id'] = 3; s['username'] = 'bob'


def jdump(r):
    return r.get_json()


def _make_leaf_png(w: int = 200, h: int = 200) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[20:h - 20, 20:w - 20] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: project, image, batch, annotators ─────────────────────────────────

print('\n── Setup ──')

r = alice_client.post('/api/projects', json={'name': 'EraserTest', 'tile_size_px': 128})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

# Add bob as a member
r = admin_client.post(f'/api/projects/{pid}/annotators', json={'user_id': 3})
assert r.status_code == 201, jdump(r)

leaf = _make_leaf_png()
r = alice_client.post(
    f'/api/projects/{pid}/images/upload',
    data={'files': [(io.BytesIO(leaf), 'leaf.png', 'image/png')]},
    content_type='multipart/form-data',
)
events = [json.loads(ln) for ln in r.get_data(as_text=True).splitlines() if ln.strip()]
assert r.status_code == 200 and any(e.get('type') == 'done' for e in events)

det = jdump(alice_client.get(f'/api/projects/{pid}'))
image_id = det['images'][0]['id']

r = alice_client.post(f'/api/projects/{pid}/batches', json={'size': 16})
assert r.status_code == 201, jdump(r)
batch_id = jdump(r)['id']

cv = jdump(alice_client.get(f'/api/batches/{batch_id}?annotator=alice'))
t0 = cv['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2
print(f'  tile x={tx} y={ty} w={tw} h={th}, centre={cx},{cy}')


def _username(client):
    return 'bob' if client is bob_client else 'alice'


def make_stroke(client, points, label='lesion', sw=10):
    r2 = client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': _username(client), 'kind': 'stroke',
        'points': points, 'label': label, 'strokeWidth': sw,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
    })
    assert r2.status_code == 201, f'make_stroke failed: {jdump(r2)}'
    return jdump(r2)


def erase(client, points, sw, outline=None):
    body = {
        'imageId': image_id, 'annotator': _username(client),
        'points': points, 'strokeWidth': sw,
    }
    if outline is not None:
        body['outline'] = outline
    r2 = client.post(f'/api/projects/{pid}/annotations/erase-stroke', json=body)
    assert r2.status_code == 200, f'erase-stroke failed: {jdump(r2)}'
    return jdump(r2)


def tile_state(at_id):
    c = db.get_db()
    try:
        return c.execute('SELECT state FROM annotator_tile WHERE id = ?', (at_id,)).fetchone()['state']
    finally:
        db.close_db(c)


def is_deleted(ann_id):
    c = db.get_db()
    try:
        row = c.execute('SELECT deleted_at FROM annotation WHERE id = ?', (ann_id,)).fetchone()
        return row['deleted_at'] is not None
    finally:
        db.close_db(c)


# ── E1: one drag over 2 disjoint annotations -> both deleted whole ───────────

print('\n── E1: brush-erase over 2 separate annotations ──')

a1 = make_stroke(alice_client, [[cx - 10, cy - 8], [cx + 10, cy - 8]], sw=4)
a2 = make_stroke(alice_client, [[cx - 10, cy + 8], [cx + 10, cy + 8]], sw=4)
assert a1['id'] != a2['id']

res = erase(alice_client, [[cx, cy - 20], [cx, cy + 20]], sw=8)
assert set(res['deletedAnnotationIds']) == {a1['id'], a2['id']}, \
    f'expected both deleted, got {res["deletedAnnotationIds"]}'
assert is_deleted(a1['id']) and is_deleted(a2['id'])
print('  ✓  one drag deletes both whole annotations')


# ── E2: erasing PART of a fused mask deletes the WHOLE mask ──────────────────

print('\n── E2: erase touching part of a fused ("+") mask removes it entirely ──')

b1 = make_stroke(alice_client, [[cx - 30, cy], [cx + 30, cy]], sw=10)   # horizontal bar
b2 = make_stroke(alice_client, [[cx, cy - 30], [cx, cy + 30]], sw=10)   # vertical bar, fuses with b1
assert b2['consumedAnnotationIds'] == [b1['id']], \
    f'expected b1+b2 fused into one annotation, got {b2["consumedAnnotationIds"]}'
mask_id = b2['id']

# A second, UNTOUCHED annotation elsewhere in the same tile — must survive.
untouched = make_stroke(alice_client, [[tx + 6, ty + 6], [tx + 9, ty + 6]], sw=3)

# Erase only the far end of the horizontal bar (well clear of the vertical arm).
res2 = erase(alice_client, [[cx - 28, cy]], sw=6)
assert res2['deletedAnnotationIds'] == [mask_id], \
    f'expected the WHOLE fused mask deleted, got {res2["deletedAnnotationIds"]}'
assert is_deleted(mask_id), 'the fused mask must be gone entirely, not split'
assert not is_deleted(untouched['id']), 'an untouched annotation must stay intact'
print('  ✓  erase touching any part of a mask removes the whole thing; untouched mask survives')


# ── E3: eraser stroke touching nothing is a no-op ────────────────────────────

print('\n── E3: eraser stroke that intersects nothing ──')

far_x, far_y = tx + 2, ty + 2
res3 = erase(alice_client, [[far_x, far_y]], sw=2)
assert res3['deletedAnnotationIds'] == [], f'expected no deletions, got {res3["deletedAnnotationIds"]}'
assert not is_deleted(untouched['id']), 'unrelated annotation must be untouched'
print('  ✓  no intersection → no deletions')


# ── E4: erasing in a completed tile re-opens it (BUGS #16) ──────────────────

print('\n── E4: erase in a completed tile flips it to dirty ──')

r = alice_client.patch(f"/api/annotator-tiles/{t0['annotatorTileId']}", json={'state': 'completed'})
assert r.status_code == 200, jdump(r)
assert tile_state(t0['annotatorTileId']) == 'completed'

res4 = erase(alice_client, [[tx + 6, ty + 6]], sw=6)  # sweeps `untouched`
assert res4['deletedAnnotationIds'] == [untouched['id']], \
    f'expected `untouched` deleted, got {res4["deletedAnnotationIds"]}'
assert 'tileStates' in res4, f'tileStates missing from erase-stroke response: {res4.keys()}'
ts4 = [s for s in res4['tileStates'] if s['tileId'] == t0['tileId']]
assert len(ts4) == 1 and ts4[0]['state'] == 'dirty', f'expected t0 flipped to dirty, got {res4["tileStates"]}'
assert tile_state(t0['annotatorTileId']) == 'dirty'
print('  ✓  erasing in a completed tile re-opens it')


# ── E5: ownership — erase-stroke only ever touches the requester's own work ──

print('\n── E5: ownership scoping ──')

c1 = make_stroke(alice_client, [[cx - 5, cy], [cx + 5, cy]], sw=6)
res5 = erase(bob_client, [[cx - 5, cy], [cx + 5, cy]], sw=6)  # same location, as bob
assert res5['deletedAnnotationIds'] == [], \
    f"bob's erase must not touch alice's annotation, got {res5['deletedAnnotationIds']}"
assert not is_deleted(c1['id']), "alice's annotation must survive bob's identically-placed erase"
print("  ✓  erase-stroke is scoped to the requesting annotator's own work")

# ── E6: self-intersecting (looped) eraser outline fills solid, like the brush ────

print('\n── E6: circling a lesion with a looped eraser stroke erases it whole ──')

# A perfect-freehand-style outline for a stroke that loops back on itself: trace the
# OUTER boundary of the loop one way, then the INNER boundary in the OPPOSITE winding
# direction as a single ring. `ShapelyPolygon(outline).buffer(0)` resolves this exactly
# as the brush's freehand outline resolves a real looped drag: into an annulus whose
# ENCLOSED area (the inner square) is a hole, not solid fill. `_exterior_only` must
# turn that hole back into solid fill so a lesion sitting inside it still gets erased.
#
# Centered in a fresh corner of the tile (not the tile centre used by earlier sections,
# where `c1` from E5 is still LIVE) so the only candidates inside/outside the loop are
# the two lesions this section creates.
lx, ly = tx + tw - 34, ty + th - 34
outer_half = 22
inner_half = 10
outer_ring = [
    [lx - outer_half, ly - outer_half], [lx + outer_half, ly - outer_half],
    [lx + outer_half, ly + outer_half], [lx - outer_half, ly + outer_half],
]
inner_ring = list(reversed([
    [lx - inner_half, ly - inner_half], [lx + inner_half, ly - inner_half],
    [lx + inner_half, ly + inner_half], [lx - inner_half, ly + inner_half],
]))
loop_outline = outer_ring + [outer_ring[0]] + inner_ring + [inner_ring[0]]

# Sanity check: this outline really does resolve to an annulus (a hole) before the fix's
# helper is applied — otherwise this test wouldn't be exercising the reported bug.
from shapely.geometry import Polygon as _ShapelyPolygon
_raw = _ShapelyPolygon([tuple(p) for p in loop_outline]).buffer(0)
_inner_probe = _ShapelyPolygon([
    (lx - inner_half / 2, ly - inner_half / 2), (lx + inner_half / 2, ly - inner_half / 2),
    (lx + inner_half / 2, ly + inner_half / 2), (lx - inner_half / 2, ly + inner_half / 2),
])
assert not _raw.contains(_inner_probe), 'test setup bug: outline does not produce a hole'

# Lesion entirely INSIDE the loop's enclosed (hole) area — the eraser's own centerline/
# outline never touches it, only encircles it.
inside_lesion = make_stroke(
    alice_client,
    [[lx - 3, ly], [lx + 3, ly]], sw=2, label='circled-lesion',
)
# Lesion clearly OUTSIDE the loop — must survive.
outside_lesion = make_stroke(
    alice_client,
    [[tx + 4, ty + 4], [tx + 7, ty + 4]], sw=2, label='outside-lesion',
)

res6 = erase(alice_client, [[lx, ly]], sw=2, outline=loop_outline)
assert res6['deletedAnnotationIds'] == [inside_lesion['id']], \
    f'expected only the circled lesion deleted, got {res6["deletedAnnotationIds"]}'
assert is_deleted(inside_lesion['id']), 'lesion circled by the loop must be erased'
assert not is_deleted(outside_lesion['id']), 'lesion outside the loop must survive'
print('  ✓  circling a lesion with a looped eraser stroke erases it; outside lesion survives')


print('\n✓ All eraser tests passed')
