"""t126 Phase 1 — lazy per-(member,tile) completion; no pre-provisioning (FIXES t112).

Christian, 2026-07-21: tiles are NEVER assigned to users. Users belong to a batch's roster;
the per-tile "done" checkmark is a record CREATED LAZILY when a member marks it, not
pre-seeded for the whole roster at batch creation. This fixes t112: a late-added annotator
had no pre-provisioned `annotator_tile` row, so their checkmark no-op'd. With lazy
completion any current roster member can mark a tile — the row is minted on first mark.

CONTRACT (RED until Phase 1 lands):
  L1. create_batch does NOT pre-provision annotator_tile rows (a fresh batch has ZERO).
  L2. A LATE-ADDED roster annotator can mark a tile complete via the (batch_tile,annotator)-
      keyed route — the completion row is created lazily (the t112 fix).
  L3. Re-marking toggles the SAME row (assigned<->completed), never a duplicate.
  L4. A NON-member (not on the project roster) is 403 on the toggle.
  L5. Merge-readiness = every CURRENT roster member has completed every tile (missing row =
      not done); adding a member lowers readiness until they complete too.

Standalone-script style (mirrors test_polyline_finish.py). The implementer does NOT edit it.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-lazytile-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.execute("INSERT INTO users (id, username) VALUES (3, 'dana')")
_c.execute("INSERT INTO users (id, username) VALUES (4, 'bob')")
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


def at_rows(batch_id):
    con = db.get_db()
    try:
        return con.execute(
            '''SELECT at.id, at.annotator, at.state FROM annotator_tile at
               JOIN batch_tile bt ON bt.id = at.batch_tile_id WHERE bt.batch_id = ?''',
            (batch_id,)).fetchall()
    finally:
        db.close_db(con)


def set_tile(bt_id, annotator, state):
    return client.post(f'/api/batch-tiles/{bt_id}/state',
                       json={'annotator': annotator, 'state': state})


as_user(2, 'alice')
pid = jd(client.post('/api/projects', json={'name': 'LazyTile', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
batch_id = jd(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']

# ── L1: a fresh batch pre-provisions NOTHING ────────────────────────────────────────────
assert len(at_rows(batch_id)) == 0, \
    f'create_batch must NOT pre-provision annotator_tile rows, got {len(at_rows(batch_id))}'
print('L1 OK — no pre-provisioned annotator_tile rows on batch creation')

# Collect this batch's batch_tile ids (as alice, a member).
canvas = jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))
bt_ids = [t['batchTileId'] for im in canvas['images'] for t in im['tiles']]
assert bt_ids, 'batch has tiles'

# ── L2: a LATE-ADDED annotator (dana) can mark a tile — row minted lazily (t112 fix) ─────
r_add = client.post(f'/api/projects/{pid}/annotators', json={'user_id': 3})
assert r_add.status_code == 201, f'add dana to roster failed: {jd(r_add)}'
as_user(3, 'dana')
r_mark = set_tile(bt_ids[0], 'dana', 'completed')
assert r_mark.status_code == 200, f'*** t112: late-added dana cannot mark a tile: {r_mark.status_code} {jd(r_mark)} ***'
assert jd(r_mark)['state'] == 'completed'
dana_rows = [row for row in at_rows(batch_id) if row['annotator'] == 'dana']
assert len(dana_rows) == 1 and dana_rows[0]['state'] == 'completed', \
    f'dana completion row minted lazily, got {[dict(r) for r in dana_rows]}'
print('L2 OK — a late-added annotator marks a tile; the completion row is minted lazily')

# ── L3: re-marking toggles the SAME row (no duplicate) ──────────────────────────────────
r_un = set_tile(bt_ids[0], 'dana', 'assigned')
assert r_un.status_code == 200 and jd(r_un)['state'] == 'assigned'
dana_rows = [row for row in at_rows(batch_id) if row['annotator'] == 'dana']
assert len(dana_rows) == 1, f'toggling reuses the one row, got {len(dana_rows)}'
print('L3 OK — re-marking toggles the same row (no duplicate)')

# ── L4: a NON-member (bob) is 403 ───────────────────────────────────────────────────────
as_user(4, 'bob')
r_bob = set_tile(bt_ids[0], 'bob', 'completed')
assert r_bob.status_code == 403, f'a non-member must be 403 on the toggle, got {r_bob.status_code}'
print('L4 OK — a non-member is forbidden from marking a tile')

# ── L5: merge-readiness = every current roster member × every tile completed ─────────────
def merge_ready():
    return jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))['mergeReady']

as_user(2, 'alice')
assert merge_ready() is False, 'not ready before anything is completed'
for bt in bt_ids:                          # alice completes every tile
    assert set_tile(bt, 'alice', 'completed').status_code == 200
assert merge_ready() is False, 'still not ready — dana (a roster member) has not completed'
as_user(3, 'dana')
for bt in bt_ids:                          # dana completes every tile
    assert set_tile(bt, 'dana', 'completed').status_code == 200
assert merge_ready() is True, 'ready once EVERY roster member completed EVERY tile'
# Un-completing one drops readiness again.
assert set_tile(bt_ids[0], 'dana', 'assigned').status_code == 200
assert merge_ready() is False, 'un-completing a tile drops merge-readiness'
print('L5 OK — merge-readiness = every current roster member completed every tile')

print('\nt126 Phase 1 lazy-tile-completion contract tests passed.')
