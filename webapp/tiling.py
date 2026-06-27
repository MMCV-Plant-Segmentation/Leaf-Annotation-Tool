"""
Tiling geometry for the annotator's project pipeline.

These are PURE functions over plain numbers / numpy arrays — no DB, no Flask — so the
risky geometry is unit-testable in isolation and any mistaken assumption (e.g. how
`origin_y` is randomized, or how "black" tiles are detected) is cheap to correct here
without touching the endpoint or UI layers.

Concepts (see docs/Annotator Plan.md → "Tiling" and "Data model"):
  - A project has ONE tile size (`tile_size_px`, default 128) and a `black_threshold`.
  - `origin_x` is always 0; `origin_y` is randomized per image and stored, so the grid
    does not always land on the same horizontal bands.
  - A leaf image is a single contiguous bright region on a black background; its bounding
    box (`leaf_bbox`) is computed once at import and used to (a) bound the valid origin_y
    range and (b) skip all-black tiles quickly.
  - Tiles never overlap. Edge tiles (partial at the image border) are kept unless all-black.

ASSUMPTIONS worth flagging (all easy to revise — they live only in this file):
  A1. `leaf_bbox` = bounding box of ALL above-threshold pixels. The plan says "largest
      contiguous above-threshold region", but since a leaf is a single contiguous blob the
      bbox of all foreground is equivalent up to stray specks. If specks become a problem,
      swap `compute_leaf_bbox` for a connected-component version (would add a scipy dep).
  A2. A tile is "black" iff the MEAN luminance of its pixels is <= black_threshold. (Could
      instead be "fraction of bright pixels < f"; isolated here as `tile_is_black`.)
  A3. `origin_y` is drawn uniformly from [0, tile_size) clamped so at least one row of
      tiles covers the leaf. This matches "randomized within [0, leaf_h mod tile_size)" in
      spirit while staying well-defined for any leaf height.
"""

from __future__ import annotations

import random
from typing import Iterable, NamedTuple

import numpy as np
from PIL import Image


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


# ── Leaf bounding box (A1) ────────────────────────────────────────────────────

def compute_leaf_bbox(img: Image.Image, black_threshold: int) -> Rect | None:
    """Bounding box of the leaf = bbox of all pixels with luminance > black_threshold.

    Returns None if the image is entirely at/below threshold (no leaf found).
    """
    lum = _luminance_array(img)
    mask = lum > black_threshold
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)


# ── Origin randomization (A3) ─────────────────────────────────────────────────

def random_origin_y(leaf_bbox: Rect, tile_size: int, rng: random.Random | None = None) -> int:
    """Pick a random vertical grid origin so the tile grid phase varies per image.

    The grid starts at y = leaf_bbox.y - offset, offset ∈ [0, tile_size), clamped to >= 0.
    Stored on the image so a re-grid with the same params reproduces the same tiles.
    """
    rng = rng or random
    offset = rng.randrange(tile_size) if tile_size > 0 else 0
    return max(0, leaf_bbox.y - offset)


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
    right/bottom border are clipped to the image and kept (the all-black filter is applied
    separately, with the image pixels, by the caller via `tile_is_black`).
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


def tile_is_black(lum: np.ndarray, tile: Rect, black_threshold: int) -> bool:
    """A2: tile is black iff its mean luminance <= black_threshold."""
    patch = lum[tile.y:tile.y + tile.h, tile.x:tile.x + tile.w]
    if patch.size == 0:
        return True
    return float(patch.mean()) <= black_threshold


def surviving_tiles(
    img: Image.Image,
    leaf_bbox: Rect,
    tile_size: int,
    origin_y: int,
    black_threshold: int,
) -> list[Rect]:
    """Convenience: enumerate tiles then drop the all-black ones. Drives the preview slider."""
    w, h = img.size
    lum = _luminance_array(img)
    return [
        t for t in enumerate_tiles(w, h, leaf_bbox, tile_size, origin_y)
        if not tile_is_black(lum, t, black_threshold)
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
