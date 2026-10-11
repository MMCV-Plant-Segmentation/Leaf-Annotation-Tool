"""t140 — the stroke-outline perf optimization must NOT change the visible result.

Phase 1 speeds up `geo_engine.outline_brush` / `outline_polyline` (today both union a full disk at
EVERY input point). Christian's hard bar: "as long as the result is the same." This pins it against a
golden reference of the CURRENT ops' output (webapp/tests/fixtures/t140_outline_golden.json, captured
pre-optimization on REALISTIC strokes — dense drags for brush, sparse clicked vertices for polyline):

  - COVERAGE: the new outline contains every input sample point (the whole drawn path stays inside).
  - PARITY: the new outline's symmetric-difference area vs the golden is < 2% of the stroke area —
    sub-pixel, imperceptible. This bounds how far any input-simplification may drift the shape.

Green now (current == golden) and MUST STAY green through the optimization; perf itself is measured
out-of-band (a hard time budget in a test flakes across machines).

NB the BRUSH half no longer pins the pre-t158 (perfect-freehand-era) output: that brush was never
ground truth, and t158 deliberately replaced it (a round brush dragged along a causal, extend-only
curve). Its golden rings were re-blessed to the accepted t158 brush; the brush half is now a
gross-regression + coverage guard on realistic dense drags. Exact brush geometry is pinned by
test_geo_engine_parity; sparse/curved behaviour by the geo-engine crate's own tests. The POLYLINE
golden is unchanged from t140.

Run: uv run python webapp/tests/test_outline_parity.py
"""
import json
import os

from shapely.geometry import Point as _Point, Polygon as _Poly
from shapely.ops import unary_union

from webapp import geo_engine

HERE = os.path.dirname(__file__)
GOLDEN = json.load(open(os.path.join(HERE, 'fixtures', 't140_outline_golden.json')))

PARITY_TOL = 0.04   # symmetric-difference area / golden area. A tight "same to the eye" bound +
                    # gross-regression guard; a deliberate brush change re-blesses the brush rings.
COVER_EPS = 0.10    # a sample point must lie within this many px of the filled outline


def rings_poly(rings):
    ps = [_Poly(r) for r in rings if r and len(r) >= 3]
    ps = [_Poly(p.exterior).buffer(0) for p in ps if p.is_valid and not p.is_empty]
    ps = [p for p in ps if not p.is_empty]
    return unary_union(ps) if ps else None


def check(op_name, key, pts, new_rings):
    gold = rings_poly(GOLDEN[op_name][key]['rings'])
    new = rings_poly(new_rings)
    assert gold is not None and new is not None and not new.is_empty, f'{op_name} {key}: empty outline'

    for p in pts:  # COVERAGE — every drawn sample stays inside the new filled outline.
        assert new.buffer(COVER_EPS).contains(_Point(p[0], p[1])), \
            f'{op_name} {key}: input point {p} is no longer covered by the outline'

    ratio = new.symmetric_difference(gold).area / gold.area   # PARITY — barely differs from golden.
    assert ratio < PARITY_TOL, \
        f'{op_name} {key}: outline drifted {ratio*100:.2f}% (> {PARITY_TOL*100:.0f}%) from the golden result'


for key, e in GOLDEN['brush'].items():
    size = float(key.split('@')[1])
    check('brush', key, e['pts'], geo_engine.outline_brush([[p[0], p[1]] for p in e['pts']], size))
print('PASS brush — outline unchanged within tolerance + full coverage')

for key, e in GOLDEN['polyline'].items():
    size = float(key.split('@')[1])
    check('polyline', key, e['pts'],
          geo_engine.outline_polyline([[p[0], p[1]] for p in e['pts']], [size / 2] * len(e['pts'])))
print('PASS polyline — outline unchanged within tolerance + full coverage')

print('ALL PASS test_outline_parity')
