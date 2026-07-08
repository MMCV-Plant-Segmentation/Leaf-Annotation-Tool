"""
Cache of per-image "surviving tile" candidate positions, keyed by
(image_hash, tile_size, black_threshold).

ROOT CAUSE (batch-creation slowness, task #4): `create_batch` used to recompute EVERY
image's full leaf-mask connected-component analysis (tiling.surviving_tiles, which
decodes the image and runs scipy.ndimage.label over its full-resolution pixel array)
from scratch on EVERY single batch-creation call — regardless of whether the project's
tile_size/black_threshold had changed since the LAST batch, and regardless of the
requested batch `size`. On a project with hundreds/thousands of images that means
re-decoding + re-analyzing every single image just to sample a handful of NEW tile
positions for one small batch: synchronous, blocking, and, after the first call,
entirely redundant. (The "lazy shuffle" in tiling.sample_positions was never the
bottleneck — building the candidate `pool` before it even runs was.)

Memoized here, per-process, in-memory (module-level dict) — mirrors webapp.imaging's
`_img_cache` for decoded PIL images: the SAME "single dev server, one process" scaling
assumption already relied on elsewhere in this codebase (see the docstring on
webapp.projects's `_upload_sema`). No schema migration needed; keyed by content hash
(not project_image id) so it's automatically shared across projects that happen to
reference the same bytes, and a process restart just costs one recompute per image
instead of corrupting anything. Lives in its own module (not webapp.projects) so it's
unit-testable without Flask/HTTP.
"""

from __future__ import annotations

from . import imaging, tiling

_cache: dict[tuple[str, int, int], list[tiling.Rect]] = {}


def get_or_compute_tiles(image_row, tile_size: int, black_threshold: int) -> list[tiling.Rect]:
    """Candidate ("surviving") tile positions for one image at (tile_size,
    black_threshold) — memoized per (image_hash, tile_size, black_threshold) so repeat
    batch-creation calls don't re-decode + re-analyze images that haven't changed.
    `image_row` is a project_image DB row (dict-like: image_hash/image_ext/leaf_*/origin_y).
    """
    key = (image_row['image_hash'], tile_size, black_threshold)
    cached = _cache.get(key)
    if cached is not None:
        return cached

    bb = tiling.Rect(image_row['leaf_x'], image_row['leaf_y'], image_row['leaf_w'], image_row['leaf_h'])
    img = imaging.get_image(image_row['image_hash'], image_row['image_ext'])
    tiles = tiling.surviving_tiles(img, bb, tile_size, image_row['origin_y'], black_threshold)
    _cache[key] = tiles
    return tiles


def invalidate(image_hash: str) -> None:
    """Drop every cached entry for one image hash. Best-effort hygiene (e.g. on image
    removal) — a stale entry for a hash no longer referenced by any project is harmless
    (simply never looked up again), this just keeps a long-lived process's cache from
    growing on a lot of image churn."""
    for key in [k for k in _cache if k[0] == image_hash]:
        del _cache[key]
