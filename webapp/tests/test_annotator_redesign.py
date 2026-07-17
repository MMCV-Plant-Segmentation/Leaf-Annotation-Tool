"""
Backend acceptance tests for the annotator config redesign.

Exercises:
  1. Project creation with name only (defaults applied)
  2. Roster → registered-user FK: valid user succeeds, missing user rejected
  3. GET /api/users/members → {id, username}, reachable by non-admin logged-in user
  4. Recursive folder import: nested images imported, full source_path stored
  5. Tile-size lock: change succeeds with 0 batches, rejected once a batch exists

Run with: uv run python3 webapp/tests/test_annotator_redesign.py
"""

import os
import tempfile
import struct
import zlib
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='leaf-anno-redesign-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()

# seed admin user
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (username) VALUES ('alice')")
_c.execute("INSERT INTO users (username) VALUES ('bob')")
_c.commit()
# get alice+bob ids
_alice_id = _c.execute("SELECT id FROM users WHERE username='alice'").fetchone()['id']
_bob_id   = _c.execute("SELECT id FROM users WHERE username='bob'").fetchone()['id']
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
client = app.test_client()

# Log in as admin
with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'


def jdump(r):
    return r.get_json()


# ── helpers ────────────────────────────────────────────────────────────────────

def _make_leaf_png(path: Path, w: int = 200, h: int = 180) -> None:
    """Write a synthetic leaf PNG (bright region on dark background)."""
    arr = np.zeros((h, w), np.uint8)
    arr[30:h - 30, 20:w - 20] = 210
    Image.fromarray(arr, 'L').save(str(path))


def _make_minimal_png(path: Path) -> None:
    """Write a tiny 4×4 greyscale PNG using stdlib only (no Pillow dep)."""
    width, height = 4, 4
    def chunk(tag: bytes, data: bytes) -> bytes:
        length = struct.pack('>I', len(data))
        payload = tag + data
        crc = struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)
        return length + payload + crc
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
    raw  = (b'\x00' + b'\x80' * width) * height
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend)


# ── Test 1: project creation with name only ────────────────────────────────────

print('\n── Test 1: project creation name-only ──')
r = client.post('/api/projects', json={'name': 'Name-only project'})
assert r.status_code == 201, f'Expected 201, got {r.status_code}: {jdump(r)}'
p = jdump(r)
assert p['name'] == 'Name-only project'
assert p['tile_size_px'] == 128, f'Expected default 128, got {p["tile_size_px"]}'
assert p['black_threshold'] == 0, f'Expected default 0 (MLT), got {p["black_threshold"]}'
# Per-project taxonomy (Option A): a name-only/empty project seeds a single
# REMOVABLE 'thing' label (no more hardcoded lesion/midrib/uncertain).
assert len(p['classes']) == 1 and p['classes'][0]['name'] == 'thing', \
    f'Expected single unknown label, got {p["classes"]}'
pid = p['id']
print(f'  ✓  project created with defaults: tile_size={p["tile_size_px"]}, threshold={p["black_threshold"]}')

# name is required
r2 = client.post('/api/projects', json={})
assert r2.status_code == 400, f'Expected 400 for missing name, got {r2.status_code}'
print('  ✓  missing name → 400')


# ── Test 2: roster → registered-user FK ───────────────────────────────────────

print('\n── Test 2: roster (user FK) ──')
# valid user → 201
r = client.post(f'/api/projects/{pid}/annotators', json={'user_id': _alice_id})
assert r.status_code == 201, f'Expected 201, got {r.status_code}: {jdump(r)}'
resp = jdump(r)
assert resp['byline'] == 'alice', f'Expected byline=alice, got {resp["byline"]}'
assert resp['user_id'] == _alice_id
print('  ✓  valid user added to roster, byline derived from username')

# duplicate → 409
r = client.post(f'/api/projects/{pid}/annotators', json={'user_id': _alice_id})
assert r.status_code == 409, f'Expected 409, got {r.status_code}'
print('  ✓  duplicate user → 409')

# non-existent user_id → 404
r = client.post(f'/api/projects/{pid}/annotators', json={'user_id': 99999})
assert r.status_code == 404, f'Expected 404 for missing user, got {r.status_code}'
print('  ✓  non-existent user_id → 404')

# missing user_id → 400
r = client.post(f'/api/projects/{pid}/annotators', json={})
assert r.status_code == 400, f'Expected 400 for missing user_id, got {r.status_code}'
print('  ✓  missing user_id → 400')

# add bob too
r = client.post(f'/api/projects/{pid}/annotators', json={'user_id': _bob_id})
assert r.status_code == 201
print('  ✓  second user (bob) added')

# project detail includes user_id on annotators
det = jdump(client.get(f'/api/projects/{pid}'))
roster = {a['byline']: a for a in det['annotators']}
assert 'alice' in roster and 'bob' in roster
assert roster['alice']['user_id'] == _alice_id
print('  ✓  GET /api/projects/<id> returns annotators with user_id')


# ── Test 3: GET /api/users/members (non-admin, login_required) ────────────────

print('\n── Test 3: /api/users/members endpoint ──')
r = client.get('/api/users/members')
assert r.status_code == 200, f'Expected 200, got {r.status_code}: {jdump(r)}'
members = jdump(r)
assert isinstance(members, list)
# Should only have {id, username} — no password_hash, no invite
for m in members:
    assert set(m.keys()) == {'id', 'username'}, f'Unexpected keys: {m.keys()}'
usernames = [m['username'] for m in members]
assert 'alice' in usernames and 'bob' in usernames
print(f'  ✓  /api/users/members returns {len(members)} users with only id+username')

# Query filter
r = client.get('/api/users/members?q=ali')
assert r.status_code == 200
filtered = jdump(r)
assert all('ali' in m['username'] for m in filtered), f'Filter failed: {filtered}'
print(f'  ✓  ?q=ali returns filtered list: {[m["username"] for m in filtered]}')

# Test with non-admin user to confirm login_required (not admin_required)
with client.session_transaction() as s:
    s['user_id'] = _alice_id
    s['username'] = 'alice'

r = client.get('/api/users/members')
assert r.status_code == 200, f'Non-admin should access members: {r.status_code}'
print('  ✓  non-admin user can access /api/users/members')

# Restore admin session
with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'


# ── Test 4: recursive folder import + source_path provenance ──────────────────

print('\n── Test 4: recursive folder import + source_path ──')
# Build a nested directory: root/leaf0.png, root/sub1/leaf1.png, root/sub1/sub2/leaf2.png
src_root = Path(TMP) / 'nested_images'
sub1 = src_root / 'sub1'
sub2 = sub1 / 'sub2'
sub2.mkdir(parents=True)

_make_leaf_png(src_root / 'leaf0.png', w=200, h=180)
_make_leaf_png(sub1 / 'leaf1.png', w=220, h=160)    # different size → different hash
_make_leaf_png(sub2 / 'leaf2.png', w=240, h=200)    # different size → different hash
# non-image file should be ignored, not fatal
(src_root / 'notes.txt').write_text('ignore me')

r = client.post(f'/api/projects/{pid}/images/import', json={'path': str(src_root)})
assert r.status_code == 200, f'Expected 200, got {r.status_code}: {jdump(r)}'
imp = jdump(r)
print(f'  import result: {imp}')
assert imp['imported'] == 3, f'Expected 3 imported, got {imp["imported"]}'
assert imp['skipped'] == 0
assert imp['errors'] == [], f'Unexpected errors: {imp["errors"]}'
print('  ✓  all 3 nested images imported, non-image file ignored')

# Check source_path provenance
det2 = jdump(client.get(f'/api/projects/{pid}'))
images = det2['images']
assert len(images) == 3, f'Expected 3 images, got {len(images)}'
paths = {im['source_path'] for im in images}
assert str(src_root / 'leaf0.png') in paths, f'leaf0.png path missing: {paths}'
assert str(sub1 / 'leaf1.png') in paths, f'leaf1.png path missing: {paths}'
assert str(sub2 / 'leaf2.png') in paths, f'leaf2.png path missing: {paths}'
print('  ✓  full source_path stored for each image')

# Re-import → all skipped (idempotent)
r = client.post(f'/api/projects/{pid}/images/import', json={'path': str(src_root)})
imp2 = jdump(r)
assert imp2['skipped'] == 3, f'Expected 3 skipped, got {imp2["skipped"]}'
assert imp2['imported'] == 0
print('  ✓  re-import → all skipped (idempotent)')

# Single file import
single_path = src_root / 'leaf0.png'
# Already exists → skipped
r = client.post(f'/api/projects/{pid}/images/import', json={'path': str(single_path)})
imp3 = jdump(r)
assert imp3['skipped'] == 1
print('  ✓  single file path → 1 skipped (already imported)')


# ── Test 5: tile_size_px lock ─────────────────────────────────────────────────

print('\n── Test 5: tile_size_px lock ──')
# Currently 0 batches → can change tile_size_px
r = client.patch(f'/api/projects/{pid}', json={'tile_size_px': 64})
assert r.status_code == 200, f'Expected 200 changing tile_size, got {r.status_code}: {jdump(r)}'
assert jdump(r)['tile_size_px'] == 64
print('  ✓  tile_size_px change accepted with 0 batches')

# Create a batch so we have ≥1 batch
r = client.post(f'/api/projects/{pid}/batches', json={'size': 2})
assert r.status_code == 201, f'Batch create failed: {r.status_code}: {jdump(r)}'
print('  batch created')

# Now tile_size_px change should be rejected
r = client.patch(f'/api/projects/{pid}', json={'tile_size_px': 128})
assert r.status_code == 422, f'Expected 422 after batch exists, got {r.status_code}: {jdump(r)}'
print('  ✓  tile_size_px change rejected with ≥1 batch (422)')

# Other updates still work (name, threshold, classes)
r = client.patch(f'/api/projects/{pid}', json={'black_threshold': 55})
assert r.status_code == 200
assert jdump(r)['black_threshold'] == 55
print('  ✓  other fields (threshold) still updatable after batch exists')


print('\n\nALL BACKEND REDESIGN TESTS PASSED ✓  (data dir:', TMP, ')')
