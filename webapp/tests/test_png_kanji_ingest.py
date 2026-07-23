"""
Guard: the project image pipeline ingests a black-on-white PNG (a kanji stimulus)
end-to-end and, with tile_size >= the image, yields exactly ONE whole-image tile.

This is the t141 "PNG ingest" (P0) acceptance. The pipeline was already format-general
(PIL decode + RGB serve; ext rides through), so these tests characterise + LOCK the kanji
case rather than driving new code — the value is a regression guard for the stimulus we
actually feed the trainer.

Kanji are the INVERSE of the leaf model the tiler was written for: the leaf pipeline treats
bright pixels as content on a dark background, but a kanji is dark strokes on a WHITE
background. So the tiler's "content region" = the white background (the strokes are
"background" to it). For WHOLE-IMAGE tiling (tile_size >= image, Christian's kanji setup)
this is harmless: the background spans the image → the single tile covers the whole kanji.
K1 pins that behaviour so a future tiler change can't silently drop the kanji tile.

Covers:
  K1. tiling.surviving_tiles on a black-on-white image, tile_size >= image → one whole-image tile
  K2. upload a black-on-white PNG through the real endpoint → imported, dims stored
  K3. tiles/preview for that image → exactly one tile covering (0,0,w,h)
  K4. crop + overview serve that image back as a valid PNG

Run with: uv run python3 webapp/tests/test_png_kanji_ingest.py
"""

import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-kanji-ingest-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod, tiling

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


def _kanji_array(w: int = 512, h: int = 512) -> np.ndarray:
    """A kanji-like glyph: WHITE background (255) with a few BLACK strokes (0).

    RGB to mimic a PNG rendered from an SVG. The strokes deliberately do NOT touch the
    image border (real glyphs have margin), so the white background is one connected
    region spanning all four corners.
    """
    arr = np.full((h, w), 255, np.uint8)
    arr[120:140, 80:430] = 0          # top horizontal stroke
    arr[120:400, 250:270] = 0         # central vertical stroke
    arr[380:400, 120:390] = 0         # bottom horizontal stroke
    return arr


def _kanji_png_bytes(w: int = 512, h: int = 512) -> bytes:
    rgb = np.stack([_kanji_array(w, h)] * 3, axis=-1)
    buf = io.BytesIO()
    Image.fromarray(rgb, 'RGB').save(buf, format='PNG')
    return buf.getvalue()


def _upload(pid: str, files: list[tuple[str, bytes]]):
    return client.post(
        f'/api/projects/{pid}/images/upload',
        data={'files': [(io.BytesIO(b), name, 'image/png') for name, b in files]},
        content_type='multipart/form-data',
    )


def _parse_ndjson(resp) -> list[dict]:
    return [json.loads(ln) for ln in resp.get_data(as_text=True).splitlines() if ln.strip()]


# ── K1: pure tiling — black-on-white, tile >= image → one whole-image tile ──────
print('\n── K1: tiling a black-on-white glyph → one whole-image tile ──')

W = H = 512
threshold = 10
img = Image.fromarray(_kanji_array(W, H), 'L')

bb = tiling.compute_leaf_bbox(img, threshold)
assert bb is not None, 'white background should be detected as foreground (non-None bbox)'
# The white background spans the image, so its bbox is the whole image.
assert (bb.x, bb.y, bb.w, bb.h) == (0, 0, W, H), f'expected whole-image bbox, got {bb}'

tile_size = 4096  # >= image on both axes → one tile
origin_y = tiling.bbox_centered_origin_y(bb, H, tile_size)
assert origin_y == 0, f'origin_y should clamp to 0 for tile_size >= image, got {origin_y}'

surv = tiling.surviving_tiles(img, bb, tile_size, origin_y, threshold)
assert len(surv) == 1, f'expected exactly one tile, got {len(surv)}: {surv}'
assert (surv[0].x, surv[0].y, surv[0].w, surv[0].h) == (0, 0, W, H), \
    f'the single tile must cover the whole image, got {surv[0]}'
print('  ✓  one tile == whole image (0,0,512,512); the kanji stimulus is not dropped')


# ── K2: upload a black-on-white PNG end-to-end ─────────────────────────────────
print('\n── K2: upload a kanji PNG → imported, dims stored ──')

pid = jdump(client.post('/api/projects', json={
    'name': 'Kanji ingest', 'tile_size_px': tile_size, 'black_threshold': threshold,
}))['id']

png = _kanji_png_bytes(W, H)
resp = _upload(pid, [('kanji_ichi.png', png)])
assert resp.status_code == 200, f'status {resp.status_code}: {resp.get_data(as_text=True)[:200]}'
done = next(e for e in _parse_ndjson(resp) if e['type'] == 'done')
assert done['imported'] == 1, f'kanji PNG should import, got {done}'
assert done['errors'] == [], f'no decode errors expected, got {done["errors"]}'

det = jdump(client.get(f'/api/projects/{pid}'))
imgs = det['images']
assert len(imgs) == 1, f'exactly one image, got {len(imgs)}'
image_id = imgs[0]['id']
assert (imgs[0]['width'], imgs[0]['height']) == (W, H), \
    f'stored dims wrong: {imgs[0]["width"]}x{imgs[0]["height"]}'
assert imgs[0]['source_name'] == 'kanji_ichi.png'
print('  ✓  kanji PNG imported; 512x512 dims stored; source_name preserved')


# ── K3: preview → exactly one whole-image tile ─────────────────────────────────
print('\n── K3: tiles/preview → one whole-image tile ──')

pv = jdump(client.get(f'/api/projects/{pid}/images/{image_id}/tiles/preview'))
assert pv['imageWidth'] == W and pv['imageHeight'] == H, f'preview dims wrong: {pv}'
assert len(pv['tiles']) == 1, f'expected one tile in preview, got {len(pv["tiles"])}: {pv["tiles"]}'
t = pv['tiles'][0]
assert (t['x'], t['y'], t['w'], t['h']) == (0, 0, W, H), f'preview tile not whole-image: {t}'
print('  ✓  preview yields a single tile covering the whole kanji')


# ── K4: crop + overview serve the PNG back ─────────────────────────────────────
print('\n── K4: crop + overview serve valid PNG ──')

crop = client.get(f'/api/projects/images/{image_id}/crop', query_string={'x': 0, 'y': 0, 'w': W, 'h': H})
assert crop.status_code == 200, f'crop status {crop.status_code}'
assert crop.mimetype == 'image/png', f'crop mimetype {crop.mimetype}'
cimg = Image.open(io.BytesIO(crop.get_data()))
assert cimg.size == (W, H), f'crop size {cimg.size}'
# The served crop must still carry the black strokes (content preserved, not blanked).
carr = np.asarray(cimg.convert('L'))
assert carr.min() < 40, 'served crop lost the black strokes'
assert carr.max() > 200, 'served crop lost the white background'
print('  ✓  crop serves a valid 512x512 PNG with strokes + background intact')

ov = client.get(f'/api/projects/images/{image_id}/overview')
assert ov.status_code == 200, f'overview status {ov.status_code}'
assert ov.mimetype == 'image/png', f'overview mimetype {ov.mimetype}'
oimg = Image.open(io.BytesIO(ov.get_data()))
assert oimg.size == (W, H), f'overview size {oimg.size} (<=2000 long side, unscaled here)'
print('  ✓  overview serves a valid PNG')


print('\n\nALL PNG-KANJI-INGEST TESTS PASSED ✓  (data dir:', TMP, ')')
