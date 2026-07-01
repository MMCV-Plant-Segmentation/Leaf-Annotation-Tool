"""
Backend tests for the brush eraser (invisible-brush delete-by-intersection).

POST /api/projects/<project_id>/annotations/erase-stroke accepts an eraser stroke
(points + strokeWidth, same shape as a paint-brush commit), builds its footprint with the
same `_stroke_polygon` helper used for paint strokes, and soft-deletes every one of the
requesting annotator's LIVE strokes whose footprint intersects it. It does NOT create an
annotation of its own — it only deletes.

Covers:
  E1. One eraser drag sweeping over 2 separate (disjoint) strokes → both soft-deleted in
      a single request; lesions recompute to have neither.
  E2. Erasing over PART of a fused lesion (a "+" of 2 crossing strokes) removes only the
      member stroke the eraser actually touched — the other survives as its own lesion.
  E3. An eraser stroke that touches nothing → deletedIds empty, nothing changes.
  E4. Erasing in an already-completed tile flips it back to 'dirty' (tileStates non-empty)
      — same BUGS #16 contract as create/mutate/delete.
  E5. Ownership: erase-stroke is scoped to the REQUESTING annotator's own strokes only —
      another project member's identically-placed eraser stroke deletes nothing of a
      different annotator's strokes.

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
assert r.status_code == 200, jdump(r)
events = [json.loads(ln) for ln in r.get_data(as_text=True).splitlines() if ln.strip()]
assert any(e.get('type') == 'done' for e in events)

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


def make_stroke(client, points, label='lesion', sw=10):
    r2 = client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': _username(client), 'kind': 'stroke',
        'points': points, 'label': label, 'strokeWidth': sw,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
    })
    assert r2.status_code == 201, f'make_stroke failed: {jdump(r2)}'
    return jdump(r2)


def _username(client):
    return 'bob' if client is bob_client else 'alice'


def erase(client, points, sw):
    r2 = client.post(f'/api/projects/{pid}/annotations/erase-stroke', json={
        'imageId': image_id, 'annotator': _username(client),
        'points': points, 'strokeWidth': sw,
    })
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


# ── E1: one drag over 2 disjoint strokes → both deleted, lesions recompute ───

print('\n── E1: brush-erase over 2 separate strokes ──')

a1 = make_stroke(alice_client, [[cx - 10, cy - 8], [cx + 10, cy - 8]], sw=4)
a2 = make_stroke(alice_client, [[cx - 10, cy + 8], [cx + 10, cy + 8]], sw=4)
ll = [l for l in a2['lesions'] if l['label'] == 'lesion']
assert len(ll) == 2, f'expected 2 disjoint lesions before erase, got {ll}'

res = erase(alice_client, [[cx, cy - 20], [cx, cy + 20]], sw=8)
assert set(res['deletedIds']) == {a1['id'], a2['id']}, f'expected both deleted, got {res["deletedIds"]}'
assert is_deleted(a1['id']) and is_deleted(a2['id'])
ll_after = [l for l in res['lesions'] if l['label'] == 'lesion']
assert ll_after == [], f'expected no lesion groups left, got {ll_after}'
print('  ✓  one drag deletes both strokes; lesions recompute empty')


# ── E2: erasing part of a fused lesion removes only the touched member ──────

print('\n── E2: partial erase of a fused ("+") lesion ──')

b1 = make_stroke(alice_client, [[cx - 30, cy], [cx + 30, cy]], sw=10)          # horizontal bar
b2 = make_stroke(alice_client, [[cx, cy - 30], [cx, cy + 30]], sw=10)          # vertical bar, crosses b1
ll2 = [l for l in b2['lesions'] if l['label'] == 'lesion']
assert len(ll2) == 1 and set(ll2[0]['memberIds']) == {b1['id'], b2['id']}, \
    f'expected b1+b2 fused into 1 lesion, got {ll2}'

# Erase only the far end of the horizontal bar — well clear of the vertical bar (b2 only
# reaches within 5px of x=cx; this point is 28px away).
res2 = erase(alice_client, [[cx - 28, cy]], sw=6)
assert res2['deletedIds'] == [b1['id']], f'expected only b1 deleted, got {res2["deletedIds"]}'
assert is_deleted(b1['id'])
assert not is_deleted(b2['id']), 'b2 must survive a partial erase of the fused lesion'
ll2_after = [l for l in res2['lesions'] if l['label'] == 'lesion']
assert len(ll2_after) == 1 and ll2_after[0]['memberIds'] == [b2['id']], \
    f'expected b2 alone as its own lesion, got {ll2_after}'
print('  ✓  partial erase removes only the touched member stroke; lesion re-forms from survivor')


# ── E3: eraser stroke touching nothing is a no-op ────────────────────────────

print('\n── E3: eraser stroke that intersects nothing ──')

far_x, far_y = tx + 2, ty + 2
res3 = erase(alice_client, [[far_x, far_y]], sw=2)
assert res3['deletedIds'] == [], f'expected no deletions, got {res3["deletedIds"]}'
assert not is_deleted(b2['id']), 'unrelated stroke must be untouched'
print('  ✓  no intersection → no deletions')


# ── E4: erasing in a completed tile re-opens it (BUGS #16) ──────────────────

print('\n── E4: erase in a completed tile flips it to dirty ──')

r = alice_client.patch(f"/api/annotator-tiles/{t0['annotatorTileId']}", json={'state': 'completed'})
assert r.status_code == 200, jdump(r)
assert tile_state(t0['annotatorTileId']) == 'completed'

res4 = erase(alice_client, [[cx, cy - 30], [cx, cy + 30]], sw=10)  # sweeps b2
assert res4['deletedIds'] == [b2['id']], f'expected b2 deleted, got {res4["deletedIds"]}'
assert 'tileStates' in res4, f'tileStates missing from erase-stroke response: {res4.keys()}'
ts4 = [s for s in res4['tileStates'] if s['tileId'] == t0['tileId']]
assert len(ts4) == 1 and ts4[0]['state'] == 'dirty', f'expected t0 flipped to dirty, got {res4["tileStates"]}'
assert tile_state(t0['annotatorTileId']) == 'dirty'
print('  ✓  erasing in a completed tile re-opens it')


# ── E5: ownership — erase-stroke only ever touches the requester's own strokes ──

print('\n── E5: ownership scoping ──')

c1 = make_stroke(alice_client, [[cx - 5, cy], [cx + 5, cy]], sw=6)
res5 = erase(bob_client, [[cx - 5, cy], [cx + 5, cy]], sw=6)  # same location, as bob
assert res5['deletedIds'] == [], f"bob's erase must not touch alice's stroke, got {res5['deletedIds']}"
assert not is_deleted(c1['id']), "alice's stroke must survive bob's identically-placed erase"
print("  ✓  erase-stroke is scoped to the requesting annotator's own strokes")

print('\n✓ All eraser tests passed')
