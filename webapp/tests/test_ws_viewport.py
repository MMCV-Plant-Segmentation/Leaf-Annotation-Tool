"""
Backend acceptance test for the Phase 3 (feat/annotation-ws) WS viewport telemetry
handler in webapp/asgi.py — the fire-and-forget `{type:"viewport"}` frame path.

Covers:
  W1. A `viewport` frame from an ANNOTATOR session persists rows via the SAME
      do_create_viewport_events core the REST route calls (single mutation path).
  W2. An ADMIN `viewport` frame is a NO-OP — no thread, no DB write. Guards against
      re-introducing telemetry recording "as" admin (the luna catastrophe).
  W3. A malformed frame (missing imageId / empty events / non-list events) is
      silently dropped — best-effort telemetry never surfaces errors to the client
      (no ack is ever sent, so a stray error would just get swallowed anyway; we
      want the DB layer NEVER touched for junk input).
  W4. The frame handler returns IMMEDIATELY — the DB write is dispatched as a
      background task (asyncio.create_task) so a real op arriving next is never
      head-of-line-blocked behind a big batch of samples.
  W5. REST endpoint still green — shim + do_create_viewport_events stay in sync
      (this is the regression channel that keeps the existing test_viewport_events
      + test_admin_safety files green).

Runs the frame handler directly (no ASGI transport harness) — we're pinning the
DB write path + admin skip + background dispatch, all of which live in the frame
handler + its do_create_viewport_events call.

Run: uv run python3 webapp/tests/test_ws_viewport.py
"""
import asyncio
import io
import os
import tempfile
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='leaf-anno-ws-viewport-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

# Pre-seed the schema + admin BEFORE importing webapp.asgi so its _sync_admin() sees
# an existing admin and doesn't require ADMIN_PASSWORD on first boot.
from webapp import db  # noqa: E402
db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', 'x')")
_c.execute("INSERT INTO users (id, username, password_hash) VALUES (2, 'alice', 'x')")
_c.commit()
db.close_db(_c)

# webapp/asgi.py at import time reads HT_LAUNCH_LOG and reconstitutes AppConfig from
# a ledger. Use the LAUNCHER'S OWN writer so the record shape is exactly what the
# worker expects — we're pinning the WS handler, NOT the ledger contract.
from webapp.config import AppConfig  # noqa: E402
from webapp.wsgi import LAUNCH_LOG_ENV, write_launch_ledger  # noqa: E402
_cfg = AppConfig(data_dir=Path(TMP), secret_key='test-secret')
_ledger_path, _launch_id = write_launch_ledger(_cfg)
os.environ[LAUNCH_LOG_ENV] = str(_ledger_path)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from webapp import app as appmod, asgi as ws_asgi  # noqa: E402

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True

alice_client = app.test_client()
with alice_client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'


def jj(r):
    return r.get_json()


def _leaf_png(w=100, h=100):
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: alice owns a project with one image ────────────────────────────────

print('\n── Setup ──')
r = alice_client.post('/api/projects', json={'name': 'WsViewport', 'tile_size_px': 64})
assert r.status_code == 201, jj(r)
pid = jj(r)['id']

r = alice_client.post(
    f'/api/projects/{pid}/images/upload',
    data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
    content_type='multipart/form-data',
)
r.get_data()
assert r.status_code == 200, jj(r)
det = jj(alice_client.get(f'/api/projects/{pid}'))
image_id = det['images'][0]['id']


def _sample(ts, x=0.0, y=0.0, w=100.0, h=100.0):
    return {'clientTs': ts, 'x': x, 'y': y, 'w': w, 'h': h,
            'cssW': 800.0, 'cssH': 800.0, 'dpr': 1.0}


def _count(user_id: str) -> int:
    con = db.get_db()
    try:
        return con.execute(
            "SELECT COUNT(*) c FROM viewport_event WHERE project_id = ? AND user_id = ?",
            (pid, user_id)).fetchone()['c']
    finally:
        db.close_db(con)


# ── W1: annotator frame lands in the DB via the same do_ core ─────────────────

print('\n── W1: annotator viewport frame persists ──')

async def w1():
    n_before = _count('alice')
    frame = {'type': 'viewport', 'imageId': image_id, 'events': [_sample('t1'), _sample('t2', x=5)]}
    ws_asgi._handle_viewport_frame(frame, pid, {'user_id': 2, 'username': 'alice'})
    # The handler returns IMMEDIATELY — the DB write happens in a background task.
    # Poll for up to 1s while the loop drains the task.
    for _ in range(50):
        await asyncio.sleep(0.02)
        if _count('alice') == n_before + 2:
            break
    assert _count('alice') == n_before + 2, f'expected 2 new rows, got {_count("alice") - n_before}'

asyncio.run(w1())
print('  ✓  2 rows persisted for annotator via WS viewport frame')


# ── W2: admin frame is a NO-OP — no rows, no thread ───────────────────────────

print('\n── W2: admin viewport frame is a no-op ──')

async def w2():
    n_before = _count('admin')
    frame = {'type': 'viewport', 'imageId': image_id, 'events': [_sample('t3')]}
    ws_asgi._handle_viewport_frame(frame, pid, {'user_id': 1, 'username': 'admin'})
    # Give the loop a chance to run any (bogus) scheduled task before we assert.
    for _ in range(10):
        await asyncio.sleep(0.02)
    assert _count('admin') == n_before, f'admin frame must NOT persist rows, added {_count("admin") - n_before}'

asyncio.run(w2())
print('  ✓  admin frame persisted 0 rows')


# ── W3: malformed frame is silently dropped ───────────────────────────────────

print('\n── W3: malformed frames are silently dropped ──')

async def w3():
    n_before = _count('alice')
    ws_asgi._handle_viewport_frame(  # missing imageId
        {'type': 'viewport', 'events': [_sample('t4')]},
        pid, {'user_id': 2, 'username': 'alice'})
    ws_asgi._handle_viewport_frame(  # empty events
        {'type': 'viewport', 'imageId': image_id, 'events': []},
        pid, {'user_id': 2, 'username': 'alice'})
    ws_asgi._handle_viewport_frame(  # non-list events
        {'type': 'viewport', 'imageId': image_id, 'events': 'not-a-list'},
        pid, {'user_id': 2, 'username': 'alice'})
    for _ in range(10):
        await asyncio.sleep(0.02)
    assert _count('alice') == n_before, f'malformed frames must NOT persist, added {_count("alice") - n_before}'

asyncio.run(w3())
print('  ✓  three malformed frame shapes each dropped without a row')


# ── W4: handler returns immediately (fire-and-forget dispatch) ────────────────

print('\n── W4: frame handler returns immediately (no HoL block) ──')

async def w4():
    # A "big" batch — the handler still must return in ~zero time (it schedules a
    # thread + returns; the wait happens in the background task, not the caller).
    events = [_sample(f'b{i}', x=float(i)) for i in range(200)]
    frame = {'type': 'viewport', 'imageId': image_id, 'events': events}
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    ws_asgi._handle_viewport_frame(frame, pid, {'user_id': 2, 'username': 'alice'})
    dt = loop.time() - t0
    # 200ms is very generous — the real synchronous work is dict-shuffle + a task
    # create. Even a slow shared runner completes it in single-digit ms.
    assert dt < 0.2, f'handler must return immediately, took {dt:.3f}s'
    # Let the background task finish so we don't leak into the next test.
    for _ in range(100):
        await asyncio.sleep(0.02)

asyncio.run(w4())
print('  ✓  handler returned in <200ms even for a 200-sample batch')


# ── W5: REST endpoint still works via the SAME do_ core (single path) ────────

print('\n── W5: REST endpoint still green (shim + do_ core in sync) ──')

r = alice_client.post(f'/api/projects/{pid}/viewport-events',
                       json={'imageId': image_id, 'events': [_sample('r1')]})
assert r.status_code == 201, jj(r)
assert jj(r) == {'ok': True, 'count': 1}, jj(r)
print('  ✓  REST POST -> {ok:true, count:1}')


print('\n\nALL WS VIEWPORT TESTS PASSED (data dir:', TMP, ')')
