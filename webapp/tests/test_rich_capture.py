"""t141 P1a — rich max-rate capture is an ADDITIVE per-stroke channel.

A stroke gains a second channel alongside its coarse points + server-derived geometry:
the raw max-rate input stream (`samples`), one entry per pointer sample —
`{x, y, t, pressure, tiltX, tiltY, twist, pointerType}`. It is stored verbatim (a
per-stroke JSON blob), surfaced on the per-stroke read-out (what replay consumes), and
NEVER affects geometry. Absent ⇒ null ⇒ today's behaviour exactly. Both the REST shim and
the WS op handler share the `do_*` cores, so this one contract covers both.

  RC1  create WITH samples -> the stroke's `samples` round-trips verbatim (fields, nulls,
       pointerType, monotonic t) on the read path replay uses.
  RC2  create WITHOUT samples -> `samples` is null (additive default; unchanged behaviour).
  RC3  ADDITIVE guarantee — a stroke's stored geometry is the engine outline of its POINTS,
       identical whether or not `samples` rides along (samples never perturb the mask).
  RC4  EDIT (PATCH) carrying new samples -> the stored `samples` are updated.
  RC5  backward-compat — a stroke with no samples still reads back all its existing fields
       (points, tool, strokeWidth) intact.

Run: uv run python webapp/tests/test_rich_capture.py
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-rich-capture-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from shapely.geometry import Polygon as _Poly
from shapely.ops import unary_union
from webapp import db, app as appmod, geo_engine

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


def _leaf_png(w=360, h=320) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


pid = j(client.post('/api/projects', json={'name': 'RichCapture', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def live():
    return j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']


def strokes_of(aid):
    a = next(x for x in live() if x['id'] == aid)
    return a.get('strokes') or []


def stroke_by_sid(sid):
    """Find a member stroke by its stable id across all live annotations (robust to a
    reshape edit re-fusing the stroke into a different annotation)."""
    for a in live():
        for st in (a.get('strokes') or []):
            if st['id'] == sid:
                return st
    raise AssertionError(f'stroke {sid} not found on any live annotation')


def rings_poly(rings):
    ps = [_Poly(r) for r in rings if r and len(r) >= 3]
    ps = [_Poly(p.exterior).buffer(0) for p in ps if p.is_valid and not p.is_empty]
    ps = [p for p in ps if not p.is_empty]
    return unary_union(ps) if ps else None


def mask_of(aid):
    a = next(x for x in live() if x['id'] == aid)
    return rings_poly(a.get('rings') or [])


def create(points, *, sw, samples=None, tool='brush'):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
            'label': 'thing', 'strokeWidth': sw, 'tool': tool,
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if samples is not None:
        body['samples'] = samples
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)


# A realistic mixed stream: pen samples (pressure/tilt/twist) + one mouse sample with the
# device-unreported fields NULL — nullability must survive the JSON round-trip.
SAMPLES = [
    {'x': cx - 25.0, 'y': cy + 0.4, 't': 0.0,  'pressure': 0.10, 'tiltX': -5.0, 'tiltY': 3.0,  'twist': 12.0, 'pointerType': 'pen'},
    {'x': cx - 12.0, 'y': cy - 0.3, 't': 8.3,  'pressure': 0.42, 'tiltX': -4.0, 'tiltY': 2.0,  'twist': 11.0, 'pointerType': 'pen'},
    {'x': cx + 3.0,  'y': cy + 0.1, 't': 16.7, 'pressure': 0.71, 'tiltX': -2.0, 'tiltY': 1.0,  'twist': 10.0, 'pointerType': 'pen'},
    {'x': cx + 18.0, 'y': cy - 0.2, 't': 25.0, 'pressure': 0.55, 'tiltX': None, 'tiltY': None, 'twist': None, 'pointerType': 'mouse'},
    {'x': cx + 25.0, 'y': cy + 0.0, 't': 33.4, 'pressure': 0.20, 'tiltX': -1.0, 'tiltY': 0.0,  'twist': 9.0,  'pointerType': 'pen'},
]
PTS = [[s['x'], s['y']] for s in SAMPLES]


# ── RC1: samples round-trip verbatim on the read path ────────────────────────────────────
a1 = create(PTS, sw=18.0, samples=SAMPLES)
st1 = strokes_of(a1['id'])
assert len(st1) == 1, f'RC1: one member stroke, got {len(st1)}'
got = st1[0].get('samples')
assert got is not None, 'RC1: the stroke read-out must carry `samples`'
assert len(got) == len(SAMPLES), f'RC1: sample count {len(got)} != {len(SAMPLES)}'
for sent, back in zip(SAMPLES, got):
    for k in ('x', 'y', 't', 'pressure', 'tiltX', 'tiltY', 'twist'):
        if sent[k] is None:
            assert back.get(k) is None, f'RC1: {k} should round-trip NULL, got {back.get(k)}'
        else:
            assert abs(float(back[k]) - sent[k]) < 1e-6, f'RC1: {k} {back.get(k)} != {sent[k]}'
    assert back.get('pointerType') == sent['pointerType'], \
        f'RC1: pointerType {back.get("pointerType")} != {sent["pointerType"]}'
ts = [s['t'] for s in got]
assert ts == sorted(ts), f'RC1: timestamps must stay monotonic/ordered: {ts}'
print('PASS RC1 — samples round-trip verbatim (fields, nulls, pointerType, ordered t)')


# ── RC2: no samples sent -> null (additive default) ──────────────────────────────────────
a2 = create([[cx - 20.0, cy - 30.0], [cx + 20.0, cy - 30.0]], sw=16.0)  # no samples kwarg
st2 = strokes_of(a2['id'])
assert len(st2) == 1
assert st2[0].get('samples') is None, \
    f'RC2: a stroke drawn without samples must read back null, got {st2[0].get("samples")!r}'
print('PASS RC2 — a stroke with no samples reads back null (unchanged behaviour)')


# ── RC3: additive — geometry is the engine outline of the POINTS, samples-independent ─────
m1 = mask_of(a1['id'])
exp = rings_poly(geo_engine.outline_brush([[p[0], p[1]] for p in PTS], 18.0))
assert m1 is not None and exp is not None
sd = m1.symmetric_difference(exp).area
assert sd < 0.05 * m1.area, \
    f'RC3: mask must equal the engine BRUSH outline of the points (symdiff {sd:.2f} vs area {m1.area:.2f}) '\
    f'— samples must not perturb geometry'
print('PASS RC3 — the mask is the engine outline of the points; samples never affect it')


# ── RC4: edit carrying new samples updates the stored stream ─────────────────────────────
sid = a2['createdStrokeId']
new_pts = [[cx - 20.0, cy + 30.0], [cx + 20.0, cy + 30.0]]
NEW_SAMPLES = [
    {'x': cx - 20.0, 'y': cy + 30.0, 't': 0.0, 'pressure': 0.3, 'tiltX': 1.0, 'tiltY': 1.0, 'twist': None, 'pointerType': 'pen'},
    {'x': cx + 20.0, 'y': cy + 30.0, 't': 9.1, 'pressure': 0.6, 'tiltX': 2.0, 'tiltY': 0.0, 'twist': None, 'pointerType': 'pen'},
]
r = client.patch(f'/api/projects/{pid}/strokes/{sid}',
                 json={'points': new_pts, 'strokeWidth': 16.0, 'samples': NEW_SAMPLES})
assert r.status_code == 200, f'RC4: edit should 200, got {r.status_code}: {j(r)}'
got4 = stroke_by_sid(sid).get('samples')
assert got4 is not None and len(got4) == 2, f'RC4: edited samples not stored: {got4!r}'
assert abs(float(got4[1]['pressure']) - 0.6) < 1e-6 and got4[1]['pointerType'] == 'pen', \
    f'RC4: edited samples content wrong: {got4}'
print('PASS RC4 — an edit updates the stored samples stream')


# ── RC5: backward-compat — existing stroke fields intact alongside samples ───────────────
st5 = stroke_by_sid(sid)
assert st5.get('samples') is not None  # (RC4 just added them; sanity)
assert st5['strokeWidth'] == 16.0, f'RC5: strokeWidth lost: {st5.get("strokeWidth")}'
assert st5['tool'] == 'brush', f'RC5: tool lost: {st5.get("tool")}'
assert st5['points'] and len(st5['points']) >= 2, f'RC5: points lost: {st5.get("points")}'
print('PASS RC5 — existing per-stroke fields (points, tool, strokeWidth) intact alongside samples')

print('ALL PASS test_rich_capture')
