"""t158 — merging an overlapping brush stroke must never make an earlier stroke vanish.

Christian (2026-10-10, kanji 束): a stroke turned invisible when a later stroke merged with it,
leaving a cut-out. Reproduced from his real tracings (fixtures/t158_kanji_merge_cases.json —
synthetic kanji stimulus, 4 px brush). The chain was:
  1. the stored mask ring is rounded to 0.01 px; on a thin, densely-vertexed outline that
     rounding made the ring SELF-INTERSECT;
  2. reading it back repaired it with buffer(0), which also flipped its winding;
  3. the engine `fuse` (NonZero) then CANCELLED the overlap of the opposite-wound rings, the
     merge split in two, and the server kept only the larger piece.

  KM1  a stored mask ring is always VALID (never a self-intersecting rounded ring) — for every
       real case, straight through create.
  KM2  the real 束 pair: drawing the second, overlapping stroke yields ONE mask whose area is
       the union of both strokes (nothing vanishes, no cut-out).
  KM3  the engine `fuse` ignores winding: a CW and a CCW overlapping square union to one ring.

Run: uv run python webapp/tests/test_t158_merge_kanji.py
"""
import io
import json
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-t158-merge-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from shapely.geometry import Polygon as _Poly
from shapely.ops import unary_union
from webapp import db, app as appmod, geo_engine

HERE = os.path.dirname(__file__)
CASES = json.load(open(os.path.join(HERE, 'fixtures', 't158_kanji_merge_cases.json')))['cases']

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True
client = app.test_client()
with client.session_transaction() as s:
    s['user_id'] = 2
    s['username'] = 'alice'


def j(r):
    return r.get_json()


def _png(w=512, h=512) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[2:h - 2, 2:w - 2] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


pid = j(client.post('/api/projects', json={'name': 'T158', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_png()), 'kanji.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']


def live():
    return j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']


def create(case, label):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': case['pts'],
            'label': label, 'strokeWidth': case['w'], 'tool': 'brush',
            'viewport': {'x': 0, 'y': 0, 'w': 512, 'h': 512}}
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)['id']


def engine_area(case):
    return _Poly(geo_engine.outline_brush(case['pts'], case['w'])[0]).area


fail = []

# ── KM1: every stored mask ring is valid ───────────────────────────────────────────────────
# Each case on its own label so none of them fuse together.
for i, (key, case) in enumerate(sorted(CASES.items())):
    if key == '0b7c8612_9f2ca242':
        continue  # KM2's second stroke
    aid = create(case, f'km1-{i}')
    rings = next(a for a in live() if a['id'] == aid)['rings']
    bad = [k for k, r in enumerate(rings) if not _Poly(r).is_valid]
    if bad:
        fail.append(f'KM1 {key}: stored ring(s) {bad} self-intersect')
print('KM1 done')

# ── KM2: the real pair merges into one mask covering both strokes ─────────────────────────────
a_case, b_case = CASES['0b7c8612_22da0915'], CASES['0b7c8612_9f2ca242']
create(a_case, 'km2')
mid = create(b_case, 'km2')
masks = [a for a in live() if a['id'] == mid]
assert len(masks) == 1, 'KM2: the merged mask must be live'
merged = unary_union([_Poly(r).buffer(0) for r in masks[0]['rings']])
want = unary_union([_Poly(geo_engine.outline_brush(c['pts'], c['w'])[0]) for c in (a_case, b_case)])
ratio = merged.area / want.area
if ratio < 0.98:
    fail.append(f'KM2: merged mask covers {ratio*100:.1f}% of the two strokes (a stroke vanished)')
if not merged.buffer(0.05).contains(want.buffer(-0.05)):
    fail.append('KM2: merged mask has a cut-out where the strokes overlap')
print(f'KM2 merged/union area = {ratio:.4f}')

# ── KM3: engine fuse is winding-independent ──────────────────────────────────────────────────
ccw = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]
cw = [[5.0, 0.0], [5.0, 10.0], [15.0, 10.0], [15.0, 0.0]]
rings = geo_engine.fuse([ccw, cw])
if len(rings) != 1 or abs(_Poly(rings[0]).area - 150.0) > 1e-6:
    fail.append(f'KM3: CW+CCW overlap fused to {len(rings)} ring(s)')
print('KM3 done')

if fail:
    print('FAILED:\n  ' + '\n  '.join(fail))
    raise SystemExit(1)
print('ALL PASS test_t158_merge_kanji')
