"""Polyline per-click persistence + fusion — the BE contract driving the FE rebuild.

Design (Christian, 2026-07-13): the polyline rebuild makes each click behave like a
brush stroke on finger-lift — persist + fuse immediately, per click. The FE will
sequence `create_annotation` (first click) then `edit_stroke` (each subsequent click)
so the mask exists AFTER THE FIRST CLICK and grows one vertex at a time. Each click
is its own undo entry, so Ctrl+Z peels one vertex — keep undoing to remove the whole
line. This test pins the BE-side sequence the FE will drive:

  Q1. A 1-vertex polyline commits as a real fused mask (a dot of the current radius) —
      no minimum-vertex threshold.
  Q2. Each edit_stroke call that extends the stroke by ONE vertex leaves the mask
      re-fused with the new footprint (mask covers all N vertices after each call).
  Q3. The reverse_stroke_edit descriptor from an edit is exactly the shape undo
      needs to peel the last vertex — reversing it puts the stroke back to N-1
      vertices with the corresponding re-fused mask (robust: exact prior rows).
  Q4. Undo of the FIRST click (a `draw` action — mutate delete) removes the 1-vertex
      dot cleanly; restore brings it back. This mirrors how the FE will resolve
      Ctrl+Z of the initial click (the annotation is `draw`/`merge`, not `edit`).

RED until the FE rebuild lands; the BE endpoints themselves already exist and just
need to behave under this sequential drive.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-polypc-test-')
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


r = client.post('/api/projects', json={'name': 'PolyPerClick', 'tile_size_px': 128})
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


def make(points, label, sw=12, tool='polyline'):
    r2 = client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
        'label': label, 'strokeWidth': sw, 'tool': tool,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}})
    assert r2.status_code == 201, f'create failed: {jdump(r2)}'
    return jdump(r2)


def edit_stroke(sid, points, sw=12):
    return client.patch(f'/api/projects/{pid}/strokes/{sid}',
                        json={'points': points, 'strokeWidth': sw})


def reverse_edit(sid, before, deleted_groups, created_ids):
    return client.post(f'/api/projects/{pid}/strokes/{sid}/reverse', json={
        'before': before, 'deletedGroups': deleted_groups,
        'createdAnnotationIds': created_ids})


def anns(label):
    live = jdump(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    return [a for a in live if a['label'] == label]


def stroke_points(sid):
    con = db.get_db()
    try:
        row = con.execute('SELECT points_json FROM stroke WHERE id = ?', (sid,)).fetchone()
        import json as _j
        return _j.loads(row['points_json']) if row and row['points_json'] else []
    finally:
        db.close_db(con)


def mask(a):
    return _Poly(a['rings'][0]) if a.get('rings') and a['rings'][0] else None


# ── Q1: a 1-vertex polyline commits as a real fused mask (dot of current radius) ─────
c1 = make([[cx, cy]], label='q1', sw=12)
assert c1['kind'] == 'stroke', f'a 1-click polyline is a stroke mask, got {c1["kind"]!r}'
assert c1.get('rings') and c1['rings'][0], f'a 1-click polyline needs a real mask, got {c1.get("rings")!r}'
m1 = mask(c1)
assert m1 is not None and m1.contains(_Point(cx, cy)), 'the dot mask must cover its vertex'
print('Q1 OK — 1-vertex polyline persists as a real dot mask')


# ── Q2: sequential per-click extension — the mask re-fuses to cover ALL vertices ─────
c2 = make([[cx - 30, cy - 30]], label='q2', sw=10)   # click 1: (cx-30, cy-30)
sid2 = c2['strokes'][0]['id']
assert stroke_points(sid2) == [[cx - 30, cy - 30]], 'stroke should hold the 1 clicked vertex'
m = mask(anns('q2')[0])
assert m.contains(_Point(cx - 30, cy - 30)), 'mask covers vertex 1'

# click 2: extend with (cx - 15, cy - 30)
r2 = edit_stroke(sid2, [[cx - 30, cy - 30], [cx - 15, cy - 30]])
assert r2.status_code == 200, f'edit_stroke #2 failed: {jdump(r2)}'
assert stroke_points(sid2) == [[cx - 30, cy - 30], [cx - 15, cy - 30]]
m = mask(anns('q2')[0])
assert m.contains(_Point(cx - 15, cy - 30)), 'mask covers vertex 2 after the 2nd click'
assert m.contains(_Point(cx - 30, cy - 30)), 'mask STILL covers vertex 1 after the 2nd click'

# click 3: extend with (cx, cy - 30)
r3 = edit_stroke(sid2, [[cx - 30, cy - 30], [cx - 15, cy - 30], [cx, cy - 30]])
assert r3.status_code == 200, f'edit_stroke #3 failed: {jdump(r3)}'
assert stroke_points(sid2) == [[cx - 30, cy - 30], [cx - 15, cy - 30], [cx, cy - 30]]
m = mask(anns('q2')[0])
assert m.contains(_Point(cx, cy - 30)), 'mask covers vertex 3 after the 3rd click'
assert m.contains(_Point(cx - 15, cy - 30)) and m.contains(_Point(cx - 30, cy - 30)), \
    'mask still covers the earlier vertices after the 3rd click'
print('Q2 OK — each per-click edit_stroke re-fuses the mask over all vertices')


# ── Q3: reverse_stroke_edit of the LAST edit peels one vertex (robust undo) ──────────
# Rewind click 3 → stroke goes back to 2 vertices, mask covers only those.
resp3 = jdump(r3)
rr3 = reverse_edit(sid2, resp3['before'], resp3['deletedGroups'],
                   [a['id'] for a in resp3['created']])
assert rr3.status_code == 200, f'reverse of edit #3 failed: {jdump(rr3)}'
assert stroke_points(sid2) == [[cx - 30, cy - 30], [cx - 15, cy - 30]], \
    'undo peels back to the 2-vertex state (robust: exact prior points)'
m = mask(anns('q2')[0])
assert m.contains(_Point(cx - 15, cy - 30)) and m.contains(_Point(cx - 30, cy - 30)), \
    'mask covers the 2 remaining vertices after the undo'
# vertex 3 should no longer be under the mask (accounting for the stroke radius)
far_from_3 = _Point(cx + 6, cy - 30)  # further than r=5 from vertex 3 (cx, cy-30)
assert not m.contains(far_from_3), 'mask no longer extends past the 2nd vertex'

# rewind click 2 → stroke goes back to 1 vertex
resp2 = jdump(r2)
rr2 = reverse_edit(sid2, resp2['before'], resp2['deletedGroups'],
                   [a['id'] for a in resp2['created']])
assert rr2.status_code == 200, f'reverse of edit #2 failed: {jdump(rr2)}'
assert stroke_points(sid2) == [[cx - 30, cy - 30]], 'undo peels back to the 1-vertex state'
m = mask(anns('q2')[0])
assert m.contains(_Point(cx - 30, cy - 30)), 'mask covers the last remaining vertex'
print('Q3 OK — reverse_stroke_edit peels one vertex per undo (robust)')


# ── Q4: undo of the FIRST click — mutate delete/restore, since it was a create ────────
first_ann = anns('q2')[0]
r4 = client.post(f'/api/projects/{pid}/annotations/mutate', json={
    'op': 'delete', 'ids': [first_ann['id']]})
assert r4.status_code == 200, f'delete failed: {jdump(r4)}'
assert not anns('q2'), 'after undo of the first click, the polyline mask is gone'
# redo: restore the annotation
r5 = client.post(f'/api/projects/{pid}/annotations/mutate', json={
    'op': 'restore', 'ids': [first_ann['id']]})
assert r5.status_code == 200, f'restore failed: {jdump(r5)}'
assert anns('q2'), 'redo of the first click restores the mask'
print('Q4 OK — undo of the first click removes the polyline mask cleanly')


# ── Q5: the sequential drive fuses with existing masks — a fresh polyline overlapping
#       an existing same-label mark folds into it on the FIRST click ────────────────────
c_existing = make([[cx + 40, cy + 40]], label='q5', sw=12)
assert len(anns('q5')) == 1
c_overlap = make([[cx + 42, cy + 42]], label='q5', sw=12)   # overlaps → fuses
assert c_overlap['consumedAnnotationIds'] == [c_existing['id']], \
    'the 1st click of the new polyline should fuse with the neighbour'
assert len(anns('q5')) == 1, 'exactly one annotation after fusion'
print('Q5 OK — first click fuses with an overlapping same-label mark (create path)')


print('\npolyline per-click contract tests passed.')
