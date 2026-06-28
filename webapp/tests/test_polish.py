"""
Backend acceptance tests for the annotator config POLISH pass.

Covers:
  A1. Tile filter rule: a tile survives if ANY pixel is above threshold; an all-background
      tile is dropped. (The old mean-luminance rule would drop a sliver-of-leaf edge tile.)
  A2. busy_timeout PRAGMA is set on connections.
  4.  Streaming import emits a per-file event for each file + a terminal summary; bad files
      are reported, not fatal; provenance (source_path) is still stored.

Run with: uv run python3 webapp/tests/test_polish.py
"""

import json
import os
import tempfile
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='leaf-anno-polish-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod
from webapp import tiling

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
client = app.test_client()
with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'


def jdump(r):
    return r.get_json()


# ── A1: tile filter — any pixel above threshold survives ──────────────────────

print('\n── A1: tile filter (overlaps leaf component) ──')

# tile_is_black now takes the leaf-component MASK (polish-2 supersedes any-above-threshold).
THRESH = 40
tile = tiling.Rect(0, 0, 128, 128)
empty_mask = np.zeros((128, 128), dtype=bool)
# a tile that does not overlap the leaf component is dropped
assert tiling.tile_is_black(empty_mask, tile) is True, 'no-overlap tile must be black'
print('  ✓  tile not overlapping the leaf is dropped')

# a tile that overlaps even one leaf-component pixel survives
mask_sliver = np.zeros((128, 128), dtype=bool)
mask_sliver[0, 0] = True
assert tiling.tile_is_black(mask_sliver, tile) is False, \
    'a tile overlapping the leaf component must survive'
print('  ✓  tile overlapping the leaf survives')

# A thin (connected) vertical leaf sliver: its tile survives via surviving_tiles.
arr = np.zeros((128, 256), dtype=np.uint8)
arr[:, 10] = 255            # thin vertical leaf sliver (single connected component)
img = Image.fromarray(arr, 'L')
bb = tiling.compute_leaf_bbox(img, THRESH)
assert bb is not None
surv = tiling.surviving_tiles(img, bb, tile_size=128, origin_y=0, black_threshold=THRESH)
# The tile covering x[0..128) contains the sliver → must survive
assert any(t.x == 0 for t in surv), f'sliver tile dropped: {surv}'
print('  ✓  surviving_tiles keeps a connected sliver edge tile')


# ── A2: busy_timeout PRAGMA is set ────────────────────────────────────────────

print('\n── A2: busy_timeout ──')
con = db.get_db()
try:
    bt = con.execute('PRAGMA busy_timeout').fetchone()
    val = list(bt.values())[0] if hasattr(bt, 'values') else bt[0]
    assert int(val) > 0, f'busy_timeout should be > 0, got {val}'
    print(f'  ✓  busy_timeout = {val} ms')
finally:
    db.close_db(con)


# ── 4: streaming import emits per-file events + terminal summary ───────────────

print('\n── 4: streaming import ──')

# Build a nested fixture dir with 3 distinct images + a bad (non-image) file
src = Path(TMP) / 'stream_src'
sub = src / 'sub'
sub.mkdir(parents=True)
for n, (w, h) in enumerate([(200, 180), (220, 160), (240, 200)]):
    a = np.zeros((h, w), np.uint8)
    a[20:h - 20, 20:w - 20] = 210
    Image.fromarray(a, 'L').save(str((src if n == 0 else sub) / f'leaf{n}.png'))
# A file with an image extension but corrupt bytes → per-file error, not fatal
(sub / 'broken.png').write_bytes(b'not a real png')

# create a project
pid = jdump(client.post('/api/projects', json={'name': 'Stream test'}))['id']

resp = client.post(f'/api/projects/{pid}/images/import/stream', json={'path': str(src)})
assert resp.status_code == 200, f'stream status {resp.status_code}'
assert 'ndjson' in resp.mimetype or 'event-stream' in resp.mimetype or 'text' in resp.mimetype, \
    f'unexpected mimetype {resp.mimetype}'

# Parse NDJSON lines from the streamed body
lines = [ln for ln in resp.get_data(as_text=True).splitlines() if ln.strip()]
events = [json.loads(ln) for ln in lines]
types = [e['type'] for e in events]
print(f'  event types: {types}')

start = [e for e in events if e['type'] == 'start']
files = [e for e in events if e['type'] == 'file']
done = [e for e in events if e['type'] == 'done']

assert len(start) == 1, 'exactly one start event'
assert start[0]['total'] == 4, f'start.total should be 4, got {start[0]["total"]}'
assert len(files) == 4, f'one file event per file, got {len(files)}'
assert len(done) == 1, 'exactly one terminal done event'
print(f'  ✓  start(total=4) + 4 file events + done')

# 3 ok, 1 error (broken.png), not fatal
ok_files = [e for e in files if e['ok']]
bad_files = [e for e in files if not e['ok']]
assert len(ok_files) == 3, f'3 ok files, got {len(ok_files)}'
assert len(bad_files) == 1, f'1 bad file, got {len(bad_files)}'
assert 'broken.png' in bad_files[0]['name'], bad_files[0]
print('  ✓  3 ok, 1 reported error (broken.png), not fatal')

# terminal summary counts
assert done[0]['imported'] == 3, f'done.imported should be 3, got {done[0]["imported"]}'
assert len(done[0]['errors']) == 1
print(f'  ✓  done summary: imported={done[0]["imported"]}, errors={len(done[0]["errors"])}')

# provenance: source_path stored for each imported image
det = jdump(client.get(f'/api/projects/{pid}'))
paths = {im['source_path'] for im in det['images']}
assert str(src / 'leaf0.png') in paths, f'leaf0 path missing: {paths}'
assert str(sub / 'leaf1.png') in paths, f'leaf1 path missing: {paths}'
assert str(sub / 'leaf2.png') in paths, f'leaf2 path missing: {paths}'
print('  ✓  source_path provenance stored for streamed imports')

# file events carry the source path
for e in ok_files:
    assert e.get('path'), f'file event missing path: {e}'
print('  ✓  per-file events carry the source path')


print('\n\nALL POLISH BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
