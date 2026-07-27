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

print('\n── P4: the wasm the browser fetches is the one the server runs ──')
from webapp.app import app  # noqa: E402

with app.test_client() as c:
    resp = c.get('/api/geo-engine.wasm')
    if resp.status_code != 200:
        _fail.append('wasm route status')
        print(f'  ✗  /api/geo-engine.wasm returned {resp.status_code}')
    else:
        served = resp.get_data()
        on_disk = open(geo_engine._WASM_PATH, 'rb').read()
        if served != on_disk:
            _fail.append('wasm route bytes')
            print('  ✗  served bytes differ from the committed artifact')
        elif served[:4] != b'\x00asm':
            _fail.append('wasm magic')
            print('  ✗  served payload is not a wasm module')
        else:
            print(f'  ✓  serves the committed artifact byte-for-byte ({len(served)} bytes)')

if _fail:
    raise SystemExit(f'\nFAILED: {len(_fail)} parity check(s): {", ".join(_fail)}')
print('\nAll geo-engine parity checks passed.')
