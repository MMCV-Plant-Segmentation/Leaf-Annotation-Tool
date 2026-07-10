"""
TDD spec (Opus-written) for Merge Phase 2a — candidate objects (BACKEND). FAILS on current code;
the implementer makes it pass WITHOUT editing this file.

Covers:
  CO1. Data model: candidate_object + co_membership tables exist (migration 0005 + db.py schema).
  CO2. Create a CO from explicit memberIds; it lists with its members + imageId.
  CO3. Create a CO from a BRUSH STROKE — the BACKEND resolves membership via shapely (marks whose
       geometry the stroke covers), NOT the client. A stroke over one pooled mark yields that mark
       only, not the far one.
  CO4. Group / Ungroup (PATCH add/remove members); removing the last member soft-dissolves the CO.
  CO5. Dissolve (DELETE, soft).
  CO6. Member-gate: non-member 403; a non-pooled member id is rejected; a merger can't touch another
       merger's CO.

Design (fixed): CO identity = its member marks ONLY (hull derived FE-side, not stored). Membership
geometry is a BACKEND shapely computation. reannot_* untouched.

Run: uv run python3 webapp/tests/test_merge_co.py
"""

import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-merge-co-test-')
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


def _client(uid, uname):
    c = app.test_client()
    with c.session_transaction() as s:
        s['user_id'] = uid; s['username'] = uname
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


# ── Setup (mirrors Phase 1): project, alice+bob roster, image, 1-tile batch, both complete, enter-merge ──
print('\n── Setup: batch in merge mode with two pooled marks ──')
pid = jj(alice.post('/api/projects', json={'name': 'MergeCoTest', 'tile_size_px': 256}))['id']
assert admin.post(f'/api/projects/{pid}/annotators', json={'user_id': 3}).status_code == 201
r = alice.post(f'/api/projects/{pid}/images/upload',
               data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
               content_type='multipart/form-data')
r.get_data(); assert r.status_code == 200, jj(r)
image_id = jj(alice.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = jj(alice.post(f'/api/projects/{pid}/batches', json={'size': 1}))['id']


def _at_id(client, uname):
    cv = jj(client.get(f'/api/batches/{batch_id}?annotator={uname}'))
    return cv['images'][0]['tiles'][0]['annotatorTileId'], cv


a_at, cv_alice = _at_id(alice, 'alice')
b_at, _ = _at_id(bob, 'bob')
assert alice.patch(f'/api/annotator-tiles/{a_at}', json={'state': 'completed'}).status_code == 200
assert bob.patch(f'/api/annotator-tiles/{b_at}', json={'state': 'completed'}).status_code == 200
assert alice.post(f'/api/batches/{batch_id}/enter-merge').status_code == 200

tile0 = cv_alice['images'][0]['tiles'][0]
tx, ty, tw, th = tile0['x'], tile0['y'], tile0['w'], tile0['h']


def make_stroke(client, uname, points, sw=10):
    body = {'imageId': image_id, 'annotator': uname, 'kind': 'stroke', 'points': points,
            'label': 'lesion', 'strokeWidth': sw, 'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'make_stroke: {jj(r)}'
    return jj(r)['id']


# Two pooled marks in opposite quadrants (far apart), from the two annotators.
qx, qy = tx + tw // 4, ty + th // 4            # quadrant-1 (alice)
fx, fy = tx + 3 * tw // 4, ty + 3 * th // 4     # quadrant-3 (bob)
mark_a = make_stroke(alice, 'alice', [[qx, qy], [qx + 15, qy + 15]])
mark_b = make_stroke(bob, 'bob', [[fx, fy], [fx + 15, fy + 15]])
print(f'  batch in merge mode; pooled marks: A={mark_a[:8]} (q1), B={mark_b[:8]} (q3)')


# ── CO1: data model exists ────────────────────────────────────────────────────
print('\n── CO1: candidate_object + co_membership tables ──')
con = db.get_db()
co_cols = {r[1] for r in con.execute("PRAGMA table_info(candidate_object)").fetchall()}
mem_cols = {r[1] for r in con.execute("PRAGMA table_info(co_membership)").fetchall()}
db.close_db(con)
assert {'id', 'batch_id', 'project_image_id', 'merger', 'deleted_at'} <= co_cols, f'candidate_object cols: {co_cols}'
assert {'candidate_object_id', 'annotation_id'} <= mem_cols, f'co_membership cols: {mem_cols}'
print('  ✓  tables present with the expected columns')


def list_cos(client, merger):
    r = client.get(f'/api/batches/{batch_id}/candidate-objects?merger={merger}')
    assert r.status_code == 200, f'list COs: {r.status_code} {jj(r)}'
    return jj(r)['candidateObjects']


def members(co):
    return set(co['memberIds'])


# ── CO2: create from explicit memberIds ───────────────────────────────────────
print('\n── CO2: create CO from memberIds ──')
r = alice.post(f'/api/batches/{batch_id}/candidate-objects', json={'imageId': image_id, 'memberIds': [mark_a]})
assert r.status_code == 201, f'create CO: {r.status_code} {jj(r)}'
co1 = jj(r)
assert co1['imageId'] == image_id and members(co1) == {mark_a}, f'unexpected CO: {co1}'
listed = list_cos(alice, 'alice')
assert any(c['id'] == co1['id'] and members(c) == {mark_a} for c in listed), f'CO not listed: {listed}'
print('  ✓  CO created with member A + listed for the merger')


# ── CO3: create from a brush stroke — BACKEND (shapely) resolves membership ────
print('\n── CO3: brush stroke -> BE resolves members (over B only, not A) ──')
r = alice.post(f'/api/batches/{batch_id}/candidate-objects',
               json={'imageId': image_id, 'brushPath': [[fx, fy], [fx + 5, fy + 5]], 'brushWidth': 24})
assert r.status_code == 201, f'brush CO: {r.status_code} {jj(r)}'
co2 = jj(r)
assert members(co2) == {mark_b}, f'brush over q3 should resolve to B only, got {members(co2)}'
print('  ✓  brush over B resolved to {B} (A excluded) — server-side shapely')


# ── CO4: Group / Ungroup; last removal soft-dissolves ─────────────────────────
print('\n── CO4: add/remove members; empty -> dissolve ──')
r = alice.patch(f"/api/candidate-objects/{co2['id']}", json={'addIds': [mark_a]})
assert r.status_code == 200 and members(jj(r)) == {mark_a, mark_b}, f'add: {jj(r)}'
r = alice.patch(f"/api/candidate-objects/{co2['id']}", json={'removeIds': [mark_b]})
assert r.status_code == 200 and members(jj(r)) == {mark_a}, f'remove: {jj(r)}'
r = alice.patch(f"/api/candidate-objects/{co2['id']}", json={'removeIds': [mark_a]})
assert r.status_code == 200, f'remove-last: {jj(r)}'
assert not any(c['id'] == co2['id'] for c in list_cos(alice, 'alice')), 'empty CO must soft-dissolve'
print('  ✓  group/ungroup works; removing the last member dissolves the CO')


# ── CO5: dissolve ─────────────────────────────────────────────────────────────
print('\n── CO5: dissolve (DELETE) ──')
r = alice.delete(f"/api/candidate-objects/{co1['id']}")
assert r.status_code in (200, 204), f'dissolve: {r.status_code} {jj(r)}'
assert not any(c['id'] == co1['id'] for c in list_cos(alice, 'alice')), 'dissolved CO must not list'
print('  ✓  dissolved CO gone from the list')


# ── CO6: member-gate + validation ─────────────────────────────────────────────
print('\n── CO6: gates ──')
assert mallory.get(f'/api/batches/{batch_id}/candidate-objects?merger=mallory').status_code == 403
assert mallory.post(f'/api/batches/{batch_id}/candidate-objects',
                    json={'imageId': image_id, 'memberIds': [mark_a]}).status_code == 403
print('  ✓  non-member -> 403')

r = alice.post(f'/api/batches/{batch_id}/candidate-objects',
               json={'imageId': image_id, 'memberIds': ['not-a-pooled-mark']})
assert r.status_code in (400, 404, 422), f'non-pooled member must be rejected, got {r.status_code}'
print('  ✓  a member id that is not a pooled mark of this batch is rejected')

bob_co = jj(bob.post(f'/api/batches/{batch_id}/candidate-objects', json={'imageId': image_id, 'memberIds': [mark_b]}))
assert alice.patch(f"/api/candidate-objects/{bob_co['id']}", json={'addIds': [mark_a]}).status_code == 403
assert alice.delete(f"/api/candidate-objects/{bob_co['id']}").status_code == 403
print("  ✓  a merger cannot edit/dissolve another merger's CO")


print('\n\nALL MERGE-CO (2a backend) TESTS PASSED ✓  (data dir:', TMP, ')')
