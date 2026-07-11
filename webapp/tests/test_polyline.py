"""Polyline click-brush — backend: strokes record which TOOL made them, and a polyline is
just a stroke that fuses like any other (the computed-from-strokes model).

Design (Christian, 2026-07-10): brush and polyline are two input modes over the SAME data. A
stroke now records the **tool** that created it (`brush` | `polyline`) plus its computed
outline, so each tool owns its geometry and a stroke's look is locked after creation. The
annotation's mask is still the cached union of its member strokes — so a polyline stroke fuses
with an overlapping same-label mark exactly like a brush stroke, with NO special merge logic.

This test pins the backend contract:
  P1. A stroke created with tool='polyline' stores tool='polyline'.
  P2. A stroke created without a tool (the brush default) stores tool='brush'.
  P3. A polyline commit yields a real fused mask (non-empty rings), just like a brush.
  P4. A polyline that overlaps an existing same-label mark FUSES into one annotation
      (mixed-provenance member strokes are fine — computed-from-strokes).

RED until the `tool` column + create_annotation plumbing land; green after.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-polyline-test-')
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


def jdump(r):
    return r.get_json()


def _leaf_png(w=240, h=200) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[15:h - 15, 15:w - 15] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── setup: project + image + batch (so strokes intersect a real tile) ────────────────
r = client.post('/api/projects', json={'name': 'Polyline', 'tile_size_px': 128})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

r = client.post(f'/api/projects/{pid}/images/upload',
                data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
                content_type='multipart/form-data')
r.get_data()
assert r.status_code == 200, jdump(r)
image_id = jdump(client.get(f'/api/projects/{pid}'))['images'][0]['id']

r = client.post(f'/api/projects/{pid}/batches', json={'size': 16})
assert r.status_code == 201, jdump(r)
batch_id = jdump(r)['id']
t0 = jdump(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make(points, tool=None, label='lesion', sw=12):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
            'points': points, 'label': label, 'strokeWidth': sw,
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if tool is not None:
        body['tool'] = tool
    r2 = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r2.status_code == 201, f'create failed: {jdump(r2)}'
    return jdump(r2)


def stroke_tools(annotation_id):
    con = db.get_db()
    try:
        return [row['tool'] for row in con.execute(
            'SELECT tool FROM stroke WHERE annotation_id = ?', (annotation_id,)).fetchall()]
    finally:
        db.close_db(con)


def live_annotations():
    return jdump(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']


# ── P1: a polyline stroke records tool='polyline' ────────────────────────────────────
poly = make([[cx - 10, cy - 10], [cx + 10, cy - 8], [cx + 8, cy + 10]], tool='polyline',
            label='poly-a')
assert stroke_tools(poly['id']) == ['polyline'], \
    f"expected the stroke to record tool='polyline', got {stroke_tools(poly['id'])!r}"
print('P1 OK — polyline stroke records tool=polyline')

# ── P2: a brush stroke (no tool given) defaults to tool='brush' ──────────────────────
brush = make([[cx, cy]], label='brush-b')
assert stroke_tools(brush['id']) == ['brush'], \
    f"expected the default tool to be 'brush', got {stroke_tools(brush['id'])!r}"
print('P2 OK — brush stroke defaults to tool=brush')

# ── P3: a polyline commit yields a real fused mask (non-empty rings) ─────────────────
assert poly['kind'] == 'stroke', f"polyline should commit as a stroke mask, got {poly['kind']!r}"
assert poly.get('rings'), f'polyline mask should have non-empty rings, got {poly.get("rings")!r}'
print('P3 OK — polyline yields a real mask with rings')

# ── P4: a polyline overlapping a same-label mark FUSES into one annotation ───────────
before = [a for a in live_annotations() if a['label'] == 'lesion']
make([[cx - 40, cy], [cx - 20, cy]], tool='polyline', label='fuse')     # first polyline
n_after_first = len([a for a in live_annotations() if a['label'] == 'fuse'])
make([[cx - 25, cy], [cx - 5, cy]], tool='polyline', label='fuse')      # overlaps the first
fused = [a for a in live_annotations() if a['label'] == 'fuse']
assert n_after_first == 1, f'first polyline should be one annotation, got {n_after_first}'
assert len(fused) == 1, f'the overlapping polyline must FUSE into one annotation, got {len(fused)}'
assert set(stroke_tools(fused[0]['id'])) == {'polyline'}, \
    f'the fused mask should own both polyline strokes, got {stroke_tools(fused[0]["id"])!r}'
print('P4 OK — overlapping polylines fuse into one annotation (2 member strokes)')

print('\npolyline backend contract tests passed.')
