"""
TDD spec (Opus-written) for Merge 2b — COMPLETENESS + explicit SUBMIT (backend). FAILS on current
code; the implementer makes it pass WITHOUT editing this file.

Phase 2b closes build-order step 2: a merger's pass is COMPLETE when every pooled mark for the batch
is accounted for — either a member of one of that merger's live candidate objects (co_membership) OR
erased by that merger (co_erasure). Completeness only ENABLES; SUBMIT is the explicit "I'm done — lock
my pass so agreement can compute across mergers" signal (a merger may reach completeness yet keep
revising), recorded per merger in a new `merge_submission` table.

Contract under test:
  GET  /api/batches/<id>/merge-completeness?merger=<un>
        -> 200 {total, accounted, complete, submitted, submittedAt}
           total     = # pooled marks for the batch (across its images)
           accounted = # distinct pooled marks in (that merger's LIVE COs) ∪ (that merger's erasures)
           complete  = (accounted == total)
           submitted = whether that merger has a merge_submission row; submittedAt = its ISO ts or None
  POST /api/batches/<id>/submit-merge   (acts for the SESSION user, the merger)
        -> 409 if that merger is not complete; else 200 {ok, submittedAt} + upserts merge_submission
           (idempotent — a second submit just refreshes/keeps the row, never a 500)
  DELETE /api/batches/<id>/submit-merge (acts for the SESSION user)
        -> 200/204, removes that merger's submission (un-submit to revise)

Gates: member-or-403 on every route (mirrors erasures/COs). Per-merger isolation throughout.

Run: uv run python3 webapp/tests/test_merge_submit.py
"""

import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-merge-submit-test-')
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
        s['user_id'] = uid
        s['username'] = un
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


# ── Setup (mirrors the erasure/CO tests): batch in merge mode with two pooled marks ──
print('\n── Setup ──')
pid = jj(alice.post('/api/projects', json={'name': 'MergeSubmitTest', 'tile_size_px': 256}))['id']
assert admin.post(f'/api/projects/{pid}/annotators', json={'user_id': 3}).status_code == 201
r = alice.post(f'/api/projects/{pid}/images/upload',
               data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
               content_type='multipart/form-data')
r.get_data()
assert r.status_code == 200, jj(r)
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


def completeness(client, merger):
    r = client.get(f'/api/batches/{batch_id}/merge-completeness?merger={merger}')
    assert r.status_code == 200, f'completeness: {r.status_code} {jj(r)}'
    return jj(r)


# ── SUB0: merge_submission table exists (migration 0008) ──────────────────────
print('\n── SUB0: merge_submission table ──')
con = db.get_db()
cols = {r['name'] for r in con.execute("PRAGMA table_info(merge_submission)").fetchall()}
db.close_db(con)
assert {'batch_id', 'merger'} <= cols, f'merge_submission cols: {cols}'
print('  ✓  merge_submission present')

# ── SUB1: completeness with nothing accounted -> total=2, accounted=0, incomplete ──
print('\n── SUB1: nothing accounted ──')
c = completeness(alice, 'alice')
assert c['total'] == 2, f'total should be 2 pooled marks, got {c}'
assert c['accounted'] == 0, f'nothing accounted yet, got {c}'
assert c['complete'] is False and c['submitted'] is False, c
print('  ✓  total=2, accounted=0, complete=False')

# ── SUB2: submit while incomplete -> 409 ──────────────────────────────────────
print('\n── SUB2: submit blocked while incomplete ──')
r = alice.post(f'/api/batches/{batch_id}/submit-merge')
assert r.status_code == 409, f'submit while incomplete must 409, got {r.status_code} {jj(r)}'
assert completeness(alice, 'alice')['submitted'] is False
print('  ✓  incomplete submit -> 409, not submitted')

# ── SUB3: account for both marks (CO covers mark_a, erase mark_b) -> complete ──
print('\n── SUB3: accounting reaches completeness ──')
r = alice.post(f'/api/batches/{batch_id}/candidate-objects',
               json={'imageId': image_id, 'memberIds': [mark_a]})
assert r.status_code == 201, f'create CO: {r.status_code} {jj(r)}'
c = completeness(alice, 'alice')
assert c['accounted'] == 1 and c['complete'] is False, f'one mark accounted via CO: {c}'
assert alice.post(f'/api/batches/{batch_id}/erasures', json={'annotationId': mark_b}).status_code == 201
c = completeness(alice, 'alice')
assert c['accounted'] == 2 and c['complete'] is True, f'both accounted (CO+erasure): {c}'
print('  ✓  CO-member + erased mark => accounted=2, complete=True')

# ── SUB4: submit when complete -> 200, then reported submitted ────────────────
print('\n── SUB4: submit when complete ──')
r = alice.post(f'/api/batches/{batch_id}/submit-merge')
assert r.status_code == 200, f'submit when complete must 200, got {r.status_code} {jj(r)}'
c = completeness(alice, 'alice')
assert c['submitted'] is True and c['submittedAt'], f'must report submitted + a timestamp: {c}'
print('  ✓  submitted, timestamp reported')

# ── SUB5: submit is idempotent (no 500 on re-submit) ──────────────────────────
print('\n── SUB5: idempotent re-submit ──')
r = alice.post(f'/api/batches/{batch_id}/submit-merge')
assert r.status_code == 200, f're-submit must be idempotent 200, got {r.status_code} {jj(r)}'
con = db.get_db()
n = con.execute('SELECT COUNT(*) c FROM merge_submission WHERE batch_id=? AND merger=?',
                (batch_id, 'alice')).fetchone()['c']
db.close_db(con)
assert n == 1, f'exactly one submission row per (batch, merger), got {n}'
print('  ✓  idempotent, one row')

# ── SUB6: un-submit (DELETE) lets a merger revise ─────────────────────────────
print('\n── SUB6: un-submit ──')
r = alice.delete(f'/api/batches/{batch_id}/submit-merge')
assert r.status_code in (200, 204), f'un-submit: {r.status_code} {jj(r)}'
assert completeness(alice, 'alice')['submitted'] is False
print('  ✓  un-submit clears the submission (still complete, free to revise)')

# ── SUB7: per-merger isolation ────────────────────────────────────────────────
print('\n── SUB7: per-merger ──')
cb = completeness(bob, 'bob')
assert cb['total'] == 2 and cb['accounted'] == 0 and cb['complete'] is False, \
    f"bob accounts nothing of his own (alice's CO/erasure are hers): {cb}"
assert bob.post(f'/api/batches/{batch_id}/submit-merge').status_code == 409, \
    'bob is incomplete -> his submit 409s regardless of alice'
# alice re-submits; bob still unsubmitted
assert alice.post(f'/api/batches/{batch_id}/submit-merge').status_code == 200
assert completeness(bob, 'bob')['submitted'] is False
print('  ✓  completeness + submission are per-merger')

# ── SUB8: member gate ─────────────────────────────────────────────────────────
print('\n── SUB8: gates ──')
assert mallory.get(f'/api/batches/{batch_id}/merge-completeness?merger=mallory').status_code == 403
assert mallory.post(f'/api/batches/{batch_id}/submit-merge').status_code == 403
print('  ✓  non-member 403 on completeness + submit')

print('\n\nALL MERGE-SUBMIT (2b) TESTS PASSED ✓  (data dir:', TMP, ')')
