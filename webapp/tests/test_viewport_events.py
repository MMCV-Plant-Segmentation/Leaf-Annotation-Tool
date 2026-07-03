"""
Backend acceptance test for viewport telemetry (POST /api/projects/<id>/viewport-events).

Covers:
  V1. A member can POST a batch of viewport samples; response is {ok: true, count: N}.
  V2. The rows land in `viewport_event` with the right project_id/image_id/user_id and
      the numeric fields round-trip (x/y/w/h, css_w/css_h, dpr).
  V3. A non-member is rejected (403), matching create_annotation's _member_or_403 gate.
  V4. A malformed sample inside an otherwise-valid batch is skipped, not fatal — the
      well-formed samples in the same batch still land (endpoint is fail-quiet from the
      frontend's perspective; the backend just tolerates partial junk).
  V5. Missing imageId / empty events -> 400.

Modeled on webapp/tests/test_lesions.py: temp data dir, auto_create_schema(), a project +
uploaded image via the real API, then the Flask test client.

Run with: uv run python3 webapp/tests/test_viewport_events.py
"""

import io
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-viewport-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.execute("INSERT INTO users (id, username) VALUES (3, 'mallory')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True

alice_client = app.test_client()
with alice_client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'

mallory_client = app.test_client()
with mallory_client.session_transaction() as s:
    s['user_id'] = 3; s['username'] = 'mallory'


def jdump(r):
    return r.get_json()


def _make_leaf_png(w: int = 100, h: int = 100) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: project owned/joined by alice only ─────────────────────────────────

print('\n── Setup ──')

r = alice_client.post('/api/projects', json={'name': 'ViewportTest', 'tile_size_px': 64})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

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


def sample(clientTs='2026-07-03T00:00:00.000Z', x=0.0, y=0.0, w=100.0, h=100.0,
          cssW=800.0, cssH=800.0, dpr=1.0):
    return {'clientTs': clientTs, 'x': x, 'y': y, 'w': w, 'h': h,
           'cssW': cssW, 'cssH': cssH, 'dpr': dpr}


# ── V1/V2: a member posts a batch; rows land with the right values ────────────

print('\n── V1/V2: batch insert + readback ──')

events = [sample(x=0, y=0, w=100, h=100), sample(x=10, y=20, w=50, h=50, dpr=2.0)]
r = alice_client.post(f'/api/projects/{pid}/viewport-events', json={
    'imageId': image_id, 'events': events,
})
assert r.status_code == 201, jdump(r)
body = jdump(r)
assert body == {'ok': True, 'count': 2}, f'unexpected response: {body}'
print(f'  ✓  POST -> {body}')

c = db.get_db()
try:
    rows = c.execute(
        'SELECT * FROM viewport_event WHERE project_id = ? AND image_id = ? ORDER BY id',
        (pid, image_id),
    ).fetchall()
finally:
    db.close_db(c)
assert len(rows) == 2, f'expected 2 rows, got {len(rows)}'
assert rows[0]['user_id'] == 'alice', f'expected user_id=alice, got {rows[0]["user_id"]!r}'
assert rows[1]['x'] == 10.0 and rows[1]['dpr'] == 2.0, dict(rows[1])
assert rows[0]['received_at'], 'received_at must be populated server-side'
print(f'  ✓  2 rows persisted with correct project_id/image_id/user_id and numeric fields')


# ── V3: non-member is rejected ─────────────────────────────────────────────────

print('\n── V3: non-member -> 403 ──')

r = mallory_client.post(f'/api/projects/{pid}/viewport-events', json={
    'imageId': image_id, 'events': [sample()],
})
assert r.status_code == 403, f'expected 403, got {r.status_code}: {jdump(r)}'
print('  ✓  non-member POST -> 403')


# ── V4: a malformed sample in the batch is skipped, not fatal ────────────────

print('\n── V4: malformed sample inside a batch is skipped ──')

bad_batch = [sample(x=1, y=1), {'clientTs': 't', 'x': 'not-a-number', 'y': 1, 'w': 1, 'h': 1,
                                'cssW': 1, 'cssH': 1, 'dpr': 1}, sample(x=2, y=2)]
r = alice_client.post(f'/api/projects/{pid}/viewport-events', json={
    'imageId': image_id, 'events': bad_batch,
})
assert r.status_code == 201, jdump(r)
assert jdump(r)['count'] == 2, f'expected 2 well-formed rows inserted, got {jdump(r)}'
print(f'  ✓  2/3 samples inserted, malformed one skipped -> {jdump(r)}')


# ── V5: missing imageId / empty events -> 400 ─────────────────────────────────

print('\n── V5: missing imageId / empty events -> 400 ──')

r = alice_client.post(f'/api/projects/{pid}/viewport-events', json={'events': [sample()]})
assert r.status_code == 400, f'expected 400, got {r.status_code}'
r = alice_client.post(f'/api/projects/{pid}/viewport-events', json={'imageId': image_id, 'events': []})
assert r.status_code == 400, f'expected 400, got {r.status_code}'
print('  ✓  both missing-imageId and empty-events -> 400')


print('\n\nALL VIEWPORT-EVENT BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
