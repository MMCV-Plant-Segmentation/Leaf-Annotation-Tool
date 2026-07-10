"""
TDD spec (Opus-written) for Merge 2a — ERASURE votes (backend). FAILS on current code; the
implementer makes it pass WITHOUT editing this file.

An erasure = a per-merger "this mark is not a lesion / an error" vote. It is a recoverable TOGGLE
(delete the row to un-erase — recovery beyond undo/redo), scoped to the merger who cast it.

Covers:
  ER1. co_erasure table exists (migration 0006 + db.py schema).
  ER2. POST erase a pooled mark -> it lists in that merger's erasures.
  ER3. DELETE un-erase -> gone (recoverable toggle).
  ER4. Per-merger: one merger's erasure is invisible to another merger's read.
  ER5. Member-gate (non-member 403) + a non-pooled mark is rejected.

Run: uv run python3 webapp/tests/test_merge_erasure.py
"""

import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-merge-erasure-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import io
import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
for uid, un in [(1, 'admin'), (2, 'alice'), (3, 'bob'), (4, 'mallory')]:
    _c.execute("INSERT INTO users (id, username) VALUES (?, ?)", (uid, un))
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True


def _client(uid, un):
    c = app.test_client()
    with c.session_transaction() as s:
        s['user_id'] = uid; s['username'] = un
    return c


admin, alice, bob, mallory = _client(1, 'admin'), _client(2, 'alice'), _client(3, 'bob'), _client(4, 'mallory')


def jj(r):
    return r.get_json()


def _leaf_png(w=256, h=256):
    arr = np.zeros((h, w), np.uint8)
    arr[20:h - 20, 20:w - 20] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup (mirrors the CO test): batch in merge mode with two pooled marks ────
print('\n── Setup ──')
pid = jj(alice.post('/api/projects', json={'name': 'MergeErasureTest', 'tile_size_px': 256}))['id']
assert admin.post(f'/api/projects/{pid}/annotators', json={'user_id': 3}).status_code == 201
r = alice.post(f'/api/projects/{pid}/images/upload',
               data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
               content_type='multipart/form-data')
r.get_data(); assert r.status_code == 200, jj(r)
image_id = jj(alice.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = jj(alice.post(f'/api/projects/{pid}/batches', json={'size': 1}))['id']


def _at_id(client, un):
    cv = jj(client.get(f'/api/batches/{batch_id}?annotator={un}'))
    return cv['images'][0]['tiles'][0]['annotatorTileId'], cv


a_at, cv_alice = _at_id(alice, 'alice')
b_at, _ = _at_id(bob, 'bob')
assert alice.patch(f'/api/annotator-tiles/{a_at}', json={'state': 'completed'}).status_code == 200
assert bob.patch(f'/api/annotator-tiles/{b_at}', json={'state': 'completed'}).status_code == 200
assert alice.post(f'/api/batches/{batch_id}/enter-merge').status_code == 200

tile0 = cv_alice['images'][0]['tiles'][0]
tx, ty, tw, th = tile0['x'], tile0['y'], tile0['w'], tile0['h']


def make_stroke(client, un, points):
    body = {'imageId': image_id, 'annotator': un, 'kind': 'stroke', 'points': points,
            'label': 'lesion', 'strokeWidth': 10, 'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'make_stroke: {jj(r)}'
    return jj(r)['id']


qx, qy = tx + tw // 4, ty + th // 4
fx, fy = tx + 3 * tw // 4, ty + 3 * th // 4
mark_a = make_stroke(alice, 'alice', [[qx, qy], [qx + 15, qy + 15]])
mark_b = make_stroke(bob, 'bob', [[fx, fy], [fx + 15, fy + 15]])


def erased(client, merger):
    r = client.get(f'/api/batches/{batch_id}/erasures?merger={merger}')
    assert r.status_code == 200, f'list erasures: {r.status_code} {jj(r)}'
    return set(jj(r)['erasedIds'])


# ── ER1: table exists ─────────────────────────────────────────────────────────
print('\n── ER1: co_erasure table ──')
con = db.get_db()
cols = {r['name'] for r in con.execute("PRAGMA table_info(co_erasure)").fetchall()}
db.close_db(con)
assert {'merger', 'annotation_id'} <= cols, f'co_erasure cols: {cols}'
print('  ✓  co_erasure present')

# ── ER2: erase -> listed ──────────────────────────────────────────────────────
print('\n── ER2: erase a pooled mark ──')
assert erased(alice, 'alice') == set()
r = alice.post(f'/api/batches/{batch_id}/erasures', json={'annotationId': mark_a})
assert r.status_code == 201, f'erase: {r.status_code} {jj(r)}'
assert erased(alice, 'alice') == {mark_a}, 'erased mark must list'
print('  ✓  erased mark listed for the merger')

# ── ER3: un-erase (recoverable) ───────────────────────────────────────────────
print('\n── ER3: un-erase ──')
r = alice.delete(f'/api/batches/{batch_id}/erasures/{mark_a}')
assert r.status_code in (200, 204), f'un-erase: {r.status_code} {jj(r)}'
assert erased(alice, 'alice') == set(), 'un-erased mark must be recoverable (gone from the list)'
print('  ✓  un-erase recovers the mark')

# ── ER4: per-merger isolation ─────────────────────────────────────────────────
print('\n── ER4: erasures are per-merger ──')
assert alice.post(f'/api/batches/{batch_id}/erasures', json={'annotationId': mark_a}).status_code == 201
assert erased(alice, 'alice') == {mark_a}
assert erased(bob, 'bob') == set(), "alice's erasure must not show in bob's erasures"
print("  ✓  a merger's erasure is invisible to another merger")

# ── ER5: gates ────────────────────────────────────────────────────────────────
print('\n── ER5: gates ──')
assert mallory.get(f'/api/batches/{batch_id}/erasures?merger=mallory').status_code == 403
assert mallory.post(f'/api/batches/{batch_id}/erasures', json={'annotationId': mark_b}).status_code == 403
r = alice.post(f'/api/batches/{batch_id}/erasures', json={'annotationId': 'not-a-pooled-mark'})
assert r.status_code in (400, 404, 422), f'non-pooled erase must be rejected, got {r.status_code}'
print('  ✓  non-member 403; non-pooled mark rejected')

print('\n\nALL MERGE-ERASURE TESTS PASSED ✓  (data dir:', TMP, ')')
