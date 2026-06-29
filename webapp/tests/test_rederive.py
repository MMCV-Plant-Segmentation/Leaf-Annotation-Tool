"""Backend test for the one-shot leaf-bbox re-derive maintenance (webapp/rederive_bboxes.py).

Covers:
  R1. A stale full-image stored bbox is corrected to the real leaf bbox + centered origin.
  R2. An image already tiled into a batch is SKIPPED (its stored geometry is left intact).
  R3. Idempotent — a second run changes nothing.

Run with: uv run python3 webapp/tests/test_rederive.py
"""

import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-rederive-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod, tiling, imaging
from webapp.rederive_bboxes import rederive

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


def _band_png(w=200, h=800, y0=300, y1=500) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[y0:y1, 20:w - 20] = 210
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


def _upload(pid, name, data):
    r = client.post(f'/api/projects/{pid}/images/upload',
                    data={'files': [(io.BytesIO(data), name, 'image/png')]},
                    content_type='multipart/form-data')
    r.get_data(as_text=True)  # drain the NDJSON stream so the per-file commit runs
    return r


pid = (client.post('/api/projects', json={'name': 'Rederive'}).get_json())['id']
_upload(pid, 'a.png', _band_png())
_upload(pid, 'b.png', _band_png(y0=200, y1=450))  # distinct content (dedup is by bytes)
det = client.get(f'/api/projects/{pid}').get_json()
img_a, img_b = det['images'][0], det['images'][1]
width, height = img_a['width'], img_a['height']

# Corrupt BOTH stored bboxes to the old full-image span.
con = db.get_db()
for im in (img_a, img_b):
    con.execute('UPDATE project_image SET leaf_x=0, leaf_y=0, leaf_w=?, leaf_h=?, origin_y=0 WHERE id=?',
                (width, height, im['id']))
# Tile image B (a single tile) so the re-derive must SKIP it.
con.execute("INSERT INTO tile (id, project_image_id, x, y, w, h) VALUES ('t1', ?, 0, 0, 64, 64)",
            (img_b['id'],))
con.commit()
db.close_db(con)

# ── run the re-derive ────────────────────────────────────────────────────────
con = db.get_db()
updated, skipped = rederive(con)
db.close_db(con)
print(f'updated={updated}, skipped={skipped}')
assert (updated, skipped) == (1, 1), f'expected (1 updated, 1 skipped), got ({updated},{skipped})'

# Expected corrected geometry for image A.
true_bb = tiling.compute_leaf_bbox(imaging.get_image(img_a['image_hash'], img_a['image_ext']), 0)
exp_oy = tiling.bbox_centered_origin_y(true_bb, height, 128)

con = db.get_db()
row_a = con.execute('SELECT * FROM project_image WHERE id=?', (img_a['id'],)).fetchone()
row_b = con.execute('SELECT * FROM project_image WHERE id=?', (img_b['id'],)).fetchone()
db.close_db(con)

# R1: A corrected to the real leaf bbox (not the full-image span) + centered origin.
assert (row_a['leaf_x'], row_a['leaf_y'], row_a['leaf_w'], row_a['leaf_h']) == \
       (true_bb.x, true_bb.y, true_bb.w, true_bb.h), 'image A bbox not corrected'
assert row_a['origin_y'] == exp_oy and row_a['leaf_h'] != height, 'image A origin/bbox still stale'
print('  ✓  R1: un-tiled image A re-derived to the real leaf bbox + centered origin')

# R2: B left intact (still the stale full-image span) because it is already tiled.
assert (row_b['leaf_y'], row_b['leaf_h'], row_b['origin_y']) == (0, height, 0), \
    'already-tiled image B must be left untouched'
print('  ✓  R2: already-tiled image B skipped (geometry untouched)')

# R3: idempotent.
con = db.get_db()
again = rederive(con)
db.close_db(con)
assert again == (0, 1), f'second run should update nothing, got {again}'
print('  ✓  R3: idempotent — second run updates nothing')

print('\nALL REDERIVE TESTS PASSED ✓')
