"""
TDD spec (Opus-written) for the 2026-07-09 testing-round fixes. These FAIL on the current code and
define the required behavior; the implementer makes them pass WITHOUT editing this file.

Covers:
  A. GET /overview and /crop return 404 (not 500) when the image BLOB is missing on disk (the
     `--data-mode restore`-with-stale-file-mirror scenario that 500'd for every user).
  B. Viewport telemetry is NOT recorded for an admin session (create_viewport_events returns count 0
     and stores nothing), but IS recorded for a real annotator.
  C. REGRESSION GUARD (the luna catastrophe): the admin-skip must live ONLY in create_viewport_events.
     Admin must still be able to create a project, update it, and add an annotator — these must NOT be
     no-op'd by a stray admin guard. (A guard leaked into these endpoints is exactly what got rejected.)

Run: uv run python3 webapp/tests/test_admin_safety.py
"""

import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-admin-safety-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import io
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
app.testing = True

admin = app.test_client()
with admin.session_transaction() as s:
    s['user_id'] = 1; s['username'] = 'admin'
alice = app.test_client()
with alice.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'


def jj(r):
    return r.get_json()


def _leaf_png(w=200, h=200):
    arr = np.zeros((h, w), np.uint8)
    arr[20:h - 20, 20:w - 20] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: admin owns a project + one uploaded image ──────────────────────────
print('\n── Setup ──')
r = admin.post('/api/projects', json={'name': 'AdminSafety', 'tile_size_px': 256})
assert r.status_code == 201, jj(r)
pid = jj(r)['id']

r = admin.post(
    f'/api/projects/{pid}/images/upload',
    data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
    content_type='multipart/form-data',
)
r.get_data()
assert r.status_code == 200, jj(r)
det = jj(admin.get(f'/api/projects/{pid}'))
image_id = det['images'][0]['id']
print(f'  project {pid}, image {image_id}')


# ── A. Missing blob -> 404, not 500 ───────────────────────────────────────────
print('\n── A: missing image blob -> 404 ──')
con = db.get_db()
row = con.execute('SELECT image_hash, image_ext FROM project_image WHERE id = ?', (image_id,)).fetchone()
db.close_db(con)
blob = os.path.join(TMP, 'images', f"{row['image_hash']}.{row['image_ext']}")
assert os.path.exists(blob), f'expected blob at {blob}'
os.remove(blob)  # simulate the stale-file-mirror restore: DB row present, file gone
# The upload decoded + CACHED the image in-process; a fresh restored server has no such cache. Clear
# it so we hit the real missing-file path (what 500'd on the restored deployment).
from webapp import imaging
imaging._img_cache.clear()

r = admin.get(f'/api/projects/images/{image_id}/overview')
assert r.status_code == 404, f'overview: expected 404 on a missing blob, got {r.status_code}'
r = admin.get(f'/api/projects/images/{image_id}/crop?x=0&y=0&w=50&h=50')
assert r.status_code == 404, f'crop: expected 404 on a missing blob, got {r.status_code}'
print('  ✓  overview + crop return 404 (not 500) when the blob is gone')


# ── B. Admin telemetry NOT recorded; annotator telemetry IS ───────────────────
print('\n── B: viewport telemetry admin-skip ──')
ev = {'clientTs': 1, 'x': 0, 'y': 0, 'w': 10, 'h': 10, 'cssW': 100, 'cssH': 100, 'dpr': 1}

r = admin.post(f'/api/projects/{pid}/viewport-events', json={'imageId': image_id, 'events': [ev]})
assert r.status_code in (200, 201), jj(r)
assert jj(r).get('count') == 0, f'admin telemetry must NOT be recorded, got count={jj(r).get("count")}'

# A MALFORMED admin body still 400s — validation runs BEFORE the admin no-op (not a blanket early return).
r = admin.post(f'/api/projects/{pid}/viewport-events', json={'imageId': image_id})  # events missing
assert r.status_code == 400, f'admin malformed body must 400 (validate before no-op), got {r.status_code}'

# alice must be a project member to record — add her, then she records.
r = admin.post(f'/api/projects/{pid}/annotators', json={'user_id': 2})
assert r.status_code == 201, jj(r)
r = alice.post(f'/api/projects/{pid}/viewport-events', json={'imageId': image_id, 'events': [ev, ev]})
assert r.status_code in (200, 201), jj(r)
assert jj(r).get('count') == 2, f'annotator telemetry must be recorded, got count={jj(r).get("count")}'

con = db.get_db()
n_admin = con.execute("SELECT COUNT(*) c FROM viewport_event WHERE user_id = 'admin'").fetchone()['c']
n_alice = con.execute("SELECT COUNT(*) c FROM viewport_event WHERE user_id = 'alice'").fetchone()['c']
db.close_db(con)
assert n_admin == 0, f'admin must have 0 stored viewport rows, got {n_admin}'
assert n_alice == 2, f'alice must have 2 stored viewport rows, got {n_alice}'
print('  ✓  admin records nothing (count 0, 0 rows); annotator records normally')


# ── C. REGRESSION GUARD: admin core flows must still work ──────────────────────
print('\n── C: admin core flows NOT broken by the telemetry guard ──')
r = admin.post('/api/projects', json={'name': 'AdminStillWorks', 'tile_size_px': 256})
assert r.status_code == 201 and 'id' in jj(r), f'admin must still CREATE projects, got {r.status_code}: {jj(r)}'
pid2 = jj(r)['id']

r = admin.patch(f'/api/projects/{pid2}', json={'name': 'Renamed'})
assert r.status_code == 200, f'admin must still UPDATE projects, got {r.status_code}: {jj(r)}'

r = admin.post(f'/api/projects/{pid2}/annotators', json={'user_id': 2})
assert r.status_code == 201, f'admin must still ADD annotators, got {r.status_code}: {jj(r)}'
print('  ✓  admin can still create/update projects + add annotators (no stray guard)')


print('\n\nALL ADMIN-SAFETY TESTS PASSED ✓  (data dir:', TMP, ')')
