"""
Backend tests for lesion grouping (B1–B5 of Phase 2).

Covers:
  L1. Two overlapping same-label strokes → 1 lesion with 2 memberIds.
  L2. Two disjoint same-label strokes → 2 lesions.
  L3. Two overlapping strokes with different labels → 2 lesions.
  L4. mutate {op:'delete'} removes lesion; rows get deleted_at set.
  L5. mutate {op:'restore'} restores lesion.
  L6. create_annotation response includes lesions; get_batch includes per-image lesions.
  L7. Ownership: a member who is not the owner gets 403 from mutate.

Run with: uv run python3 webapp/tests/test_lesions.py
"""

import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-lesion-test-')
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

r = alice_client.post('/api/projects', json={'name': 'LesionTest', 'tile_size_px': 128})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']
print(f'  project {pid}')

# Add bob as a member
r = admin_client.post(f'/api/projects/{pid}/annotators', json={'user_id': 3})
assert r.status_code == 201, jdump(r)

# Upload an image
leaf = _make_leaf_png()
r = alice_client.post(
    f'/api/projects/{pid}/images/upload',
    data={'files': [(io.BytesIO(leaf), 'leaf.png', 'image/png')]},
    content_type='multipart/form-data',
)
assert r.status_code == 200, jdump(r)
events = [json.loads(ln) for ln in r.get_data(as_text=True).splitlines() if ln.strip()]
assert any(e.get('type') == 'done' for e in events)

det = jdump(alice_client.get(f'/api/projects/{pid}'))
image_id = det['images'][0]['id']
print(f'  image {image_id}')

# Create batch
r = alice_client.post(f'/api/projects/{pid}/batches', json={'size': 16})
assert r.status_code == 201, jdump(r)
batch_id = jdump(r)['id']
print(f'  batch {batch_id}')

# Find a tile to draw in
cv = jdump(alice_client.get(f'/api/batches/{batch_id}?annotator=alice'))
t0 = cv['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2  # centre of tile
print(f'  drawing in tile x={tx} y={ty} w={tw} h={th}, centre={cx},{cy}')


def make_stroke(points, label='lesion', sw=20):
    """Create a stroke via API (as alice) and return the response JSON."""
    r2 = alice_client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
        'points': points, 'label': label, 'strokeWidth': sw,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
    })
    assert r2.status_code == 201, f'make_stroke failed: {jdump(r2)}'
    return jdump(r2)


# ── L1: overlapping strokes → 1 lesion with 2 memberIds ──────────────────────

print('\n── L1: overlapping same-label strokes → 1 lesion ──')

# Two strokes that cross in the same tile (large brush so they definitely overlap)
a1 = make_stroke([[cx - 10, cy], [cx + 10, cy]], label='lesion', sw=30)
a2 = make_stroke([[cx, cy - 10], [cx, cy + 10]], label='lesion', sw=30)
# create_annotation must return lesions (L6 partial)
assert 'lesions' in a2, f'lesions missing from create_annotation response: {a2}'
lesions = a2['lesions']
print(f'  lesions after 2nd stroke: {lesions}')

# Find the lesion-lesion group
ll = [l for l in lesions if l['label'] == 'lesion']
assert len(ll) == 1, f'expected 1 lesion group, got {len(ll)}: {ll}'
assert set(ll[0]['memberIds']) == {a1['id'], a2['id']}, \
    f'expected both stroke ids in lesion, got {ll[0]["memberIds"]}'
assert 'key' in ll[0], 'lesion must have a key field'
print('  ✓  2 overlapping strokes → 1 lesion')


# ── L2: disjoint same-label strokes → 2 lesions ──────────────────────────────

print('\n── L2: disjoint same-label strokes → 2 lesions ──')

# Clear by deleting previous (soft), then draw two non-overlapping strokes
r = alice_client.delete(f'/api/annotations/{a1["id"]}')
assert r.status_code == 200
r = alice_client.delete(f'/api/annotations/{a2["id"]}')
assert r.status_code == 200

# Draw strokes far apart (but both inside the tile)
pad = 5
a3 = make_stroke([[tx + pad, cy], [tx + pad + 5, cy]], label='lesion', sw=4)
a4 = make_stroke([[tx + tw - pad - 5, cy], [tx + tw - pad, cy]], label='lesion', sw=4)

lesions2 = a4['lesions']
ll2 = [l for l in lesions2 if l['label'] == 'lesion']
print(f'  lesions after disjoint strokes: {ll2}')
# Should be exactly 2 single-member lesions
assert len(ll2) == 2, f'expected 2 lesion groups, got {len(ll2)}: {ll2}'
for l in ll2:
    assert len(l['memberIds']) == 1, f'disjoint stroke should be its own lesion: {l}'
print('  ✓  2 disjoint strokes → 2 lesions')


# ── L3: different labels → 2 lesions even if overlapping ─────────────────────

print('\n── L3: different-label overlapping strokes → 2 lesions ──')

# Delete previous
alice_client.delete(f'/api/annotations/{a3["id"]}')
alice_client.delete(f'/api/annotations/{a4["id"]}')

a5 = make_stroke([[cx - 10, cy], [cx + 10, cy]], label='lesion', sw=30)
a6 = make_stroke([[cx, cy - 10], [cx, cy + 10]], label='midrib', sw=30)

lesions3 = a6['lesions']
labels_present = {l['label'] for l in lesions3}
print(f'  lesions labels: {labels_present}')
assert 'lesion' in labels_present, 'lesion label group missing'
assert 'midrib' in labels_present, 'midrib label group missing'
# Each label has exactly 1 member each
for l in lesions3:
    assert len(l['memberIds']) == 1, f'cross-label strokes should not share a lesion: {l}'
print('  ✓  overlapping different-label strokes → 2 separate lesions')


# ── L4: mutate delete removes lesion; rows get deleted_at set ─────────────────

print('\n── L4: mutate delete ──')

# First, make two overlapping strokes of the same label to form one lesion
alice_client.delete(f'/api/annotations/{a5["id"]}')
alice_client.delete(f'/api/annotations/{a6["id"]}')

b1 = make_stroke([[cx - 10, cy], [cx + 10, cy]], label='lesion', sw=30)
b2 = make_stroke([[cx, cy - 10], [cx, cy + 10]], label='lesion', sw=30)
assert len([l for l in b2['lesions'] if l['label'] == 'lesion']) == 1, 'expected 1 lesion'

r = alice_client.post(f'/api/projects/{pid}/annotations/mutate',
                      json={'op': 'delete', 'ids': [b1['id'], b2['id']]})
assert r.status_code == 200, f'mutate delete failed: {jdump(r)}'
mut = jdump(r)
assert mut['ok'] is True
assert set(mut['ids']) == {b1['id'], b2['id']}
# Lesion should be gone from grouping
ll4 = [l for l in mut['lesions'] if l['label'] == 'lesion']
assert len(ll4) == 0, f'expected 0 lesion groups after delete, got {ll4}'
print('  ✓  mutate delete removes lesion from grouping')

# Verify deleted_at set in DB
_c2 = db.get_db()
try:
    for ann_id in [b1['id'], b2['id']]:
        row = _c2.execute('SELECT deleted_at FROM annotation WHERE id = ?', (ann_id,)).fetchone()
        assert row['deleted_at'] is not None, f'deleted_at not set for {ann_id}'
finally:
    db.close_db(_c2)
print('  ✓  deleted_at set on both rows')


# ── L5: mutate restore re-adds lesion ────────────────────────────────────────

print('\n── L5: mutate restore ──')

r = alice_client.post(f'/api/projects/{pid}/annotations/mutate',
                      json={'op': 'restore', 'ids': [b1['id'], b2['id']]})
assert r.status_code == 200, f'mutate restore failed: {jdump(r)}'
mut5 = jdump(r)
assert mut5['ok'] is True
ll5 = [l for l in mut5['lesions'] if l['label'] == 'lesion']
assert len(ll5) == 1, f'expected 1 lesion after restore, got {ll5}'
assert set(ll5[0]['memberIds']) == {b1['id'], b2['id']}, f'unexpected memberIds: {ll5[0]}'

# Verify deleted_at cleared
_c3 = db.get_db()
try:
    for ann_id in [b1['id'], b2['id']]:
        row = _c3.execute('SELECT deleted_at FROM annotation WHERE id = ?', (ann_id,)).fetchone()
        assert row['deleted_at'] is None, f'deleted_at should be NULL after restore for {ann_id}'
finally:
    db.close_db(_c3)
print('  ✓  mutate restore re-adds lesion and clears deleted_at')


# ── L6: get_batch includes per-image lesions ──────────────────────────────────

print('\n── L6: get_batch includes lesions ──')

cv2 = jdump(alice_client.get(f'/api/batches/{batch_id}?annotator=alice'))
for img_entry in cv2['images']:
    assert 'lesions' in img_entry, f'get_batch image missing lesions field: {img_entry.keys()}'
print('  ✓  get_batch returns lesions per image')


# ── L7: non-owner member gets 403 from mutate ────────────────────────────────

print('\n── L7: ownership enforcement ──')

# b1/b2 belong to alice; bob is a project member but not the owner
r = bob_client.post(f'/api/projects/{pid}/annotations/mutate',
                    json={'op': 'delete', 'ids': [b1['id']]})
assert r.status_code == 403, f'expected 403 for bob mutating alice annotation, got {r.status_code}'
print('  ✓  non-owner member gets 403 from mutate')

# ── L8: stroke centerline outside tile but painted width overlaps it ─────────

print('\n── L8: edge-overlapping stroke (B1 fix) ──')

# Tile starts at x=0. Centerline at x=-5 (outside), stroke_width=20 → radius=10 reaches x=+5.
# Before B1 fix: centerline linestring at x=-5 does NOT intersect tile → 422.
# After B1 fix: buffered footprint (x=-15 to x=+5) DOES intersect tile → 201.
edge_resp = alice_client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
    'points': [[-5, ty + th // 4], [-5, ty + 3 * th // 4]],
    'label': 'edge-test', 'strokeWidth': 20,
    'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
})
assert edge_resp.status_code == 201, (
    f'expected 201 for edge-overlapping stroke, got {edge_resp.status_code}: {jdump(edge_resp)}'
)
es = jdump(edge_resp)
assert t0['tileId'] in es['tileIds'], f"tile missing from tileIds: {es['tileIds']}"
print(f'  tileIds={es["tileIds"]}')
alice_client.delete(f'/api/annotations/{es["id"]}')
print('  ✓  edge-overlapping stroke accepted and tile correctly tagged')


# ── L9: self-intersecting stroke (figure-eight) → single lesion with rings ───

print('\n── L9: self-intersecting stroke → single lesion + non-empty rings (B2+B3) ──')

# Figure-eight that crosses itself at (cx, cy) — loops above and below.
eight_pts = [
    [cx, cy], [cx + 20, cy - 20], [cx, cy - 40], [cx - 20, cy - 20], [cx, cy],
    [cx + 20, cy + 20], [cx, cy + 40], [cx - 20, cy + 20], [cx, cy],
]
eight_resp = make_stroke(eight_pts, label='figure8', sw=10)
assert eight_resp.get('id'), f'figure-eight stroke not created: {eight_resp}'
eight_lesions = [l for l in eight_resp['lesions'] if l['label'] == 'figure8']
print(f'  component count for label=figure8: {len(eight_lesions)}')
assert len(eight_lesions) == 1, f'expected 1 component, got {len(eight_lesions)}: {eight_lesions}'
rings = eight_lesions[0]['rings']
assert rings, f'rings should be non-empty: {eight_lesions[0]}'
assert len(rings[0]) >= 4, f'exterior ring should have ≥4 points: {rings[0]}'
print(f'  rings: {len(rings)} ring(s), exterior has {len(rings[0])} pts')
alice_client.delete(f'/api/annotations/{eight_resp["id"]}')
print('  ✓  self-intersecting stroke → single lesion with valid rings')



# ── L10: migration idempotency — outline_json column ─────────────────────────

print('\n── L10: migrate_annotation_outline idempotency ──')

# Call twice; second call must not raise
db.migrate_annotation_outline()
db.migrate_annotation_outline()
# Column must exist
_c4 = db.get_db()
try:
    cols = {r['name'] for r in _c4.execute('PRAGMA table_info(annotation)').fetchall()}
    assert 'outline_json' in cols, f'outline_json column missing; columns: {cols}'
finally:
    db.close_db(_c4)
print('  ✓  migrate_annotation_outline is idempotent and column exists')


# ── L11: outline drives geometry (outline larger than centerline buffer) ──────

print('\n── L11: outline drives lesion geometry ──')

# Stroke: a single mouse point (degenerate centerline) with a large outline square.
# The outline square is 40×40 centred at (cx, cy).
big_outline = [
    [cx - 20, cy - 20], [cx + 20, cy - 20],
    [cx + 20, cy + 20], [cx - 20, cy + 20],
    [cx - 20, cy - 20],
]
r_out = alice_client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
    'points': [[cx, cy]], 'label': 'outline-test', 'strokeWidth': 2,
    'outline': big_outline,
    'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
})
assert r_out.status_code == 201, f'outline-driven stroke failed: {jdump(r_out)}'
out_data = jdump(r_out)
out_lesions = [l for l in out_data['lesions'] if l['label'] == 'outline-test']
assert len(out_lesions) == 1, f'expected 1 outline-test lesion, got {out_lesions}'
rings_out = out_lesions[0]['rings']
assert rings_out, f'expected non-empty rings: {out_lesions[0]}'
# Exterior ring bbox must reflect the 40×40 outline (width ≥ 30), not the 2px centerline
xs = [pt[0] for pt in rings_out[0]]
ring_width = max(xs) - min(xs)
assert ring_width >= 30, (
    f'ring bbox should reflect large outline (width≥30), got {ring_width}; ring={rings_out[0]}')
alice_client.delete(f'/api/annotations/{out_data["id"]}')
print(f'  ring width={ring_width} ✓  outline drives lesion geometry')


# ── L12: loop outline → no hole (donut fix) ──────────────────────────────────

print('\n── L12: loop outline → exactly one ring (no donut) ──')

# A figure-eight outline (self-intersecting loop): two diamond loops sharing a centre.
# buffer(0) should dissolve the self-crossing and fill any holes.
loop_outline = [
    [cx, cy],
    [cx + 15, cy - 15], [cx, cy - 30], [cx - 15, cy - 15],  # top lobe
    [cx, cy],
    [cx + 15, cy + 15], [cx, cy + 30], [cx - 15, cy + 15],  # bottom lobe
    [cx, cy],
]
r_loop = alice_client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
    'points': [[cx, cy]], 'label': 'loop-test', 'strokeWidth': 2,
    'outline': loop_outline,
    'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
})
assert r_loop.status_code == 201, f'loop stroke creation failed: {jdump(r_loop)}'
loop_data = jdump(r_loop)
loop_lesions = [l for l in loop_data['lesions'] if l['label'] == 'loop-test']
assert loop_lesions, f'no loop-test lesion returned: {loop_data["lesions"]}'
loop_rings = loop_lesions[0]['rings']
assert loop_rings, f'expected non-empty rings for loop lesion: {loop_lesions[0]}'
assert len(loop_rings) == 1, (
    f'loop lesion must have exactly 1 ring (no holes); got {len(loop_rings)} rings: {loop_rings}')
# Sanity: the exterior ring must have meaningful area (not a point)
lxs = [pt[0] for pt in loop_rings[0]]
lys = [pt[1] for pt in loop_rings[0]]
assert max(lxs) - min(lxs) > 5, f'exterior ring too small: {loop_rings[0]}'
assert max(lys) - min(lys) > 5, f'exterior ring too small: {loop_rings[0]}'
alice_client.delete(f'/api/annotations/{loop_data["id"]}')
print(f'  {len(loop_rings[0])} exterior pts, no holes ✓  loop → no donut')


# ── L13: legacy fallback — stroke without outline still works ─────────────────

print('\n── L13: legacy fallback (no outline) ──')

# Stroke submitted without an outline field — must fall back to centerline buffer.
r_leg = alice_client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
    'points': [[cx - 10, cy], [cx + 10, cy]], 'label': 'legacy-test', 'strokeWidth': 20,
    'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
    # no 'outline' key
})
assert r_leg.status_code == 201, f'legacy stroke failed: {jdump(r_leg)}'
leg_data = jdump(r_leg)
leg_lesions = [l for l in leg_data['lesions'] if l['label'] == 'legacy-test']
assert len(leg_lesions) == 1, f'expected 1 legacy lesion, got {leg_lesions}'
assert leg_lesions[0]['rings'], f'legacy lesion must have rings: {leg_lesions[0]}'
alice_client.delete(f'/api/annotations/{leg_data["id"]}')
print('  ✓  legacy stroke (no outline) produces valid lesion via centerline buffer')


print('\n✓ All lesion tests passed')
