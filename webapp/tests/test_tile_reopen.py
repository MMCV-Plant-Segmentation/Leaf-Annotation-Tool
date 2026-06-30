"""
Backend tests for BUGS #16: editing a completed tile marks it incomplete again.

When an annotation mutation (create / delete-via-mutate / delete-via-DELETE / restore)
touches a tile this annotator has already marked 'completed', that tile must flip back
to 'dirty' (re-annotation needed) — and the response must include the updated tile
state(s) so the FE can reflect it without a reload.

Covers:
  T1. create_annotation into a completed tile flips it to 'dirty'; response has tileStates.
  T2. mutate {op:'delete'} on a completed tile flips it to 'dirty'.
  T3. DELETE /api/annotations/<id> on a completed tile flips it to 'dirty'.
  T4. mutate {op:'restore'} into a (re-completed) tile flips it to 'dirty' too.
  T5. Editing a tile that is NOT completed (assigned) leaves its state alone — no
      spurious tileStates entries.

Run with: uv run python3 webapp/tests/test_tile_reopen.py
"""

import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-tilereopen-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'

alice_client = app.test_client()
with alice_client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'


def jdump(r):
    return r.get_json()


def _make_leaf_png(w: int = 200, h: int = 200) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[20:h - 20, 20:w - 20] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: project, image, batch ──────────────────────────────────────────────

print('\n── Setup ──')

r = alice_client.post('/api/projects', json={'name': 'TileReopenTest', 'tile_size_px': 128})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

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
t1 = cv['images'][0]['tiles'][1]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make_stroke(points, label='lesion', sw=10):
    r2 = alice_client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
        'points': points, 'label': label, 'strokeWidth': sw,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
    })
    assert r2.status_code == 201, f'make_stroke failed: {jdump(r2)}'
    return jdump(r2)


def complete(tile):
    r3 = alice_client.patch(f"/api/annotator-tiles/{tile['annotatorTileId']}", json={'state': 'completed'})
    assert r3.status_code == 200, jdump(r3)


def tile_state(at_id):
    c = db.get_db()
    try:
        return c.execute('SELECT state FROM annotator_tile WHERE id = ?', (at_id,)).fetchone()['state']
    finally:
        db.close_db(c)


# ── T1: create_annotation into a completed tile re-opens it ──────────────────

print('\n── T1: create into a completed tile ──')

complete(t0)
assert tile_state(t0['annotatorTileId']) == 'completed'

a1 = make_stroke([[cx - 10, cy], [cx + 10, cy]])
assert 'tileStates' in a1, f'tileStates missing from create_annotation response: {a1.keys()}'
ts1 = [s for s in a1['tileStates'] if s['tileId'] == t0['tileId']]
assert len(ts1) == 1, f'expected t0 in tileStates, got {a1["tileStates"]}'
assert ts1[0]['state'] == 'dirty'
assert tile_state(t0['annotatorTileId']) == 'dirty'
print('  ✓  create_annotation flips a completed tile to dirty')


# ── T2: mutate delete on a completed tile re-opens it ─────────────────────────

print('\n── T2: mutate delete on a completed tile ──')

complete(t0)
assert tile_state(t0['annotatorTileId']) == 'completed'

r = alice_client.post(f'/api/projects/{pid}/annotations/mutate',
                      json={'op': 'delete', 'ids': [a1['id']]})
assert r.status_code == 200, jdump(r)
mut = jdump(r)
assert 'tileStates' in mut, f'tileStates missing from mutate response: {mut.keys()}'
ts2 = [s for s in mut['tileStates'] if s['tileId'] == t0['tileId']]
assert len(ts2) == 1, f'expected t0 in tileStates, got {mut["tileStates"]}'
assert tile_state(t0['annotatorTileId']) == 'dirty'
print('  ✓  mutate(delete) flips a completed tile to dirty')


# ── T3: DELETE /api/annotations/<id> on a completed tile re-opens it ─────────

print('\n── T3: DELETE endpoint on a completed tile ──')

a2 = make_stroke([[cx - 8, cy + 8], [cx + 8, cy + 8]])
complete(t0)
assert tile_state(t0['annotatorTileId']) == 'completed'

r = alice_client.delete(f"/api/annotations/{a2['id']}")
assert r.status_code == 200, jdump(r)
deld = jdump(r)
assert 'tileStates' in deld, f'tileStates missing from delete response: {deld.keys()}'
ts3 = [s for s in deld['tileStates'] if s['tileId'] == t0['tileId']]
assert len(ts3) == 1, f'expected t0 in tileStates, got {deld["tileStates"]}'
assert tile_state(t0['annotatorTileId']) == 'dirty'
print('  ✓  DELETE /api/annotations/<id> flips a completed tile to dirty')


# ── T4: mutate restore into a re-completed tile re-opens it ──────────────────

print('\n── T4: mutate restore on a completed tile ──')

# a1 is currently soft-deleted (from T2). Re-complete the tile, then restore a1.
complete(t0)
assert tile_state(t0['annotatorTileId']) == 'completed'

r = alice_client.post(f'/api/projects/{pid}/annotations/mutate',
                      json={'op': 'restore', 'ids': [a1['id']]})
assert r.status_code == 200, jdump(r)
rest = jdump(r)
assert 'tileStates' in rest, f'tileStates missing from restore response: {rest.keys()}'
ts4 = [s for s in rest['tileStates'] if s['tileId'] == t0['tileId']]
assert len(ts4) == 1, f'expected t0 in tileStates, got {rest["tileStates"]}'
assert tile_state(t0['annotatorTileId']) == 'dirty'
print('  ✓  mutate(restore) flips a completed tile to dirty')


# ── T5: editing a non-completed (assigned) tile leaves it alone ──────────────

print('\n── T5: editing an assigned (not completed) tile is a no-op for state ──')

assert tile_state(t0['annotatorTileId']) == 'dirty'  # left over from T4 — not 'completed'
a3 = make_stroke([[cx - 5, cy - 12], [cx + 5, cy - 12]])
ts5 = [s for s in a3['tileStates'] if s['tileId'] == t0['tileId']]
assert ts5 == [], f'tile was not completed; must not appear in tileStates: {a3["tileStates"]}'
assert tile_state(t0['annotatorTileId']) == 'dirty', 'state must be unchanged (still dirty, not re-touched)'
print('  ✓  a non-completed tile is left alone (no spurious tileStates entry)')

print('\n✓ All tile-reopen tests passed')
