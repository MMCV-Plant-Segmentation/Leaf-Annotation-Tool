"""
Tiling geometry for the annotator's project pipeline.

These are PURE functions over plain numbers / numpy arrays — no DB, no Flask — so the
risky geometry is unit-testable in isolation and any mistaken assumption (e.g. how
`origin_y` is chosen, or how "black" tiles are detected) is cheap to correct here
without touching the endpoint or UI layers.

Concepts (see docs/Annotator Plan.md → "Tiling" and "Data model"):
  - A project has ONE tile size (`tile_size_px`, default 128) and a `black_threshold`.
  - `origin_x` is always 0; `origin_y` centres the tile grid on the LEAF BBOX, so the
    background split is balanced between the leaf's top and bottom edge rows (no random phase).
  - A leaf image is a single contiguous bright region on a black background; its bounding
    box (`leaf_bbox`) is computed once at import and used to (a) bound the valid origin_y
    range and (b) skip all-black tiles quickly.
  - Tiles never overlap. Edge tiles (partial at the image border) are kept unless all-black.

ASSUMPTIONS worth flagging (all easy to revise — they live only in this file):
  A1. The leaf = the LARGEST connected above-threshold component (`scipy.ndimage.label`);
      `leaf_bbox` is that component's bounding box. A leaf image is a single contiguous
      bright region, so the biggest connected blob IS the leaf; stray un-blacked specks the
      photographer missed at the edges are separate, smaller components and are excluded.
  A2. A tile is "black"/background iff it does NOT overlap the leaf component mask
      (`tile_is_black(leaf_mask, tile)`). Real edge slivers of the leaf (connected to the
      body) keep their tile; disconnected specks do not. Supersedes the earlier
      any-above-threshold rule, which kept specks.
  A3. `origin_y = bbox_centered_origin_y(leaf_bbox, image_height, tile_size)` — the grid is
      sized to the leaf (ceil(bbox.h/tile_size) rows) and centred on the leaf bbox, clamped
      >= 0 (deterministic, no RNG). This REPLACES the earlier image-midpoint origin (which
      barely helped, since the leaf is only a band in the image). Target (deferred, needs a
      mask): centre on the leaf centroid instead of the bbox centre.
"""

from __future__ import annotations

import random
from typing import Iterable, NamedTuple

import numpy as np
from PIL import Image
from scipy import ndimage


class Rect(NamedTuple):
    x: int
    y: int
    w: int
    h: int

    def as_dict(self) -> dict:
        return {'x': self.x, 'y': self.y, 'w': self.w, 'h': self.h}


# ── Luminance ─────────────────────────────────────────────────────────────────

def _luminance_array(img: Image.Image) -> np.ndarray:
    """Return an HxW uint8 grayscale array (mode 'L') for luminance tests."""
    if img.mode != 'L':
        img = img.convert('L')
    return np.asarray(img, dtype=np.uint8)


# ── Leaf component + bounding box (A1) ────────────────────────────────────────

def compute_leaf_mask(img: Image.Image, black_threshold: int) -> np.ndarray | None:
    """Boolean mask of the leaf = the LARGEST connected above-threshold component.

    Uses scipy.ndimage.label (4-connectivity) to find connected components of the
    foreground (luminance > black_threshold) and returns a mask of the biggest one.
    Returns None if there is no foreground at all. Stray edge specks — separate, smaller
    components — are excluded.
    """
    lum = _luminance_array(img)
    fg = lum > black_threshold
    if not fg.any():
        return None
    labels, n = ndimage.label(fg)
    if n == 0:
        return None
    # Largest component by pixel count, ignoring the background label (0).
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    largest = int(counts.argmax())
    return labels == largest


def compute_leaf_bbox(img: Image.Image, black_threshold: int) -> Rect | None:
    """Bounding box of the leaf = bbox of the largest connected component.

    Returns None if the image is entirely at/below threshold (no leaf found).
    """
    mask = compute_leaf_mask(img, black_threshold)
    if mask is None:
        return None
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)


# ── Centered origin (A3) ──────────────────────────────────────────────────────

def bbox_centered_origin_y(leaf_bbox: Rect, image_height: int, tile_size: int) -> int:
    """Deterministic vertical grid origin that centres the tile grid on the LEAF BBOX.

    The leaf is only a band within the image, so centring the grid on the image midpoint
    barely helps — at a large tile size the top row still lands almost entirely above the
    leaf. Instead, size the grid to the leaf and centre it on the bbox:
        n_rows  = ceil(bbox.h / tile_size)   (min 1)
        grid_h  = n_rows * tile_size
        origin  = round((bbox vertical centre) − grid_h / 2)
    then clamp `origin >= 0` (mask/array indexing needs a non-negative y). This balances
    the background split between the leaf's top and bottom edge rows. Pure + deterministic
    (same bbox + height + tile_size → same origin), so re-tiling is stable. `image_height`
    is accepted for API symmetry / future bottom-clamping; it is not needed for centring.

    `origin_x` stays 0 for now (Christian's pain is vertical). Horizontal centring would
    need a new `origin_x` column — a possible follow-up, not built here.

    TARGET (deferred): centre on the leaf *centroid* via the optional per-image mask.
    Bbox-centring is the interim better-than-image-midpoint upgrade (the bbox is already
    computed at import via `compute_leaf_bbox`).
    """
    if tile_size <= 0:
        return 0
    n_rows = max(1, -(-leaf_bbox.h // tile_size))      # ceil(bbox.h / tile_size), min 1
    grid_h = n_rows * tile_size
    bbox_center = leaf_bbox.y + leaf_bbox.h / 2
    origin = round(bbox_center - grid_h / 2)
    return max(0, int(origin))


# ── Tile enumeration ──────────────────────────────────────────────────────────

def enumerate_tiles(
    image_w: int,
    image_h: int,
    leaf_bbox: Rect,
    tile_size: int,
    origin_y: int,
) -> list[Rect]:
    """All tile rectangles (non-overlapping, full bbox stored) that intersect the leaf bbox.

    origin_x is always 0. Tiles step by tile_size from (0, origin_y). Edge tiles at the
    right/bottom border are clipped to the image and kept (the leaf-overlap filter is
    applied separately, against the leaf component mask, by `surviving_tiles`).
    """
    if tile_size <= 0:
        raise ValueError('tile_size must be positive')

    lb_x0, lb_y0 = leaf_bbox.x, leaf_bbox.y
    lb_x1, lb_y1 = leaf_bbox.x + leaf_bbox.w, leaf_bbox.y + leaf_bbox.h

    tiles: list[Rect] = []
    y = origin_y
    while y < image_h and y < lb_y1:
        if y + tile_size > origin_y:  # always true; keeps shape obvious
            x = 0
            while x < image_w and x < lb_x1:
                tx, ty = x, y
                tw = min(tile_size, image_w - x)
                th = min(tile_size, image_h - y)
                # keep only tiles that actually overlap the leaf bbox horizontally+vertically
                if tx < lb_x1 and tx + tw > lb_x0 and ty < lb_y1 and ty + th > lb_y0:
                    tiles.append(Rect(tx, ty, tw, th))
                x += tile_size
        y += tile_size
    return tiles


def tile_is_black(leaf_mask: np.ndarray, tile: Rect) -> bool:
    """A tile is background ("black") iff it does NOT overlap the leaf component mask.

    `leaf_mask` is the largest-connected-component mask from `compute_leaf_mask`. A tile
    that touches even one leaf-component pixel survives (real edge slivers are kept);
    tiles over disconnected specks have no overlap and are dropped.
    """
    patch = leaf_mask[tile.y:tile.y + tile.h, tile.x:tile.x + tile.w]
    if patch.size == 0:
        return True
    return not bool(patch.any())


def surviving_tiles(
    img: Image.Image,
    leaf_bbox: Rect,
    tile_size: int,
    origin_y: int,
    black_threshold: int,
) -> list[Rect]:
    """Enumerate tiles then keep only those overlapping the leaf component. Drives the preview."""
    w, h = img.size
    leaf_mask = compute_leaf_mask(img, black_threshold)
    if leaf_mask is None:
        return []
    return [
        t for t in enumerate_tiles(w, h, leaf_bbox, tile_size, origin_y)
        if not tile_is_black(leaf_mask, t)
    ]


# ── Batch sampling ────────────────────────────────────────────────────────────

def sample_positions(
    candidates: list,
    exclude: Iterable,
    size: int,
    rng: random.Random | None = None,
) -> list:
    """Uniformly draw up to `size` items from candidates, skipping any in `exclude`.

    `candidates` are opaque to this function (the caller decides what a "position" is —
    typically a (project_image_id, x, y) key). Returns fewer than `size` only when the
    remaining pool is smaller. Pure + deterministic given an rng seed → easy to test.
    """
    rng = rng or random
    exclude_set = set(exclude)
    pool = [c for c in candidates if c not in exclude_set]
    if size >= len(pool):
        return list(pool)
    return rng.sample(pool, size)
