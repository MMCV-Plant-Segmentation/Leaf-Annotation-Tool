import random
import numpy as np
from PIL import Image
from webapp.tiling import (Rect, compute_leaf_bbox, bbox_centered_origin_y,
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

# 2) origin_y = deterministic LEAF-BBOX centre (no randomness). The grid is sized to the
#    leaf (ceil(bbox.h/tile) rows) and centred on the bbox; top/bottom background margins
#    around the leaf are balanced within 1px (unless the origin clamps to 0 near the top).
def _margins(bb, tile, oy):
    n_rows = max(1, -(-bb.h // tile))
    grid_h = n_rows * tile
    top = bb.y - oy                         # background above the leaf inside the grid
    bottom = (oy + grid_h) - (bb.y + bb.h)  # background below the leaf inside the grid
    return top, bottom

# main: leaf bbox of the synthetic image (Rect(40,30,200,140)), centred at y=100.
oy = bbox_centered_origin_y(bb, 200, 64)
# ceil(140/64)=3 rows, grid_h=192; origin=round(100-96)=4
assert oy == 4, f'expected 4, got {oy}'
top, bottom = _margins(bb, 64, oy)
assert abs(top - bottom) <= 1 and top >= 0, f'unbalanced margins top={top} bottom={bottom}'

# determinism: same args -> same origin, no rng involved
assert bbox_centered_origin_y(bb, 200, 64) == bbox_centered_origin_y(bb, 200, 64)

# edge: leaf SHORTER than one tile -> single row centred on the leaf
small = Rect(0, 100, 10, 50)
o_small = bbox_centered_origin_y(small, 400, 128)   # n_rows=1, grid_h=128, c=125 -> 61
assert o_small == 61, f'leaf<tile expected 61, got {o_small}'
t2, b2 = _margins(small, 128, o_small)
assert abs(t2 - b2) <= 1, f'leaf<tile margins unbalanced: {t2} {b2}'

# edge: leaf near the image TOP -> origin clamps to 0 (never negative)
top_leaf = Rect(0, 10, 10, 140)
assert bbox_centered_origin_y(top_leaf, 400, 64) == 0, 'near-top leaf must clamp origin to 0'

# edge: EXACT fit (grid_h == bbox.h) -> origin == bbox.y, margins both 0
exact = Rect(0, 50, 10, 128)
o_exact = bbox_centered_origin_y(exact, 400, 64)    # n_rows=2, grid_h=128 == bbox.h
assert o_exact == 50, f'exact-fit expected origin==bbox.y(50), got {o_exact}'
assert _margins(exact, 64, o_exact) == (0, 0), 'exact fit should have zero margins'

# edge: tile_size <= 0 guarded -> 0
assert bbox_centered_origin_y(bb, 200, 0) == 0
print('origin_y (bbox-centered):', oy, 'OK')

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
