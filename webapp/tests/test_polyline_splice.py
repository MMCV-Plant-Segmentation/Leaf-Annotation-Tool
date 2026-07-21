"""Polyline splice (t67) — BACKEND contract.

Christian's idea (2026-07-20). A freshly-drawn polyline run whose FIRST and LAST vertices snapped
(t50) onto an ADJACENT pair of an existing stroke's vertices is spliced INTO that stroke: the run's
middle vertices replace the direct edge between the pair, and the standalone run stroke is dropped.
Because the run shares the existing stroke's endpoint positions (same label), the two are already
CO-FUSED into one annotation on draw — so the splice deletes the run STROKE (not its annotation),
rewrites the target stroke, and re-fuses the scope (do_edit_stroke machinery).

Contract (POST /api/projects/<pid>/splice, mirrored by the 'splice' WS op):
  body {strokeId (existing), points, vertexRefs, removeStrokeId (the run)}:
  - the existing stroke is rewritten to the spliced point list, endpoints keep their SHARED vertex ids
    and the middle keeps the run's own vertex id (no churn);
  - the run stroke is deleted; its exclusive vertices GC'd, shared endpoints survive;
  - 400 on missing fields, 422 on splicing a stroke into itself.

Standalone-script style (mirrors test_vertex_snapping_persist.py).
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-splice-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

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
    s['user_id'] = 2; s['username'] = 'alice'


def j(r):
    return r.get_json()


def _leaf_png(w=320, h=280) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


pid = j(client.post('/api/projects', json={'name': 'Splice', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make(points, refs=None, label='sp', sw=12):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
            'label': label, 'strokeWidth': sw, 'tool': 'polyline',
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if refs is not None:
        body['vertexRefs'] = refs
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)


def _q1(sql, args=()):
    con = db.get_db()
    try:
        return con.execute(sql, args).fetchone()
    finally:
        db.close_db(con)


def stroke_id_of(annotation_id):
    return _q1('SELECT id FROM stroke WHERE annotation_id = ?', (annotation_id,))['id']


def stroke_out(annotation_id):
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    return next(x for x in live if x['id'] == annotation_id)['strokes'][0]


def stroke_out_by_sid(sid):
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    for a in live:
        for st in a.get('strokes') or []:
            if st['id'] == sid:
                return st
    raise AssertionError(f'stroke {sid} not found under any live annotation')


def ref_count(vid):
    return _q1('SELECT COUNT(*) c FROM stroke_vertex WHERE vertex_id = ?', (vid,))['c']


def vertex_exists(vid):
    return _q1('SELECT 1 FROM vertex WHERE id = ?', (vid,)) is not None


def stroke_exists(sid):
    return _q1('SELECT 1 FROM stroke WHERE id = ?', (sid,)) is not None


A = [cx - 30, cy, 12.0]
B = [cx, cy, 12.0]
C = [cx + 30, cy, 12.0]
M = [cx - 15, cy - 20, 12.0]

# ── existing polyline A—B—C; vA,vB are an adjacent pair (indices 0,1) ─────────────────────
aExist = make([A, B, C])
sidExist = stroke_id_of(aExist['id'])
vA, vB, vC = stroke_out(aExist['id'])['vertexIds']
print('setup OK — existing polyline A-B-C')

# ── draw the run A→M→B, snapping its endpoints onto vA and vB ─────────────────────────────
rRun = make([A, M, B], refs=[vA, None, vB])
run_sid = rRun['createdStrokeId']
soRun = stroke_out_by_sid(run_sid)
vM = soRun['vertexIds'][1]
assert soRun['vertexIds'][0] == vA and soRun['vertexIds'][2] == vB, soRun['vertexIds']
assert ref_count(vA) == 2 and ref_count(vB) == 2, (ref_count(vA), ref_count(vB))
print('setup OK — run A-M-B shares vA,vB (co-fused with the existing mark)')

# ── SPLICE: rewrite the existing stroke to A-M-B-C, drop the run ──────────────────────────
r = client.post(f'/api/projects/{pid}/splice', json={
    'strokeId': sidExist, 'points': [A, M, B, C], 'vertexRefs': [vA, vM, vB, vC],
    'removeStrokeId': run_sid})
assert r.status_code == 200, f'splice failed: {j(r)}'

soS = stroke_out_by_sid(sidExist)
assert [p[:2] for p in soS['points']] == [A[:2], M[:2], B[:2], C[:2]], soS['points']
assert soS['vertexIds'] == [vA, vM, vB, vC], soS['vertexIds']
print('S1 OK — the existing stroke is now A-M-B-C with stable endpoint ids')

assert not stroke_exists(run_sid), 'the run stroke must be deleted'
assert vertex_exists(vA) and vertex_exists(vB) and vertex_exists(vC) and vertex_exists(vM)
assert ref_count(vA) == 1 and ref_count(vB) == 1 and ref_count(vM) == 1, \
    (ref_count(vA), ref_count(vB), ref_count(vM))
print('S2 OK — run stroke gone; endpoints + spliced middle survive, each referenced once')

# the splice re-fused to ONE mask on the image
live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
assert len(live) == 1, f'expected a single spliced mask, got {len(live)}'
print('S3 OK — one fused mask remains')

# ── guards ───────────────────────────────────────────────────────────────────────────────
assert client.post(f'/api/projects/{pid}/splice',
                   json={'strokeId': sidExist}).status_code == 400, 'missing fields → 400'
assert client.post(f'/api/projects/{pid}/splice',
                   json={'strokeId': sidExist, 'points': [A, B],
                         'removeStrokeId': sidExist}).status_code == 422, 'self-splice → 422'
print('S4 OK — guards (400 missing fields, 422 self-splice)')

print('\nALL POLYLINE-SPLICE (t67) CHECKS PASSED')
