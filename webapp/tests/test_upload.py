"""
Backend acceptance tests for the browser-upload endpoint.

Covers:
  U1. NDJSON event stream: start / file / done sequence
  U2. Imported count + provenance (source_name == filename; source_path NULL for uploads)
  U3. Dedup: same bytes → skipped, not re-imported
  U4. Mixed batch: bad file reported per-file, not fatal; good file still imported
  U5. Existing path-import still works (refactor must not break it)

Run with: uv run python3 webapp/tests/test_upload.py
"""

import io
import json
import os
import tempfile
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='leaf-anno-upload-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

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


def _make_leaf_png_bytes(w: int = 200, h: int = 180) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[30:h - 30, 20:w - 20] = 210
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


def _upload(pid: str, files: list[tuple[str, bytes]]):
    """POST multipart upload. files: list of (filename, bytes) tuples."""
    return client.post(
        f'/api/projects/{pid}/images/upload',
        data={'files': [(io.BytesIO(b), name, 'image/png') for name, b in files]},
        content_type='multipart/form-data',
    )


def _parse_ndjson(resp) -> list[dict]:
    return [json.loads(ln) for ln in resp.get_data(as_text=True).splitlines() if ln.strip()]


# create a project for most tests
pid = jdump(client.post('/api/projects', json={'name': 'Upload test'}))['id']


# ── U1: NDJSON event stream ────────────────────────────────────────────────────
print('\n── U1: NDJSON event stream ──')

f1 = _make_leaf_png_bytes(200, 180)
f2 = _make_leaf_png_bytes(220, 160)

resp = _upload(pid, [('leaf_a.png', f1), ('leaf_b.png', f2)])
assert resp.status_code == 200, f'status {resp.status_code}: {resp.get_data(as_text=True)[:200]}'

events = _parse_ndjson(resp)
types = [e['type'] for e in events]
print(f'  event types: {types}')

start_evs = [e for e in events if e['type'] == 'start']
file_evs  = [e for e in events if e['type'] == 'file']
done_evs  = [e for e in events if e['type'] == 'done']

assert len(start_evs) == 1, 'exactly one start event'
assert start_evs[0]['total'] == 2, f'start.total should be 2, got {start_evs[0]["total"]}'
assert len(file_evs) == 2, f'one file event per file, got {len(file_evs)}'
assert len(done_evs) == 1, 'exactly one done event'
for ev in file_evs:
    assert 'name' in ev and 'path' in ev, f'file event missing name/path: {ev}'
print('  ✓  start(total=2) + 2 file events + done; each file event has name+path')


# ── U2: imported count + provenance ───────────────────────────────────────────
print('\n── U2: imported count + provenance ──')

done_ev = done_evs[0]
assert done_ev['imported'] == 2, f'done.imported should be 2, got {done_ev["imported"]}'
assert done_ev['skipped'] == 0, f'done.skipped should be 0, got {done_ev["skipped"]}'
assert done_ev['errors'] == [], f'no errors expected, got {done_ev["errors"]}'
print('  ✓  done summary: imported=2, skipped=0, errors=[]')

det = jdump(client.get(f'/api/projects/{pid}'))
source_names = {im['source_name'] for im in det['images']}
source_paths = {im['source_path'] for im in det['images']}
assert 'leaf_a.png' in source_names, f'source_name missing: {source_names}'
assert 'leaf_b.png' in source_names, f'source_name missing: {source_names}'
# Uploads have no server-side original location → source_path is NULL (not the filename).
assert source_paths == {None}, f'upload source_path should be NULL: {source_paths}'
print('  ✓  source_name == filename; source_path is NULL for uploads')

# File events carry the original filename as both name and path
names_in_events = {e['name'] for e in file_evs if e.get('ok')}
assert 'leaf_a.png' in names_in_events and 'leaf_b.png' in names_in_events
print('  ✓  file events carry the original filename')


# ── U3: dedup (same bytes → skipped) ──────────────────────────────────────────
print('\n── U3: dedup ──')

resp2 = _upload(pid, [('leaf_a.png', f1), ('leaf_b.png', f2)])
events2 = _parse_ndjson(resp2)
done2 = next(e for e in events2 if e['type'] == 'done')
assert done2['imported'] == 0, f're-upload should skip all, got {done2["imported"]}'
assert done2['skipped'] == 2, f're-upload skipped should be 2, got {done2["skipped"]}'
# file count in DB unchanged
det2 = jdump(client.get(f'/api/projects/{pid}'))
assert len(det2['images']) == 2, f'image count should still be 2, got {len(det2["images"])}'
print('  ✓  same bytes re-uploaded → all skipped; DB count unchanged')


# ── U4: bad file reported per-file, not fatal ─────────────────────────────────
print('\n── U4: bad file → per-file error, not fatal ──')

f_good = _make_leaf_png_bytes(260, 220)
f_bad  = b'not a real png file'

pid2 = jdump(client.post('/api/projects', json={'name': 'Upload bad test'}))['id']
resp3 = _upload(pid2, [('good.png', f_good), ('bad.png', f_bad)])
events3 = _parse_ndjson(resp3)
done3 = next(e for e in events3 if e['type'] == 'done')
file_evs3 = [e for e in events3 if e['type'] == 'file']
bad_ev  = next(e for e in file_evs3 if e['name'] == 'bad.png')
good_ev = next(e for e in file_evs3 if e['name'] == 'good.png')

assert done3['imported'] == 1, f'only good file imported, got {done3["imported"]}'
assert len(done3['errors']) == 1, f'one error recorded, got {done3["errors"]}'
assert not bad_ev['ok'], 'bad file event should have ok=False'
assert good_ev.get('ok'), 'good file event should have ok=True'
print('  ✓  bad file → per-file error; good file still imported; batch not aborted')


# ── U5: existing path-import unbroken (refactor regression guard) ─────────────
print('\n── U5: path-import regression guard ──')

src = Path(TMP) / 'regress_src'
sub = src / 'sub'
sub.mkdir(parents=True)
for n, (w, h) in enumerate([(200, 180), (220, 160), (240, 200)]):
    arr = np.zeros((h, w), np.uint8)
    arr[20:h - 20, 20:w - 20] = 210
    Image.fromarray(arr, 'L').save(str((src if n == 0 else sub) / f'regr{n}.png'))

pid3 = jdump(client.post('/api/projects', json={'name': 'Regress test'}))['id']
r = client.post(f'/api/projects/{pid3}/images/import', json={'path': str(src)})
assert r.status_code == 200, f'path import failed: {r.status_code}'
imp = jdump(r)
assert imp['imported'] == 3, f'Expected 3, got {imp["imported"]}'
det3 = jdump(client.get(f'/api/projects/{pid3}'))
# source_path = full server path for disk imports
p0 = str(src / 'regr0.png')
assert any(im['source_path'] == p0 for im in det3['images']), \
    f'full server path not stored: {[im["source_path"] for im in det3["images"]]}'
print('  ✓  path-import still works; full server path stored in source_path')

# Re-import → skipped
r2 = client.post(f'/api/projects/{pid3}/images/import', json={'path': str(src)})
assert jdump(r2)['skipped'] == 3, 'path re-import should skip all 3'
print('  ✓  path re-import → all skipped (idempotent)')


print('\n\nALL UPLOAD BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
