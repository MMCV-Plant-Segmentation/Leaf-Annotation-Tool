import random
import numpy as np
from PIL import Image
from webapp.tiling import (Rect, compute_leaf_bbox, centered_origin_y,
                           enumerate_tiles, tile_is_black, surviving_tiles, sample_positions)

# Build a synthetic image: 300x200 black, with a bright leaf blob at x[40..240), y[30..170)
arr = np.zeros((200, 300), dtype=np.uint8)
arr[30:170, 40:240] = 200          # bright leaf region
img = Image.fromarray(arr, mode='L')

# 1) leaf bbox
bb = compute_leaf_bbox(img, black_threshold=50)
assert bb == Rect(40, 30, 200, 140), f'leaf bbox wrong: {bb}'
print('leaf bbox:', bb, 'OK')

# all-black image -> None
assert compute_leaf_bbox(Image.fromarray(np.zeros((10,10),np.uint8),'L'), 50) is None
print('empty image -> None OK')

# 2) origin_y = deterministic image-midpoint centre (no randomness).
#    Margin above the top row == margin below the bottom row (within 1px for odd leftover).
def _check_centered(height, tile, expected):
    oy = centered_origin_y(height, tile)
    assert oy == expected, f'centered_origin_y({height},{tile})={oy}, expected {expected}'
    leftover = height % tile
    top, bottom = oy, leftover - oy
    assert 0 <= bottom - top <= 1, f'unbalanced margins top={top} bottom={bottom}'
    return oy

# exact fit -> origin 0 (no leftover)
_check_centered(256, 64, 0)
_check_centered(200, 50, 0)
# even leftover -> split evenly (200 % 64 = 8 -> 4)
_check_centered(200, 64, 4)
# odd leftover -> floor (101 % 30 = 11 -> 5; bottom = 6)
_check_centered(101, 30, 5)
# determinism: same args -> same origin, no rng involved
assert centered_origin_y(200, 64) == centered_origin_y(200, 64)
# tile_size <= 0 guarded -> 0
assert centered_origin_y(200, 0) == 0
oy = centered_origin_y(200, 64)
print('origin_y (centered):', oy, 'OK')

# 3) enumerate tiles: non-overlapping, cover the leaf bbox, clipped to image
tiles = enumerate_tiles(300, 200, bb, tile_size=64, origin_y=oy)
# every tile within image bounds
for t in tiles:
    assert t.x >= 0 and t.y >= 0 and t.x + t.w <= 300 and t.y + t.h <= 200, f'tile OOB {t}'
# non-overlap check (pairwise)
def overlap(a,b):
    return a.x < b.x+b.w and b.x < a.x+a.w and a.y < b.y+b.h and b.y < a.y+a.h
for i in range(len(tiles)):
    for j in range(i+1, len(tiles)):
        assert not overlap(tiles[i], tiles[j]), f'tiles overlap: {tiles[i]} {tiles[j]}'
# leaf bbox fully covered by union of tiles (every leaf pixel in some tile)
covered = np.zeros((200,300), bool)
for t in tiles:
    covered[t.y:t.y+t.h, t.x:t.x+t.w] = True
leaf_mask = np.asarray(img) > 50
assert covered[leaf_mask].all(), 'some leaf pixels not covered by any tile'
print(f'enumerate: {len(tiles)} tiles, non-overlapping, cover the leaf OK')

# 4) black tiles dropped (any-above-threshold rule: a survivor has >=1 bright pixel)
surv = surviving_tiles(img, bb, 64, oy, black_threshold=50)
assert len(surv) <= len(tiles)
# a tile fully outside the leaf would be black; ensure all survivors touch bright pixels
lum = np.asarray(img)
for t in surv:
    assert (lum[t.y:t.y+t.h, t.x:t.x+t.w] > 50).any(), f'survivor has no leaf pixel: {t}'
print(f'surviving (non-black): {len(surv)} of {len(tiles)} OK')

# 4b) any-above-threshold: a 1-px sliver in an otherwise-black edge tile MUST survive
sliver = np.zeros((128, 256), np.uint8)
sliver[:, 5] = 255                       # thin vertical leaf at x=5
simg = Image.fromarray(sliver, 'L')
sbb = compute_leaf_bbox(simg, 50)
ssurv = surviving_tiles(simg, sbb, 128, 0, 50)
assert any(t.x == 0 for t in ssurv), 'sliver edge tile dropped by filter'
print('sliver edge tile survives (any-above-threshold) OK')

# 5) batch sampling: deterministic, respects exclude, caps at pool size
cands = [('img1', t.x, t.y) for t in surv]
rng2 = random.Random(7)
picked = sample_positions(cands, exclude=[cands[0]], size=3, rng=rng2)
assert len(picked) == min(3, len(cands)-1)
assert cands[0] not in picked
# size larger than pool -> returns whole pool
allp = sample_positions(cands, exclude=[], size=9999)
assert len(allp) == len(cands)
print(f'sampling: picked {len(picked)}, exclude respected OK')

print('\nALL TILING TESTS PASSED ✓')
