"""t126 Phase 2 — batch membership as a first-class, editable (batch <-> user) set.

Christian, 2026-07-21: "Users are assigned to BATCHES; batches have TILES; users own the
ANNOTATIONS they put on images." Phase 1 made per-(member,tile) completion LAZY and left
"membership" implicit (= the live project roster). Phase 2 makes membership a real STORED,
EDITABLE set per batch:

  - `batch_member (batch_id, annotator)` is the source of truth for who is on a batch.
  - Default membership for a NEW batch = the project roster AT CREATION TIME (preserves
    today's behaviour). A project annotator added AFTER a batch is cut is NOT automatically
    a member of that batch — they are added explicitly (that add is the durable t112 fix).
  - Merge-readiness / progress derive from batch_member x batch_tile x completion — NOT from
    the live project roster. Adding a member lowers readiness until they complete; removing a
    member raises it.
  - Remove-member drops membership ONLY: the removed member's annotations AND their completion
    records are KEPT (re-adding restores their exact prior state). Removing a member who has
    existing work requires an explicit confirm.

Phase 2 does NOT change the completion/annotation ENFORCEMENT gates (that is Phase 3 / t127) —
so a project member can still mark tiles; membership only governs the readiness/progress model
and the config-page UI. This spec pins the backend contract only; the FE config-page UI is
exercised by an e2e acceptance spec.

CONTRACT (RED until Phase 2 lands):
  B1. create_batch SEEDS batch_member = the current project roster (no annotator_tile rows).
  B2. GET /api/batches/<id> returns a `members` list, each with percent-complete.
  B3. POST   /api/batches/<id>/members {annotator}  adds a member (no tile rows); idempotent.
  B4. DELETE /api/batches/<id>/members/<annotator>  with NO work -> drops membership (200).
  B5. DELETE a member WITH work and NO confirm -> 409 needsConfirm; with ?confirm=1 -> 200 and
      that member's annotations + completion rows are PRESERVED (membership only is dropped).
  B6. Merge-readiness derives from batch_member: a project member who is NOT a batch member
      does not block readiness; ADDING them to the batch drops readiness until they complete.
  B7. get_project's per-batch payload carries the member list + percent each.
  B8. Auth: a non-project-member is 403 on the member routes; admin bypasses.

Standalone-script style (mirrors test_lazy_tile_completion.py). The implementer does NOT edit
this file — a test that looks wrong is FLAGGED to Opus, not routed around.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-batchmember-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")   # creator
_c.execute("INSERT INTO users (id, username) VALUES (3, 'dana')")    # on roster at batch time
_c.execute("INSERT INTO users (id, username) VALUES (4, 'bob')")     # added AFTER the batch
_c.execute("INSERT INTO users (id, username) VALUES (5, 'carol')")   # never on this project
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True
client = app.test_client()


def as_user(uid, uname):
    with client.session_transaction() as s:
        s['user_id'] = uid
        s['username'] = uname


def jd(r):
    return r.get_json()


def _leaf_png(w=260, h=220) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


def members_of(batch_id):
    """batch_member rows for a batch, as a set of annotator bylines."""
    con = db.get_db()
    try:
        return {r['annotator'] for r in con.execute(
            'SELECT annotator FROM batch_member WHERE batch_id = ?', (batch_id,)).fetchall()}
    finally:
        db.close_db(con)


def at_rows(batch_id):
    con = db.get_db()
    try:
        return con.execute(
            '''SELECT at.annotator, at.state FROM annotator_tile at
               JOIN batch_tile bt ON bt.id = at.batch_tile_id WHERE bt.batch_id = ?''',
            (batch_id,)).fetchall()
    finally:
        db.close_db(con)


def set_tile(bt_id, annotator, state):
    return client.post(f'/api/batch-tiles/{bt_id}/state',
                       json={'annotator': annotator, 'state': state})


def merge_ready(batch_id):
    return jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))['mergeReady']


# ── set-up: project (roster = alice), add dana to the roster, THEN cut a batch ──────────
as_user(2, 'alice')
pid = jd(client.post('/api/projects', json={'name': 'BatchMembers', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
assert client.post(f'/api/projects/{pid}/annotators', json={'user_id': 3}).status_code == 201  # dana
batch_id = jd(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']


# ── B1: create_batch seeds batch_member = the creation-time roster; NO tile rows ────────
assert members_of(batch_id) == {'alice', 'dana'}, \
    f'batch_member must seed from the creation-time roster, got {members_of(batch_id)}'
assert len(at_rows(batch_id)) == 0, \
    f'create_batch must still pre-provision ZERO annotator_tile rows, got {len(at_rows(batch_id))}'
print('B1 OK — create_batch seeds batch_member from the roster; no annotator_tile rows')

canvas = jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))
bt_ids = [t['batchTileId'] for im in canvas['images'] for t in im['tiles']]
assert bt_ids, 'batch has tiles'


# ── B2: GET batch returns a members list with percent-complete ──────────────────────────
def batch_members_payload(batch_id):
    return {m['annotator']: m for m in jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))['members']}

mp = batch_members_payload(batch_id)
assert set(mp) == {'alice', 'dana'}, f'members payload must list the members, got {set(mp)}'
assert mp['alice']['percent'] == 0, f'nobody has completed anything yet, got {mp["alice"]}'
# alice completes half the tiles -> her percent reflects it.
half = max(1, len(bt_ids) // 2)
for bt in bt_ids[:half]:
    assert set_tile(bt, 'alice', 'completed').status_code == 200
mp = batch_members_payload(batch_id)
assert mp['alice']['percent'] == round(100 * half / len(bt_ids)) or \
    abs(mp['alice']['percent'] - 100 * half / len(bt_ids)) < 1.0, \
    f'alice percent should reflect {half}/{len(bt_ids)} done, got {mp["alice"]["percent"]}'
assert mp['dana']['percent'] == 0, f'dana has done nothing, got {mp["dana"]["percent"]}'
print('B2 OK — GET batch returns members with per-member percent-complete')


# ── B3: POST members adds a member (no tile rows); idempotent ───────────────────────────
# bob is added to the PROJECT roster AFTER the batch — so he is NOT a batch member yet.
as_user(2, 'alice')
assert client.post(f'/api/projects/{pid}/annotators', json={'user_id': 4}).status_code == 201  # bob -> roster
assert 'bob' not in members_of(batch_id), 'a later project-roster add is NOT auto a batch member'

r_add = client.post(f'/api/batches/{batch_id}/members', json={'annotator': 'bob'})
assert r_add.status_code in (200, 201), f'add member failed: {r_add.status_code} {jd(r_add)}'
assert 'bob' in members_of(batch_id), 'bob is now a batch member'
before = len(at_rows(batch_id))
r_again = client.post(f'/api/batches/{batch_id}/members', json={'annotator': 'bob'})
assert r_again.status_code in (200, 201), f're-add must be idempotent, got {r_again.status_code}'
assert members_of(batch_id) == {'alice', 'dana', 'bob'}, f'no duplicate member, got {members_of(batch_id)}'
assert len(at_rows(batch_id)) == before, 'adding a member creates NO annotator_tile rows'
print('B3 OK — POST members adds a member (idempotent, no tile rows)')


# ── B4: DELETE a member with NO work -> drops membership (200) ───────────────────────────
r_del = client.delete(f'/api/batches/{batch_id}/members/bob')
assert r_del.status_code == 200, f'removing a work-free member should 200, got {r_del.status_code} {jd(r_del)}'
assert 'bob' not in members_of(batch_id), 'bob removed'
print('B4 OK — removing a member with no work drops membership')


# ── B5: DELETE a member WITH work -> confirm required; work is PRESERVED ─────────────────
# dana completes a tile AND owns an annotation -> she has "work".
as_user(3, 'dana')
assert set_tile(bt_ids[0], 'dana', 'completed').status_code == 200
con_s = db.get_db()
try:
    con_s.execute(
        '''INSERT INTO annotation (id, project_id, project_image_id, annotator, kind,
             points_json, created_at, updated_at)
           VALUES ('ann-dana-1', ?, ?, 'dana', 'stroke', '[[1,1]]',
                   '2026-01-01T00:00:00', '2026-01-01T00:00:00')''',
        (pid, canvas['images'][0]['imageId']))
    con_s.commit()
finally:
    db.close_db(con_s)

as_user(2, 'alice')
r_noconf = client.delete(f'/api/batches/{batch_id}/members/dana')
assert r_noconf.status_code == 409, \
    f'removing a member WITH work needs confirm -> 409, got {r_noconf.status_code}'
assert jd(r_noconf).get('needsConfirm') is True, f'409 body must flag needsConfirm, got {jd(r_noconf)}'
assert 'dana' in members_of(batch_id), 'dana still a member after an unconfirmed remove'

r_conf = client.delete(f'/api/batches/{batch_id}/members/dana?confirm=1')
assert r_conf.status_code == 200, f'confirmed remove should 200, got {r_conf.status_code} {jd(r_conf)}'
assert 'dana' not in members_of(batch_id), 'dana removed after confirm'
# Her annotation + completion row are KEPT (re-adding restores her state).
con_s = db.get_db()
try:
    ann = con_s.execute("SELECT deleted_at FROM annotation WHERE id = 'ann-dana-1'").fetchone()
    assert ann is not None and ann['deleted_at'] is None, 'dana annotation must be preserved'
    comp = [r for r in at_rows(batch_id) if r['annotator'] == 'dana' and r['state'] == 'completed']
    assert comp, 'dana completion record must be preserved'
finally:
    db.close_db(con_s)
print('B5 OK — removing a member with work needs confirm; annotations + completion preserved')


# ── B6: merge-readiness derives from batch_member, not the live project roster ──────────
# Current members = {alice} (dana removed above; bob removed in B4). alice completes every tile.
as_user(2, 'alice')
assert members_of(batch_id) == {'alice'}, f'sanity: only alice remains, got {members_of(batch_id)}'
for bt in bt_ids:
    assert set_tile(bt, 'alice', 'completed').status_code == 200
assert merge_ready(batch_id) is True, 'ready: the sole member (alice) completed every tile'
# bob is on the PROJECT roster but NOT a batch member -> he does not block readiness.
assert 'bob' not in members_of(batch_id)
assert merge_ready(batch_id) is True, 'a non-member project annotator does not block readiness'
# Add bob to the BATCH -> readiness drops until he completes.
assert client.post(f'/api/batches/{batch_id}/members', json={'annotator': 'bob'}).status_code in (200, 201)
assert merge_ready(batch_id) is False, 'adding a batch member drops readiness until they complete'
as_user(4, 'bob')
for bt in bt_ids:
    assert set_tile(bt, 'bob', 'completed').status_code == 200
assert merge_ready(batch_id) is True, 'ready again once the new member completed every tile'
print('B6 OK — merge-readiness derives from batch_member (add lowers, complete raises)')


# ── B7: get_project per-batch payload carries the member list + percent each ─────────────
as_user(2, 'alice')
proj = jd(client.get(f'/api/projects/{pid}'))
b = next(x for x in proj['batches'] if x['id'] == batch_id)
pm = {m['annotator']: m for m in b['members']}
assert set(pm) == {'alice', 'bob'}, f'project batch payload lists members, got {set(pm)}'
assert pm['alice']['percent'] == 100 and pm['bob']['percent'] == 100, \
    f'both members are fully done, got {pm}'
print('B7 OK — get_project per-batch payload carries members + percent')


# ── B8: auth on the member routes (non-project-member 403; admin bypass) ─────────────────
as_user(5, 'carol')   # not on this project at all
r_c_add = client.post(f'/api/batches/{batch_id}/members', json={'annotator': 'carol'})
assert r_c_add.status_code == 403, f'a non-project-member is 403 on add, got {r_c_add.status_code}'
r_c_del = client.delete(f'/api/batches/{batch_id}/members/bob')
assert r_c_del.status_code == 403, f'a non-project-member is 403 on delete, got {r_c_del.status_code}'
with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'
r_a = client.delete(f'/api/batches/{batch_id}/members/bob?confirm=1')
assert r_a.status_code == 200, f'admin bypasses membership on the routes, got {r_a.status_code}'
print('B8 OK — member routes gated on project membership; admin bypasses')


print('\nt126 Phase 2 batch-membership contract tests passed.')
