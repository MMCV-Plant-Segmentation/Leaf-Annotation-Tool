"""BUGS #37 — small-brush geometry: `_poly_rings` must preserve sub-pixel precision.

The frontend (`canvasInteraction.ts` `toImage`) keeps full float precision when it maps
client px → image px through the CTM. The backend must not throw that precision away when it
stores the fused mask's rings, or two symptoms follow:

  1. Sub-pixel accuracy loss — every stored vertex snaps to a whole pixel, so a mark drawn at
     high zoom drifts by up to half a pixel from where the annotator painted it.
  2. Thin/vertical vanish — a stroke narrower than ~1px has its two long edges collapse onto
     the SAME integer column/row, giving a zero-area path that renders as nothing.

Fix: `_poly_rings` rounds to 2 decimal places instead of to the nearest integer. This is a
pure geometry unit test — no app/db needed.
"""
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-polyrings-test-')
os.environ['SECRET_KEY'] = 'test-secret'

from shapely.geometry import Polygon as ShapelyPolygon
from webapp.projects import _poly_rings


def _almost(a, b, tol=1e-6):
    return abs(a - b) <= tol


# ── #37.1: sub-pixel coordinates survive (not snapped to whole pixels) ────────────────
# A polygon whose vertices sit clearly between integer pixels. Every coordinate must come
# back essentially unchanged (2-dp rounding, not integer rounding).
subpixel = ShapelyPolygon([(10.25, 5.75), (30.4, 5.75), (30.4, 40.9), (10.25, 40.9)])
rings = _poly_rings(subpixel)
assert rings and rings[0], f'expected non-empty rings, got {rings!r}'
flat = [c for pt in rings[0] for c in pt]
assert any(not _almost(c, round(c)) for c in flat), \
    f'sub-pixel precision was lost — all coords are integers: {rings[0]!r}'
# and the specific values are preserved to 2dp
xs = sorted({round(pt[0], 2) for pt in rings[0]})
assert 10.25 in xs and 30.4 in xs, f'x-values not preserved: {xs!r}'
print('#37.1 OK — sub-pixel coordinates preserved:', rings[0][:2], '...')


# ── #37.2: a thin/vertical stroke does NOT collapse to zero width ─────────────────────
# A 0.3-px-wide vertical sliver. Integer rounding would snap both edges to x=10 → a zero-area
# path → the mark vanishes on the frontend. Float precision keeps the two columns distinct.
thin = ShapelyPolygon([(10.1, 4.0), (10.4, 4.0), (10.4, 120.0), (10.1, 120.0)])
rings = _poly_rings(thin)
assert rings and rings[0], f'thin stroke produced empty rings: {rings!r}'
distinct_x = {round(pt[0], 2) for pt in rings[0]}
assert len(distinct_x) >= 2, \
    f'thin stroke collapsed to a single column {distinct_x!r} — it would vanish on the FE'
print('#37.2 OK — thin vertical stroke keeps distinct columns:', sorted(distinct_x))


# ── #37.3: a tiny stroke keeps enough distinct vertices to render as an area ───────────
# A ~1.5px square. It must round-trip to a non-degenerate ring (>= 3 distinct points) so the
# frontend draws a filled shape rather than a point/line.
tiny = ShapelyPolygon([(3.2, 3.2), (4.7, 3.2), (4.7, 4.7), (3.2, 4.7)])
rings = _poly_rings(tiny)
assert rings and rings[0], f'tiny stroke produced empty rings: {rings!r}'
distinct_pts = {(round(pt[0], 2), round(pt[1], 2)) for pt in rings[0]}
assert len(distinct_pts) >= 3, \
    f'tiny stroke degenerated to {distinct_pts!r} — too few points to render an area'
print('#37.3 OK — tiny stroke keeps a renderable area:', sorted(distinct_pts))


print('\nALL #37 poly-rings precision tests passed.')
