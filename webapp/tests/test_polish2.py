"""
Backend acceptance tests for POLISH PASS 2 — leaf = largest connected component.

The leaf is the largest connected above-threshold component; everything else (stray
un-blacked specks the photographer missed at the edges) is background. Tile survival =
"the tile overlaps the leaf component", which supersedes the any-above-threshold rule.

Run with: uv run python3 webapp/tests/test_polish2.py
"""

import numpy as np
from PIL import Image
from webapp import tiling

THRESH = 40


def _img(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(arr, 'L')


# ── 1. compute_leaf_bbox returns the LARGEST component, not the union ─────────

print('\n── leaf bbox = largest connected component ──')

# 256x256 black. A big leaf blob in the middle-left, and a small detached speck
# in the bottom-right corner. The union bbox would span to the corner; the largest
# component's bbox must NOT include the speck.
arr = np.zeros((256, 256), np.uint8)
arr[40:200, 30:150] = 220          # big leaf blob (120 wide x 160 tall)
arr[250:254, 250:254] = 220        # tiny detached speck in the far corner
img = _img(arr)

bb = tiling.compute_leaf_bbox(img, THRESH)
assert bb is not None
print('  leaf bbox:', bb)
# bbox is the big blob: x≈30, y≈40, w≈120, h≈160
assert bb.x == 30 and bb.y == 40, f'bbox origin wrong: {bb}'
assert bb.w == 120 and bb.h == 160, f'bbox size wrong: {bb}'
# crucially it must NOT extend to the speck at (250,250)
assert bb.x + bb.w <= 200 and bb.y + bb.h <= 220, f'bbox swallowed the speck: {bb}'
print('  ✓  bbox is the largest component, excludes the detached speck')

# all-black image → None
assert tiling.compute_leaf_bbox(_img(np.zeros((10, 10), np.uint8)), THRESH) is None
print('  ✓  all-background image → None')


# ── 2. compute_leaf_mask returns a single connected region ───────────────────

print('\n── leaf mask ──')
mask = tiling.compute_leaf_mask(img, THRESH)
assert mask is not None and mask.shape == arr.shape
# the speck pixels are NOT in the leaf mask
assert not mask[251, 251], 'speck wrongly included in leaf mask'
# the blob pixels ARE in the leaf mask
assert mask[100, 100], 'leaf blob missing from mask'
print('  ✓  mask covers the blob, excludes the speck')


# ── 3. tile survival = overlaps the leaf component ───────────────────────────

print('\n── tile survival (overlap leaf component) ──')
surv = tiling.surviving_tiles(img, bb, tile_size=64, origin_y=bb.y, black_threshold=THRESH)
print(f'  surviving tiles: {len(surv)}')
# No surviving tile may sit entirely in the speck corner (x>=200 and y>=220)
for t in surv:
    assert not (t.x >= 200 and t.y >= 220), f'speck-corner tile survived: {t}'
# Every surviving tile actually overlaps the leaf mask
for t in surv:
    patch = mask[t.y:t.y + t.h, t.x:t.x + t.w]
    assert patch.any(), f'survivor does not overlap leaf component: {t}'
assert len(surv) > 0
print('  ✓  survivors overlap the leaf; speck tiles dropped')


# ── 4. a real thin EDGE SLIVER of the (connected) leaf still survives ────────

print('\n── edge sliver of the connected leaf survives ──')
# A leaf shaped like a tall rectangle that reaches the left image edge by a 1px sliver:
# main body x[64..200), plus a thin connected bridge at y[120..124) reaching x[0..64).
arr2 = np.zeros((256, 256), np.uint8)
arr2[40:220, 64:200] = 220         # main body
arr2[120:124, 0:64] = 220          # thin sliver bridging to the left edge (connected)
img2 = _img(arr2)
bb2 = tiling.compute_leaf_bbox(img2, THRESH)
# bbox must include the sliver → x starts at 0
assert bb2.x == 0, f'sliver not included in bbox: {bb2}'
surv2 = tiling.surviving_tiles(img2, bb2, tile_size=64, origin_y=bb2.y, black_threshold=THRESH)
# a tile covering the left edge (x==0) over the sliver rows must survive
assert any(t.x == 0 for t in surv2), 'connected edge sliver tile was dropped'
print('  ✓  connected edge sliver survives')

# Contrast: a DETACHED sliver of the same size at the edge is dropped.
arr3 = np.zeros((256, 256), np.uint8)
arr3[40:220, 64:200] = 220         # main body
arr3[120:124, 0:40] = 220          # detached sliver (gap at x[40..64))
img3 = _img(arr3)
bb3 = tiling.compute_leaf_bbox(img3, THRESH)
# largest component is the body → bbox starts at x=64, excludes detached sliver
assert bb3.x == 64, f'detached sliver wrongly included: {bb3}'
surv3 = tiling.surviving_tiles(img3, bb3, tile_size=64, origin_y=bb3.y, black_threshold=THRESH)
assert not any(t.x == 0 and t.x + t.w <= 64 for t in surv3), 'detached sliver tile survived'
print('  ✓  detached sliver dropped (only connected leaf kept)')


print('\n\nALL POLISH-2 BACKEND TESTS PASSED ✓')
