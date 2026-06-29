"""
Backend regression test for the tiling-preview origin.

The slider's preview endpoint (`GET .../images/<id>/tiles/preview`) must RECOMPUTE the
vertical grid origin for the *requested* tile_size — leaf-bbox-centered — instead of reusing
the stored import-time `origin_y` (which was computed for the default 128px tile). Otherwise
dragging the tile size to 500 keeps origin≈30 and the first row sits ~92% above the leaf.

Covers:
  P1. preview origin TRACKS tile_size (differs at two sizes; equals bbox_centered_origin_y each)
  P2. preview origin is NOT pinned to the stored import-time origin_y
  P3. an explicit origin_y query-arg still overrides the recomputed default

Run with: uv run python3 webapp/tests/test_preview_origin.py
"""

import io
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-preview-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod
from webapp import tiling, imaging

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


def _leaf_band_png(w=200, h=800, y0=300, y1=500) -> bytes:
    """A tall black image with a bright leaf BAND in the middle (not the full frame),
    so the leaf bbox is a band and bbox-centering is meaningfully different from
    image-midpoint centering."""
    arr = np.zeros((h, w), np.uint8)
    arr[y0:y1, 20:w - 20] = 210
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


def _upload(pid, name, data):
    return client.post(
        f'/api/projects/{pid}/images/upload',
        data={'files': [(io.BytesIO(data), name, 'image/png')]},
        content_type='multipart/form-data',
    )


def _preview(pid, image_id, tile_size, origin_y=None):
    q = f'tile_size={tile_size}'
    if origin_y is not None:
        q += f'&origin_y={origin_y}'
    return jdump(client.get(f'/api/projects/{pid}/images/{image_id}/tiles/preview?{q}'))


# ── setup: a project + one leaf-band image (default tile_size 128 at import) ─────
pid = jdump(client.post('/api/projects', json={'name': 'Preview origin'}))['id']
_up = _upload(pid, 'band.png', _leaf_band_png())
assert _up.status_code == 200
_up.get_data(as_text=True)   # consume the NDJSON stream so the per-file commit runs

det = jdump(client.get(f'/api/projects/{pid}'))
im = det['images'][0]
image_id = im['id']
height = im['height']
bb = tiling.Rect(im['leaf_x'], im['leaf_y'], im['leaf_w'], im['leaf_h'])
stored_origin = im['origin_y']
print(f'leaf bbox={bb}, height={height}, stored origin_y={stored_origin}')


# ── P1: preview origin tracks tile_size ─────────────────────────────────────────
print('\n── P1: preview origin tracks tile_size ──')
for ts in (200, 500):
    pv = _preview(pid, image_id, ts)
    expected = tiling.bbox_centered_origin_y(bb, height, ts)
    assert pv['originY'] == expected, f'tile {ts}: originY {pv["originY"]} != expected {expected}'
    print(f'  ✓  tile_size={ts}: originY={pv["originY"]} == bbox_centered_origin_y')

o200 = _preview(pid, image_id, 200)['originY']
o500 = _preview(pid, image_id, 500)['originY']
assert o200 != o500, f'origin should differ across tile sizes, got {o200} == {o500}'
print(f'  ✓  origin differs across tile sizes: {o200} (200) vs {o500} (500)')


# ── P2: not pinned to the stored import-time origin ─────────────────────────────
print('\n── P2: not pinned to the stored origin ──')
# At least one of the slider sizes must yield an origin different from the stored value
# (proving the preview recomputes rather than reusing img_row['origin_y']).
assert o500 != stored_origin, f'preview origin pinned to stored {stored_origin}'
print(f'  ✓  preview origin {o500} (tile 500) != stored import-time origin {stored_origin}')


# ── P3: explicit origin_y query-arg still overrides ─────────────────────────────
print('\n── P3: explicit origin_y override honored ──')
forced = _preview(pid, image_id, 500, origin_y=7)
assert forced['originY'] == 7, f'explicit origin_y override ignored: {forced["originY"]}'
print('  ✓  explicit origin_y=7 overrides the recomputed default')


# ── P4: stale stored bbox is ignored — preview recomputes from the image ─────────
# Images imported before the largest-connected-component bbox rule have a stored bbox
# that spans nearly the whole image (the old all-above-threshold span). Centering on that
# collapses origin to 0 and leaves the top row ~90% background. The preview must recompute
# the bbox from the image, so the stale stored columns must not affect the result.
print('\n── P4: stale full-image stored bbox is ignored ──')
_c = db.get_db()
_c.execute(
    'UPDATE project_image SET leaf_x=0, leaf_y=0, leaf_w=?, leaf_h=? WHERE id=?',
    (det['images'][0]['width'], height, image_id),
)
_c.commit()
db.close_db(_c)
true_bb = tiling.compute_leaf_bbox(imaging.get_image(im['image_hash'], im['image_ext']), 0)
expected = tiling.bbox_centered_origin_y(true_bb, height, 500)
got = _preview(pid, image_id, 500)['originY']
assert got == expected, f'stale stored bbox leaked into preview: got {got}, expected {expected}'
assert got != 0, 'recomputed origin should not collapse to 0 for a mid-image leaf band'
print(f'  ✓  preview origin {got} comes from the recomputed bbox, not the stale full-image one')


print('\nALL PREVIEW-ORIGIN TESTS PASSED ✓')
