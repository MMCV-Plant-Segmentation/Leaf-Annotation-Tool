"""Backend acceptance test for the ADMIN viewport-attention heatmap data source
(GET /api/projects/<id>/images/<image_id>/viewport-events).

The heatmap overlay itself is computed client-side (webapp/frontend/src/projects/
viewportHeatmap.ts) from these rows. This test pins the data source: shape, ordering
(needed so the client can compute per-user dwell between consecutive samples), the
optional user_id filter, and admin-gating (non-admin is rejected; admin-only like the
rest of the analysis surface — matches auth.admin_required).

Covers:
  H1. Admin fetches rows for a project+image; shape is {events:[...]} with the right
      fields (userId/clientTs/x/y/w/h/cssW/cssH/dpr).
  H2. Rows are ordered by (user_id, client_ts) so the client can walk consecutive
      same-user samples to compute Delta-t.
  H3. Optional ?user_id=<byline> filters to just that annotator's samples.
  H4. A non-admin member of the project is rejected (403) — this is admin-only
      analysis data, not part of the annotator workflow.
  H5. A logged-out client is rejected (401).

Modeled on webapp/tests/test_viewport_events.py: temp data dir, auto_create_schema(),
a project + uploaded image via the real API, then the Flask test client.

Run with: uv run python3 webapp/tests/test_viewport_heatmap.py
"""

import io
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-viewport-heatmap-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.execute("INSERT INTO users (id, username) VALUES (3, 'bob')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True

alice_client = app.test_client()
with alice_client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'

bob_client = app.test_client()
with bob_client.session_transaction() as s:
    s['user_id'] = 3; s['username'] = 'bob'

admin_client = app.test_client()
with admin_client.session_transaction() as s:
    s['user_id'] = 1; s['username'] = 'admin'

anon_client = app.test_client()


def jdump(r):
    return r.get_json()


def _make_leaf_png(w: int = 100, h: int = 100) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


def sample(clientTs='2026-07-03T00:00:00.000Z', x=0.0, y=0.0, w=100.0, h=100.0,
           cssW=800.0, cssH=800.0, dpr=1.0):
    return {'clientTs': clientTs, 'x': x, 'y': y, 'w': w, 'h': h,
            'cssW': cssW, 'cssH': cssH, 'dpr': dpr}


# ── Setup: alice's project; alice + bob both post viewport samples ────────────

print('\n── Setup ──')

r = alice_client.post('/api/projects', json={'name': 'HeatmapTest', 'tile_size_px': 64})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

# Add bob to the roster so his telemetry POST is member-permitted.
det = jdump(alice_client.get(f'/api/projects/{pid}'))
# bob posts against the same project — add him as an annotator via the admin.
r = admin_client.post(f'/api/projects/{pid}/annotators', json={'user_id': 3})
assert r.status_code in (201, 200), jdump(r)

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

# alice: two samples at increasing client_ts; bob: one sample in the middle (by ts).
r = alice_client.post(f'/api/projects/{pid}/viewport-events', json={
    'imageId': image_id,
    'events': [
        sample(clientTs='2026-07-03T00:00:00.000Z', x=0, y=0, w=100, h=100),
        sample(clientTs='2026-07-03T00:00:05.000Z', x=10, y=20, w=50, h=50, dpr=2.0),
    ],
})
assert r.status_code == 201, jdump(r)
assert jdump(r)['count'] == 2, jdump(r)

r = bob_client.post(f'/api/projects/{pid}/viewport-events', json={
    'imageId': image_id,
    'events': [sample(clientTs='2026-07-03T00:00:02.000Z', x=5, y=5, w=80, h=80)],
})
assert r.status_code == 201, jdump(r)


# ── H1/H2: admin fetches rows; correct shape + (user_id, client_ts) order ────

print('\n── H1/H2: admin fetch -> shape + ordering ──')

r = admin_client.get(f'/api/projects/{pid}/images/{image_id}/viewport-events')
assert r.status_code == 200, f'expected 200, got {r.status_code}: {jdump(r)}'
body = jdump(r)
assert isinstance(body, dict) and isinstance(body.get('events'), list), body
events = body['events']
assert len(events) == 3, f'expected 3 events, got {len(events)}'

# Required fields present with round-tripped values.
ev0 = events[0]
for k in ('id', 'userId', 'clientTs', 'receivedAt',
          'x', 'y', 'w', 'h', 'cssW', 'cssH', 'dpr'):
    assert k in ev0, f'missing field {k!r} in {ev0}'
assert ev0['userId'] == 'alice', ev0
assert ev0['dpr'] == 1.0, ev0
print('  ✓  shape {events:[...]} with all required fields, values round-trip')

# Ordering: by (user_id, client_ts). alice < bob alphabetically; alice's two samples
# ascending by client_ts; bob after alice.
assert [e['userId'] for e in events] == ['alice', 'alice', 'bob'], \
    f'order wrong: {[e["userId"] for e in events]}'
assert events[0]['clientTs'] < events[1]['clientTs'], \
    'alice samples must ascend by client_ts (dwell = consecutive client_ts gap)'
# bob's sample ts (00:02) is earlier than alice's second (00:05) but he sorts after alice
# because the primary sort key is user_id — exactly what the client needs for per-user
# consecutive-pair dwell.
assert events[2]['userId'] == 'bob' and events[2]['clientTs'] == '2026-07-03T00:00:02.000Z'
print('  ✓  ordered by (user_id, client_ts) — per-user dwell computable client-side')


# ── H3: optional ?user_id filter narrows to one annotator ────────────────────

print('\n── H3: user_id filter ──')

r = admin_client.get(
    f'/api/projects/{pid}/images/{image_id}/viewport-events?user_id=alice')
assert r.status_code == 200, jdump(r)
only_alice = jdump(r)['events']
assert len(only_alice) == 2 and all(e['userId'] == 'alice' for e in only_alice), only_alice
print('  ✓  ?user_id=alice -> only alice\'s 2 samples')

r = admin_client.get(
    f'/api/projects/{pid}/images/{image_id}/viewport-events?user_id=nobody')
assert r.status_code == 200, jdump(r)
assert jdump(r)['events'] == [], 'unknown user_id -> empty list, not error'
print('  ✓  ?user_id=<unknown> -> []')


# ── H4: non-admin member is rejected (admin-only) ────────────────────────────

print('\n── H4: non-admin member -> 403 ──')

r = alice_client.get(f'/api/projects/{pid}/images/{image_id}/viewport-events')
assert r.status_code == 403, f'expected 403 for non-admin, got {r.status_code}: {jdump(r)}'
print('  ✓  alice (member, non-admin) -> 403')


# ── H5: logged-out client is rejected ────────────────────────────────────────

print('\n── H5: anonymous -> 401 ──')

r = anon_client.get(f'/api/projects/{pid}/images/{image_id}/viewport-events')
assert r.status_code == 401, f'expected 401 for anon, got {r.status_code}: {jdump(r)}'
print('  ✓  anonymous -> 401')


print('\n\nALL VIEWPORT-HEATMAP BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
