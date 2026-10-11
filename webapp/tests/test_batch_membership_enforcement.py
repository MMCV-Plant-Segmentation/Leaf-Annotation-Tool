"""t126 Phase 3 (t127) — ENFORCE batch membership on annotations.

Christian, 2026-07-21: a user who is NOT a member of a batch must not be able to annotate its
tiles (today annotation-create isn't gated on membership — that's how a non-member accumulated
95 annotations). A non-member's pre-existing annotations stay **read/delete-only**: viewable
and deletable, but NOT editable/paintable. UI: NO "Open in canvas" for a non-member (the batch
is still shown, read-only) — driven by an `isMember` flag on the batch payload.

Membership = the Phase-2 `batch_member` set. Enforcement resolves the batch from the tile(s) an
annotation touches (tile -> batch_tile -> batch) and requires the annotator to be a member of
that batch. This gate applies at every PAINT/EDIT seam (create, stroke-edit, mutate, erase,
reverse, splice) but NOT to delete (read/delete-only) and NOT to admin.

CONTRACT (RED until Phase 3 lands):
  P1. A batch MEMBER can create an annotation on a batch tile -> 201.
  P2. A project member who is NOT a batch member is 403 on annotation-create for that batch's
      tile (the core t127 gap — can't paint).
  P3. get_batch carries `isMember` for the SESSION user: true for a member, false for a
      non-member (who can still GET the batch read-only), true for admin.
  P4. A non-member can DELETE their OWN pre-existing annotation -> 200 (read/delete-only): the
      membership gate must NOT block delete.

Standalone-script style (mirrors test_polyline_finish.py). The implementer does NOT edit this file.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-enforce-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")   # creator (batch member)
_c.execute("INSERT INTO users (id, username) VALUES (3, 'dana')")    # batch member at creation
_c.execute("INSERT INTO users (id, username) VALUES (4, 'bob')")     # project member, NOT a batch member
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


# ── set-up: project (roster alice), add dana, cut a batch, THEN add bob to the roster ─────
as_user(2, 'alice')
pid = jd(client.post('/api/projects', json={'name': 'Enforce', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = jd(client.get(f'/api/projects/{pid}'))['images'][0]['id']
assert client.post(f'/api/projects/{pid}/annotators', json={'user_id': 3}).status_code == 201  # dana
batch_id = jd(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
assert client.post(f'/api/projects/{pid}/annotators', json={'user_id': 4}).status_code == 201  # bob (post-batch)

t0 = jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2   # comfortably ON a batch tile


def create(annotator, label='thing'):
    return client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': annotator, 'kind': 'stroke',
        'points': [[cx, cy], [cx + 6, cy + 6]], 'label': label, 'strokeWidth': 12,
        'tool': 'brush', 'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}})


# ── P1: a batch member (alice) can paint a batch tile ─────────────────────────────────────
r_alice = create('alice')
assert r_alice.status_code == 201, f'a batch member must be able to annotate: {r_alice.status_code} {jd(r_alice)}'
print('P1 OK — a batch member can create an annotation on a batch tile')

# ── P2: a non-member (bob, project member but not a batch member) is 403 on create ────────
as_user(4, 'bob')
r_bob = create('bob')
assert r_bob.status_code == 403, \
    f'*** t127: a non-batch-member must NOT be able to annotate the batch, got {r_bob.status_code} ***'
print('P2 OK — a non-batch-member is forbidden from painting the batch')

# ── P3: get_batch exposes isMember for the session user ───────────────────────────────────
as_user(2, 'alice')
assert jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))['isMember'] is True, \
    'a batch member sees isMember=true'
as_user(4, 'bob')
b_bob = client.get(f'/api/batches/{batch_id}?annotator=bob')
assert b_bob.status_code == 200, 'a non-member can still GET the batch (read-only view)'
assert jd(b_bob)['isMember'] is False, 'a non-member sees isMember=false (FE hides Open-in-canvas)'
as_user(1, 'admin')
assert jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))['isMember'] is True, 'admin bypasses'
print('P3 OK — get_batch carries isMember (member true / non-member false / admin true)')

# ── P4: a non-member can DELETE their OWN pre-existing annotation (read/delete-only) ───────
# Seed an annotation OWNED BY BOB directly (as if it predates enforcement, like pre-enforcement work).
import uuid as _uuid
bob_aid = str(_uuid.uuid4())
con_s = db.get_db()
try:
    con_s.execute(
        '''INSERT INTO annotation (id, project_id, project_image_id, annotator, kind,
             points_json, created_at, updated_at)
           VALUES (?, ?, ?, 'bob', 'stroke', '[[1,1]]', '2026-01-01', '2026-01-01')''',
        (bob_aid, pid, image_id))
    con_s.commit()
finally:
    db.close_db(con_s)

as_user(4, 'bob')
r_del = client.delete(f'/api/annotations/{bob_aid}')
assert r_del.status_code == 200, \
    f'read/delete-only: a non-member must still be able to DELETE their own work, got {r_del.status_code}'
print('P4 OK — a non-member can delete their own pre-existing annotation (read/delete-only)')

print('\nt126 Phase 3 (t127) enforcement contract tests passed.')
