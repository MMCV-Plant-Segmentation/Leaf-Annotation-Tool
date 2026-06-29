"""
Backend acceptance tests for the upload concurrency cap (Fix 2).

Covers:
  S1. 429 when semaphore is exhausted: acquire it UPLOAD_CONCURRENCY times, then assert
      the next upload POST returns 429.
  S2. Release and retry: after releasing all slots the upload succeeds again.
  S3. Dedup still passes under the semaphore (regression guard).

Run with: uv run python3 webapp/tests/test_semaphore.py
"""

import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-sema-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod
from webapp.projects import _upload_sema, UPLOAD_CONCURRENCY

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


def _make_leaf_png(w: int = 200, h: int = 180) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[30:h - 30, 20:w - 20] = 210
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


def _upload(pid: str, files: list[tuple[str, bytes]]):
    return client.post(
        f'/api/projects/{pid}/images/upload',
        data={'files': [(io.BytesIO(b), name, 'image/png') for name, b in files]},
        content_type='multipart/form-data',
    )


# Create a project for tests.
pid = client.post('/api/projects', json={'name': 'Semaphore test'}).get_json()['id']
f1 = _make_leaf_png(200, 180)


# ── S1 & S2: exhaust the semaphore, get 429, release, succeed ─────────────────
print('\n── S1: exhaust semaphore → 429 ──')

acquired = 0
try:
    for _ in range(UPLOAD_CONCURRENCY):
        assert _upload_sema.acquire(blocking=False), 'should be able to acquire'
        acquired += 1

    r = _upload(pid, [('leaf.png', _make_leaf_png(220, 190))])
    assert r.status_code == 429, f'expected 429 when semaphore exhausted, got {r.status_code}'
    data = r.get_json()
    assert 'error' in data and 'concurrent' in data['error'], f'unexpected error body: {data}'
    print(f'  ✓  {UPLOAD_CONCURRENCY}× acquired → next upload returns 429')
finally:
    for _ in range(acquired):
        _upload_sema.release()

print('\n── S2: release → upload succeeds again ──')

r2 = _upload(pid, [('leaf2.png', _make_leaf_png(240, 200))])
assert r2.status_code == 200, f'expected 200 after releasing, got {r2.status_code}'
events = [json.loads(ln) for ln in r2.get_data(as_text=True).splitlines() if ln.strip()]
done = next(e for e in events if e['type'] == 'done')
assert done['imported'] == 1, f'expected 1 import, got {done}'
print('  ✓  after release upload succeeds and imports 1 file')


# ── S3: dedup still passes (regression guard) ─────────────────────────────────
print('\n── S3: dedup still works under the semaphore ──')

pid2 = client.post('/api/projects', json={'name': 'Dedup sema test'}).get_json()['id']
# First upload
r_a = _upload(pid2, [('leaf_d.png', f1)])
assert r_a.status_code == 200, f'first upload failed: {r_a.status_code}'
done_a = next(e for e in [json.loads(l) for l in r_a.get_data(as_text=True).splitlines() if l.strip()]
               if e['type'] == 'done')
assert done_a['imported'] == 1, f'expected 1 imported: {done_a}'
# Re-upload same bytes
r_b = _upload(pid2, [('leaf_d.png', f1)])
assert r_b.status_code == 200, f're-upload failed: {r_b.status_code}'
done_b = next(e for e in [json.loads(l) for l in r_b.get_data(as_text=True).splitlines() if l.strip()]
               if e['type'] == 'done')
assert done_b['imported'] == 0 and done_b['skipped'] == 1, f'expected skipped=1: {done_b}'
print('  ✓  dedup: first upload imports 1; re-upload skips 1')


print('\n\nALL SEMAPHORE BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
