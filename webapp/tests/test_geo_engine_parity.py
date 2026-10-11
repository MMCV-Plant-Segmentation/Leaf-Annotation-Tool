"""t104/D2 — the server half of the FE↔BE stroke-geometry parity lock.

`webapp/tests/fixtures/geo_engine_parity.json` is the single artifact both sides pin to. The
FE spec (webapp/frontend/e2e/unit/geoEngine.spec.ts) asserts the JS binding reproduces it
exactly; this asserts the PYTHON binding still does too.

Why both halves are needed: with only the FE test, regenerating the fixture from a changed
engine would keep the FE green while silently moving the server's geometry. With both, the
fixture cannot drift from either side unnoticed — a real engine change must be re-blessed
deliberately, and the two bindings must agree on the result.

Also serves the wasm route the browser fetches (/api/geo-engine.wasm), so the FE runs the
SAME committed artifact rather than a copy that could drift.
"""
import json
import os

from webapp import geo_engine

HERE = os.path.dirname(__file__)
FIXTURE = json.load(open(os.path.join(HERE, 'fixtures', 'geo_engine_parity.json')))

_fail = []


def check(name, got, want):
    if got == want:
        print(f'  ✓  {name}')
    else:
        _fail.append(name)
        print(f'  ✗  {name}: geometry differs from the pinned fixture')
        print(f'       rings got={len(got)} want={len(want)}')
        if len(got) == len(want):
            for i, (g, w) in enumerate(zip(got, want)):
                if g != w:
                    print(f'       ring {i}: {len(g)} pts vs {len(w)} pts')
                    break


print('\n── P1: brush outlines match the pinned fixture ──')
for key, case in FIXTURE['brush'].items():
    check(f'brush {key}', geo_engine.outline_brush(case['pts'], case['size']), case['rings'])

print('\n── P2: polyline outlines match (incl. per-vertex radii) ──')
for key, case in FIXTURE['polyline'].items():
    check(f'polyline {key}', geo_engine.outline_polyline(case['pts'], case['radii']), case['rings'])

print('\n── P3: fuse matches, and overlapping shapes union to ONE ring ──')
for key, case in FIXTURE['fuse'].items():
    got = geo_engine.fuse(case['polygons'])
    check(f'fuse {key}', got, case['rings'])
    if len(got) != 1:
        _fail.append(f'fuse {key} ring count')
        print(f'  ✗  fuse {key}: expected a single unioned ring, got {len(got)}')

print('\n── P4: the engine identifies itself, and both bindings agree on the version ──')
# Runtime drift detection (Christian's idea): a copying build step catches a stale artifact at
# BUILD time; this catches it at RUNTIME — the case no build step can see, e.g. a stale wasm
# baked into a deployed container. The FE spec pins the SAME fixture value.
got_version = geo_engine.version()
check('engine version', got_version, FIXTURE['version'])

print('\n── P5: t147 — malformed input ERRORS, it does not silently vanish ──')
# Each of these used to return [], which reads downstream as "this stroke has no geometry",
# so a caller bug made the stroke disappear with no error.
malformed = [
    ('polyline radii shorter than points', lambda: geo_engine.outline_polyline([[0, 0], [1, 1]], [1])),
    ('polyline radii longer than points', lambda: geo_engine.outline_polyline([[0, 0], [1, 1]], [1, 2, 3])),
    ('polyline zero radius', lambda: geo_engine.outline_polyline([[0, 0], [1, 1]], [1, 0])),
    ('brush with no points', lambda: geo_engine.outline_brush([], 5)),
    ('brush with a negative size', lambda: geo_engine.outline_brush([[0, 0], [10, 10]], -5)),
]
for label, fn in malformed:
    try:
        result = fn()
        _fail.append(label)
        print(f'  ✗  {label}: returned {result!r} instead of raising')
    except geo_engine.GeoEngineError as e:
        print(f'  ✓  {label} → {e}')

print('\n── P6: legitimate degenerate input is still ACCEPTED (guard is not overzealous) ──')
for label, fn, want_rings in [
    ('one-point polyline (renders as a disk)', lambda: geo_engine.outline_polyline([[5, 5]], [3]), 1),
    ('one-point brush dab', lambda: geo_engine.outline_brush([[5, 5]], 4), 1),
]:
    got = fn()
    if len(got) == want_rings:
        print(f'  ✓  {label}')
    else:
        _fail.append(label)
        print(f'  ✗  {label}: expected {want_rings} ring(s), got {len(got)}')

if _fail:
    raise SystemExit(f'\nFAILED: {len(_fail)} parity check(s): {", ".join(_fail)}')
print('\nAll geo-engine parity checks passed.')
