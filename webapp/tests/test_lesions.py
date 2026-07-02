"""
Backend tests for the annotation/stroke fused-mask model (persisted masks, not
recompute-on-read). Supersedes the old per-request `_lesions_for_image` grouping tests.

See docs/plans/Plan — Annotation-stroke model (fused masks).md. Covers:
  M1. Two overlapping same-label strokes -> ONE annotation, both strokes bridged to it.
  M2. Two disjoint same-label strokes -> two independent annotations.
  M3. A third stroke bridging two disconnected same-label annotations -> a NEW annotation
      containing all three strokes; the two originals soft-deleted.
  M4. Different labels never fuse, even when their footprints overlap.
  M5. `annotation_tile` reflects the fused mask (recomputed on each merge).
  M6. Rendering reads stored geometry: get_batch's `annotations` carry `rings` for
      kind='stroke' straight from the stored row — no live re-derivation.
  M7. Undo of a merge (via /annotations/reverse) restores the originals (repointing their
      strokes back) and removes the created annotation.
  M8. Non-fusing kinds (polygon) never merge even when they geometrically overlap a mask.

Run with: uv run python3 webapp/tests/test_lesions.py
"""

import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-lesion-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.execute("INSERT INTO users (id, username) VALUES (3, 'bob')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True

alice_client = app.test_client()
with alice_client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'


def jdump(r):
    return r.get_json()


def _make_leaf_png(w: int = 200, h: int = 200) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[20:h - 20, 20:w - 20] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: project, image, batch ──────────────────────────────────────────────

print('\n── Setup ──')

r = alice_client.post('/api/projects', json={'name': 'MaskTest', 'tile_size_px': 128})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

leaf = _make_leaf_png()
r = alice_client.post(
    f'/api/projects/{pid}/images/upload',
    data={'files': [(io.BytesIO(leaf), 'leaf.png', 'image/png')]},
    content_type='multipart/form-data',
)
r.get_data()  # force the streaming generator to run to completion (commits inline)
assert r.status_code == 200, jdump(r)

det = jdump(alice_client.get(f'/api/projects/{pid}'))
image_id = det['images'][0]['id']

r = alice_client.post(f'/api/projects/{pid}/batches', json={'size': 16})
assert r.status_code == 201, jdump(r)
batch_id = jdump(r)['id']

cv = jdump(alice_client.get(f'/api/batches/{batch_id}?annotator=alice'))
t0 = cv['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make_stroke(points, label='lesion', sw=20):
    r2 = alice_client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke',
        'points': points, 'label': label, 'strokeWidth': sw,
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
    })
    assert r2.status_code == 201, f'make_stroke failed: {jdump(r2)}'
    return jdump(r2)


def live_annotations():
    cv = jdump(alice_client.get(f'/api/batches/{batch_id}?annotator=alice'))
    return cv['images'][0]['annotations']


def is_deleted(ann_id):
    c = db.get_db()
    try:
        row = c.execute('SELECT deleted_at FROM annotation WHERE id = ?', (ann_id,)).fetchone()
        return row['deleted_at'] is not None
    finally:
        db.close_db(c)


# ── M1: overlapping same-label strokes -> ONE annotation ─────────────────────

print('\n── M1: overlapping same-label strokes -> one annotation ──')

a1 = make_stroke([[cx - 10, cy], [cx + 10, cy]], label='lesion', sw=30)
assert a1['consumedAnnotationIds'] == [], 'first stroke never merges anything'
a2 = make_stroke([[cx, cy - 10], [cx, cy + 10]], label='lesion', sw=30)
assert a2['consumedAnnotationIds'] == [a1['id']], \
    f'expected the 2nd overlapping stroke to consume the 1st, got {a2["consumedAnnotationIds"]}'
assert is_deleted(a1['id']), 'the consumed (pre-merge) annotation must be soft-deleted'
strokes_on_merged = db.get_db()
try:
    ids = [r['id'] for r in strokes_on_merged.execute(
        'SELECT id FROM stroke WHERE annotation_id = ?', (a2['id'],)).fetchall()]
finally:
    db.close_db(strokes_on_merged)
assert len(ids) == 2, f'expected both strokes bridged to the merged annotation, got {ids}'
print('  ✓  2 overlapping strokes -> 1 annotation, both strokes bridged to it')


# ── M2: disjoint same-label strokes -> 2 independent annotations ─────────────
# (drawn on a DIFFERENT row than M1's cluster, cy - 40, so the two sections' geometry
# can't accidentally touch each other)

print('\n── M2: disjoint same-label strokes -> 2 annotations ──')

pad = 5
row2 = cy - 40
b1 = make_stroke([[tx + pad, row2], [tx + pad + 2, row2]], label='lesion', sw=4)
b2 = make_stroke([[tx + tw - pad - 2, row2], [tx + tw - pad, row2]], label='lesion', sw=4)
assert b2['consumedAnnotationIds'] == [], 'far-apart strokes must not fuse'
assert b1['id'] != b2['id']
print('  ✓  2 disjoint strokes -> 2 independent annotations')


# ── M3: a bridging stroke merges two disconnected annotations ────────────────

print('\n── M3: a 3rd stroke bridging 2 disconnected annotations -> 1 new annotation ──')

bridge = make_stroke([[tx + pad, row2], [tx + tw - pad, row2]], label='lesion', sw=8)
assert set(bridge['consumedAnnotationIds']) == {b1['id'], b2['id']}, \
    f'expected the bridge to consume both b1 and b2, got {bridge["consumedAnnotationIds"]}'
assert is_deleted(b1['id']) and is_deleted(b2['id'])
con = db.get_db()
try:
    bridged_ids = {r['id'] for r in con.execute(
        'SELECT id FROM stroke WHERE annotation_id = ?', (bridge['id'],)).fetchall()}
finally:
    db.close_db(con)
assert len(bridged_ids) == 3, f'expected all 3 strokes bridged to the new annotation, got {bridged_ids}'
print('  ✓  bridging stroke mints a new annotation containing all 3 strokes; originals soft-deleted')


# ── M4: different labels never fuse ───────────────────────────────────────────

print('\n── M4: overlapping different-label strokes never fuse ──')

c1 = make_stroke([[cx - 10, cy + 40], [cx + 10, cy + 40]], label='lesion', sw=30)
c2 = make_stroke([[cx, cy + 30], [cx, cy + 50]], label='midrib', sw=30)
assert c2['consumedAnnotationIds'] == [], 'cross-label overlap must not fuse'
assert not is_deleted(c1['id'])
print('  ✓  overlapping different-label strokes stay separate annotations')


# ── M5: annotation_tile reflects the fused mask ───────────────────────────────

print('\n── M5: annotation_tile reflects the fused (bridge) mask ──')

con = db.get_db()
try:
    tiles = [r['tile_id'] for r in con.execute(
        'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (bridge['id'],)).fetchall()]
    stale = con.execute(
        'SELECT COUNT(*) c FROM annotation_tile WHERE annotation_id IN (?, ?)', (b1['id'], b2['id'])
    ).fetchone()['c']
finally:
    db.close_db(con)
assert t0['tileId'] in tiles
assert stale == 0, 'the consumed annotations tile rows must be cleared on merge'
print('  ✓  annotation_tile has the bridge mask, and the consumed rows are gone')


# ── M6: rendering reads stored geometry (get_batch carries rings, no recompute) ──

print('\n── M6: get_batch returns stored rings for stroke-kind annotations ──')

anns = live_annotations()
bridge_out = next(a for a in anns if a['id'] == bridge['id'])
assert bridge_out['kind'] == 'stroke'
assert bridge_out['rings'], f'expected non-empty rings on the mask annotation: {bridge_out}'
assert bridge_out['points'] == [], 'stroke-kind masks render from rings, not points'
print(f'  ✓  stored rings ({len(bridge_out["rings"][0])} exterior pts) drive rendering directly')


# ── M7: undo of a merge restores the originals + repoints their strokes ──────

print('\n── M7: undo (/annotations/reverse) restores merge-consumed originals ──')

r = alice_client.post(f'/api/projects/{pid}/annotations/reverse', json={
    'annotationId': bridge['id'], 'strokeId': bridge['createdStrokeId'],
    'consumedGroups': bridge['consumedGroups'],
})
assert r.status_code == 200, jdump(r)
rev = jdump(r)
assert rev['ok'] is True
assert not is_deleted(b1['id']) and not is_deleted(b2['id']), 'originals must be resurrected'
con = db.get_db()
try:
    gone = con.execute('SELECT 1 FROM annotation WHERE id = ?', (bridge['id'],)).fetchone()
    b1_strokes = {r2['id'] for r2 in con.execute(
        'SELECT id FROM stroke WHERE annotation_id = ?', (b1['id'],)).fetchall()}
    b2_strokes = {r2['id'] for r2 in con.execute(
        'SELECT id FROM stroke WHERE annotation_id = ?', (b2['id'],)).fetchall()}
finally:
    db.close_db(con)
assert gone is None, 'the created (merge) annotation must be hard-deleted on undo'
assert bridge['createdStrokeId'] not in b1_strokes | b2_strokes, \
    'the bridging stroke itself must be hard-deleted on undo, not repointed'
live_ids = {a['id'] for a in live_annotations()}
assert b1['id'] in live_ids and b2['id'] in live_ids
assert bridge['id'] not in live_ids
print('  ✓  undo restores both originals (strokes repointed back) and removes the merge')


# ── M7 redo: re-POSTing the original create re-derives the same fuse ─────────
# There is no server-side "redo" endpoint (see reverse_annotation_merge's docstring and
# canvasHistory.ts's redo()) — the client just re-POSTs the ORIGINAL create_annotation
# body against the now-resurrected originals, deterministically re-fusing them.

print('\n── M7 redo: re-issuing the original bridge create re-fuses b1+b2 ──')

redo_bridge = make_stroke([[tx + pad, row2], [tx + tw - pad, row2]], label='lesion', sw=8)
assert set(redo_bridge['consumedAnnotationIds']) == {b1['id'], b2['id']}, \
    f'redo must re-fuse the resurrected originals, got {redo_bridge["consumedAnnotationIds"]}'
assert is_deleted(b1['id']) and is_deleted(b2['id']), 'redo must re-consume the originals'
assert redo_bridge['id'] != bridge['id'], \
    'redo mints a brand-new annotation id, never reuses the undone merge id'
live_ids2 = {a['id'] for a in live_annotations()}
assert redo_bridge['id'] in live_ids2
assert b1['id'] not in live_ids2 and b2['id'] not in live_ids2
print('  ✓  redo (re-POST of the original create) re-fuses the resurrected originals into one fresh mask')


# ── M8: non-fusing kinds (polygon) never merge ────────────────────────────────

print('\n── M8: polygon annotations never fuse, even overlapping a live mask ──')

poly = [[cx - 10, cy - 10], [cx + 10, cy - 10], [cx + 10, cy + 10], [cx - 10, cy + 10]]
r = alice_client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': image_id, 'annotator': 'alice', 'kind': 'polygon',
    'points': poly, 'label': 'lesion',
    'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th},
})
assert r.status_code == 201, jdump(r)
poly_ann = jdump(r)
assert poly_ann['consumedAnnotationIds'] == []
assert poly_ann['kind'] == 'polygon'
assert poly_ann['points'] == poly
assert poly_ann['rings'] == []
print('  ✓  polygon annotation created 1:1, no fusion attempted')


print('\n✓ All annotation-mask model tests passed')
