"""Backend coverage for webapp.tile_cache — the create_batch memoization (task #4).

The regression it guards: create_batch used to re-decode + re-run surviving_tiles
(scipy connected components) for EVERY image on EVERY batch call. tile_cache memoizes
those candidate positions by (image_hash, tile_size, black_threshold), so repeat calls
on unchanged inputs do zero recompute. We assert that by monkeypatching the two
expensive callees (imaging.get_image, tiling.surviving_tiles) into call-counters — no
real image decoding needed — and checking exactly when they fire.
"""
from webapp import tile_cache
from webapp.tiling import Rect

# ── monkeypatch the expensive callees into counters ───────────────────────────
calls = {'get_image': 0, 'surviving': 0}
_sentinel = [Rect(0, 0, 64, 64), Rect(64, 0, 64, 64)]


def _fake_get_image(image_hash, image_ext):
    calls['get_image'] += 1
    return object()  # opaque; the fake surviving_tiles ignores it


def _fake_surviving(img, bb, tile_size, origin_y, black_threshold):
    calls['surviving'] += 1
    # distinct list per (tile_size, threshold) so a cache MISS is observably different
    return [Rect(tile_size, black_threshold, 64, 64)]


tile_cache.imaging.get_image = _fake_get_image
tile_cache.tiling.surviving_tiles = _fake_surviving
tile_cache._cache.clear()

ROW = {'image_hash': 'abc123', 'image_ext': 'png',
       'leaf_x': 0, 'leaf_y': 0, 'leaf_w': 128, 'leaf_h': 128, 'origin_y': 0}

# 1) first call computes (both callees fire exactly once)
first = tile_cache.get_or_compute_tiles(ROW, tile_size=64, black_threshold=10)
assert calls == {'get_image': 1, 'surviving': 1}, calls
print('first call computes (1 decode + 1 analysis) OK')

# 2) same key -> cache HIT: no additional work, and the SAME cached object comes back
second = tile_cache.get_or_compute_tiles(ROW, tile_size=64, black_threshold=10)
assert calls == {'get_image': 1, 'surviving': 1}, f'cache miss on repeat: {calls}'
assert second is first, 'cache returned a different object'
print('repeat call is a cache hit (zero recompute) OK')

# 3) a DIFFERENT tile_size is a genuine miss -> recompute
tile_cache.get_or_compute_tiles(ROW, tile_size=128, black_threshold=10)
assert calls == {'get_image': 2, 'surviving': 2}, f'tile_size change not a miss: {calls}'
print('different tile_size -> recompute OK')

# 4) a DIFFERENT black_threshold is also a miss
tile_cache.get_or_compute_tiles(ROW, tile_size=64, black_threshold=99)
assert calls == {'get_image': 3, 'surviving': 3}, f'threshold change not a miss: {calls}'
print('different black_threshold -> recompute OK')

# 5) invalidate(hash) drops every entry for that hash -> next call recomputes
tile_cache.invalidate('abc123')
assert not any(k[0] == 'abc123' for k in tile_cache._cache), 'invalidate left entries'
tile_cache.get_or_compute_tiles(ROW, tile_size=64, black_threshold=10)
assert calls == {'get_image': 4, 'surviving': 4}, f'invalidate did not force recompute: {calls}'
print('invalidate() forces recompute OK')

# 6) a different image_hash is independent (own key)
tile_cache.get_or_compute_tiles({**ROW, 'image_hash': 'zzz999'}, tile_size=64, black_threshold=10)
assert calls == {'get_image': 5, 'surviving': 5}, calls
print('distinct image_hash is a distinct key OK')

print('\nALL TILE_CACHE TESTS PASSED ✓')
