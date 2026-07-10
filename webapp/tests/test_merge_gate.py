"""
Backend acceptance tests for MERGE Phase 1: the batch-completion gate + the read-only
blind pooled-annotations read.

Covers:
  M1. mergeReady is false while any annotator_tile in the batch is not 'completed', on
      both GET /api/projects/<id> (batches list) and GET /api/batches/<id>.
  M2. mergeReady flips true only once EVERY annotator_tile (all tiles x all annotators)
      is 'completed'.
  M3. POST /api/batches/<id>/enter-merge -> 409 while not merge-ready.
  M4. POST /api/batches/<id>/enter-merge -> 200, batch.status='merge' once ready; a second
      call is idempotent (still 200, still 'merge').
  M5. GET /api/batches/<id>/merge-annotations pools annotations from EVERY annotator
      (cross-annotator, unlike the per-annotator ?annotator= canvas read) — scoped to the
      batch's own tiles, soft-deleted annotations excluded.
  M6. Non-member is rejected (403) on enter-merge and merge-annotations.

Run with: uv run python3 webapp/tests/test_merge_gate.py
"""

import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-merge-gate-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import io
import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.execute("INSERT INTO users (id, username) VALUES (3, 'bob')")
_c.execute("INSERT INTO users (id, username) VALUES (4, 'mallory')")
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

mallory_client = app.test_client()
with mallory_client.session_transaction() as s:
    s['user_id'] = 4; s['username'] = 'mallory'


def jdump(r):
    return r.get_json()


def _make_leaf_png(w: int = 200, h: int = 200) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[20:h - 20, 20:w - 20] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: project, 2-annotator roster, image, a 1-tile batch ─────────────────

print('\n── Setup ──')

r = alice_client.post('/api/projects', json={'name': 'MergeGateTest', 'tile_size_px': 256})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

r = admin_client.post(f'/api/projects/{pid}/annotators', json={'user_id': 3})
assert r.status_code == 201, jdump(r)  # bob joins alice on the roster

leaf = _make_leaf_png()
r = alice_client.post(
    f'/api/projects/{pid}/images/upload',
    data={'files': [(io.BytesIO(leaf), 'leaf.png', 'image/png')]},
    content_type='multipart/form-data',
)
r.get_data()
assert r.status_code == 200, jdump(r)

det = jdump(alice_client.get(f'/api/projects/{pid}'))
image_id = det['images'][0]['id']

r = alice_client.post(f'/api/projects/{pid}/batches', json={'size': 1})
assert r.status_code == 201, jdump(r)
batch_id = jdump(r)['id']
print(f'  batch {batch_id} created (1 tile x 2 annotators)')


def _annotator_tile_id(client, username):
    cv = jdump(client.get(f'/api/batches/{batch_id}?annotator={username}'))
    return cv['images'][0]['tiles'][0]['annotatorTileId'], cv


# ── M1/M2: mergeReady flips only once every annotator_tile is completed ───────

print('\n── M1/M2: mergeReady gate ──')

det0 = jdump(alice_client.get(f'/api/projects/{pid}'))
b0 = next(b for b in det0['batches'] if b['id'] == batch_id)
assert b0['mergeReady'] is False, f'expected not ready, got {b0}'
cv0 = jdump(alice_client.get(f'/api/batches/{batch_id}'))
assert cv0['mergeReady'] is False
print('  ✓  fresh batch: mergeReady=False (batches list + get_batch agree)')

alice_at_id, _ = _annotator_tile_id(alice_client, 'alice')
r = alice_client.patch(f'/api/annotator-tiles/{alice_at_id}', json={'state': 'completed'})
assert r.status_code == 200, jdump(r)

det1 = jdump(alice_client.get(f'/api/projects/{pid}'))
b1 = next(b for b in det1['batches'] if b['id'] == batch_id)
assert b1['mergeReady'] is False, 'still not ready — bob has not completed his tile'
print('  ✓  alice completed, bob has not -> still mergeReady=False')

bob_at_id, _ = _annotator_tile_id(bob_client, 'bob')
r = bob_client.patch(f'/api/annotator-tiles/{bob_at_id}', json={'state': 'completed'})
assert r.status_code == 200, jdump(r)

det2 = jdump(alice_client.get(f'/api/projects/{pid}'))
b2 = next(b for b in det2['batches'] if b['id'] == batch_id)
assert b2['mergeReady'] is True, f'expected ready once both completed, got {b2}'
cv2 = jdump(alice_client.get(f'/api/batches/{batch_id}'))
assert cv2['mergeReady'] is True
print('  ✓  both completed -> mergeReady=True (batches list + get_batch agree)')


# ── M3: enter-merge rejected while not ready (re-open a tile first) ───────────

print('\n── M3: enter-merge -> 409 while not ready ──')

r = alice_client.patch(f'/api/annotator-tiles/{alice_at_id}', json={'state': 'dirty'})
assert r.status_code == 200
r = alice_client.post(f'/api/batches/{batch_id}/enter-merge')
assert r.status_code == 409, f'expected 409, got {r.status_code}: {jdump(r)}'
print('  ✓  enter-merge -> 409 while a tile is not completed')

# Re-complete so we can proceed
r = alice_client.patch(f'/api/annotator-tiles/{alice_at_id}', json={'state': 'completed'})
assert r.status_code == 200


# ── M4: enter-merge succeeds once ready; idempotent on retry ──────────────────

print('\n── M4: enter-merge -> 200, status flips to merge; idempotent ──')

r = alice_client.post(f'/api/batches/{batch_id}/enter-merge')
assert r.status_code == 200, f'expected 200, got {r.status_code}: {jdump(r)}'
assert jdump(r)['status'] == 'merge'

cv3 = jdump(alice_client.get(f'/api/batches/{batch_id}'))
assert cv3['status'] == 'merge', f'expected status=merge, got {cv3["status"]}'
print('  ✓  batch.status -> merge')

r2 = alice_client.post(f'/api/batches/{batch_id}/enter-merge')
assert r2.status_code == 200, f'expected idempotent 200, got {r2.status_code}: {jdump(r2)}'
assert jdump(r2)['status'] == 'merge'
print('  ✓  second enter-merge call is idempotent (200, still merge)')


# ── M5: merge-annotations pools marks from every annotator ────────────────────

print('\n── M5: merge-annotations pools cross-annotator ──')

_, cv_alice = _annotator_tile_id(alice_client, 'alice')
tile0 = cv_alice['images'][0]['tiles'][0]
tx, ty, tw, th = tile0['x'], tile0['y'], tile0['w'], tile0['h']


def make_stroke(client, username, points, label='lesion', sw=10):
    body = {
        'imageId': image_id, 'annotator': username, 'kind': 'stroke',
        'points': points, 'label': label, 'strokeWidth': sw,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
    }
    r2 = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r2.status_code == 201, f'make_stroke failed: {jdump(r2)}'
    return jdump(r2)


cx, cy = tx + tw // 4, ty + th // 4
a1 = make_stroke(alice_client, 'alice', [[cx, cy], [cx + 15, cy + 15]])
bx, by = tx + 3 * tw // 4, ty + 3 * th // 4
a2 = make_stroke(bob_client, 'bob', [[bx, by], [bx + 15, by + 15]])

merged = jdump(alice_client.get(f'/api/batches/{batch_id}/merge-annotations'))
anns = merged['annotations']
ann_ids = {a['id'] for a in anns}
assert a1['id'] in ann_ids and a2['id'] in ann_ids, \
    f'expected both alice+bob marks pooled, got ids {ann_ids}'
annotators_seen = {a['annotator'] for a in anns}
assert annotators_seen == {'alice', 'bob'}, f'expected both, got {annotators_seen}'
print(f'  ✓  merge-annotations pooled {len(anns)} mark(s) from {annotators_seen}')

# soft-delete alice's mark -> disappears from the pooled read
r = alice_client.delete(f'/api/annotations/{a1["id"]}')
assert r.status_code == 200, jdump(r)
merged2 = jdump(alice_client.get(f'/api/batches/{batch_id}/merge-annotations'))
ids2 = {a['id'] for a in merged2['annotations']}
assert a1['id'] not in ids2 and a2['id'] in ids2, f'expected only bob left, got {ids2}'
print('  ✓  soft-deleted mark excluded from the pooled read')


# ── M6: non-member rejected ────────────────────────────────────────────────────

print('\n── M6: non-member -> 403 ──')

r = mallory_client.post(f'/api/batches/{batch_id}/enter-merge')
assert r.status_code == 403, f'expected 403, got {r.status_code}: {jdump(r)}'
r = mallory_client.get(f'/api/batches/{batch_id}/merge-annotations')
assert r.status_code == 403, f'expected 403, got {r.status_code}: {jdump(r)}'
print('  ✓  non-member -> 403 on both enter-merge and merge-annotations')


print('\n\nALL MERGE-GATE BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
