"""t111 — finishing an off-tile polyline must NOT delete co-fused on-tile geometry.

Christian, 2026-07-21 demo (DATA LOSS). Repro: a midrib is drawn spanning from on-tile
out past the tile edge (an off-tile vertex). With the polyline tool the user clicks the
midrib at that OFF-TILE point — the click snaps onto the midrib's off-tile vertex and, per
the fuse-on-create model, CONSUMES the whole midrib into the new stroke's annotation. On
FINISH the new stroke's OWN footprint touches no tile, so `_do_finish_stroke` discarded the
WHOLE annotation — wiping the co-fused, on-tile midrib. The user saw the "must intersect at
least one tile" error and their midrib vanished.

CONTRACT (RED until t111 lands):
  U1. Finish's keep/discard decision is over the WHOLE annotation's footprint (every live
      member stroke), NOT just the finishing stroke's own points. A fused annotation whose
      geometry touches >=1 tile is KEPT even when the finishing stroke is entirely off-tile.
  U2. The co-fused on-tile geometry (the midrib) survives finish — its stroke's annotation
      is still live and still linked to the tiles it originally occupied.
  U3. Brush-parity for a LONE stroke is preserved: a new all-off-tile polyline that fused
      with NOTHING is still discarded on finish (t59 F2 must not regress).

Standalone-script style (mirrors test_polyline_finish.py). The implementer does NOT edit it.
"""
import io
import json as _json
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-polyfused-test-')
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
    s['user_id'] = 2
    s['username'] = 'alice'


def jd(r):
    return r.get_json()


def _leaf_png(w=260, h=220) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


r = client.post('/api/projects', json={'name': 'PolyFused', 'tile_size_px': 128})
pid = jd(r)['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = jd(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = jd(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = jd(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2       # comfortably ON a tile
OFF_X = 350                               # past the 256px tiled width -> off EVERY tile


def create(points, label, sw=12, refs=None):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
            'label': label, 'strokeWidth': sw, 'tool': 'polyline',
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if refs is not None:
        body['vertexRefs'] = refs
    return client.post(f'/api/projects/{pid}/annotations', json=body)


def edit(sid, points=None, final=False, sw=12):
    body = {'strokeWidth': sw, 'final': final}
    if points is not None:
        body['points'] = points
    return client.patch(f'/api/projects/{pid}/strokes/{sid}', json=body)


def ann_alive(aid) -> bool:
    con = db.get_db()
    try:
        row = con.execute('SELECT deleted_at FROM annotation WHERE id = ?', (aid,)).fetchone()
        return bool(row) and row['deleted_at'] is None
    finally:
        db.close_db(con)


def ann_of_stroke(sid):
    con = db.get_db()
    try:
        row = con.execute('SELECT annotation_id FROM stroke WHERE id = ?', (sid,)).fetchone()
        return row['annotation_id'] if row else None
    finally:
        db.close_db(con)


def tiles_of_ann(aid):
    con = db.get_db()
    try:
        return {r['tile_id'] for r in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (aid,)).fetchall()}
    finally:
        db.close_db(con)


def stroke_vertices(sid):
    con = db.get_db()
    try:
        return [(r['id'], r['x'], r['y']) for r in con.execute(
            '''SELECT v.id, v.x, v.y FROM vertex v JOIN stroke_vertex sv ON sv.vertex_id = v.id
               WHERE sv.stroke_id = ? ORDER BY sv.seq''', (sid,)).fetchall()]
    finally:
        db.close_db(con)


# ── Draw the midrib: on-tile -> off-tile, finish (kept; it touches a tile). ────────────────
c1 = create([[cx, cy, 12]], label='midrib', sw=12)
S_m = jd(c1)['createdStrokeId']
edit(S_m, points=[[cx, cy, 12], [OFF_X, cy, 12]])
edit(S_m, final=True)
A_m = ann_of_stroke(S_m)
midrib_tiles = tiles_of_ann(A_m)
assert ann_alive(A_m), 'midrib is live after its own finish'
assert midrib_tiles, 'midrib occupies at least one tile (its on-tile portion)'

# The midrib's off-tile vertex (the point the user clicks "outside the tile but on the midrib").
off_vtx = [v for v in stroke_vertices(S_m) if v[1] >= 256]
assert off_vtx, f'midrib has an off-tile vertex, got {stroke_vertices(S_m)}'
snap_id, snap_x, snap_y = off_vtx[0]

# ── New polyline: first click snaps onto the midrib's OFF-TILE vertex -> consumes the midrib.
c2 = create([[snap_x, snap_y, 12]], label='midrib', sw=12, refs=[snap_id])
assert c2.status_code == 201, f'off-tile snap click accepted, got {c2.status_code}: {jd(c2)}'
S_new = jd(c2)['createdStrokeId']
assert A_m in (jd(c2).get('consumedAnnotationIds') or []), \
    f'the click on the midrib fused (consumed) it, got {jd(c2).get("consumedAnnotationIds")}'
A_fused = ann_of_stroke(S_new)
assert ann_of_stroke(S_m) == A_fused, 'midrib stroke now belongs to the fused annotation'

# ── FINISH the new stroke (its OWN footprint is the off-tile vertex only). ─────────────────
r_fin = edit(S_new, final=True)
assert r_fin.status_code == 200, f'finish should be 200, got {r_fin.status_code}: {jd(r_fin)}'

# U1: the fused annotation touches a tile (via the midrib) -> KEEP, not discard.
assert jd(r_fin).get('discarded') is not True, \
    f'a fused annotation touching a tile must NOT be discarded on finish: {jd(r_fin)}'
# U2: the midrib survives — its stroke still has a live annotation, still tile-linked.
A_after = ann_of_stroke(S_m)
assert A_after and ann_alive(A_after), '*** t111 DATA LOSS: the midrib was deleted by finish ***'
assert tiles_of_ann(A_after) >= midrib_tiles, \
    f'the surviving annotation still occupies the midrib tiles, got {tiles_of_ann(A_after)} vs {midrib_tiles}'
print('U1/U2 OK — finishing an off-tile stroke keeps the co-fused on-tile midrib')

# ── U3: brush-parity regression guard — a LONE all-off-tile polyline still discards. ───────
c3 = create([[OFF_X, cy, 12]], label='lonely', sw=12)          # no fuse (unique label, off-tile)
S_lone = jd(c3)['createdStrokeId']
edit(S_lone, points=[[OFF_X, cy, 12], [OFF_X + 30, cy, 12]])
A_lone = ann_of_stroke(S_lone)
r_lone = edit(S_lone, final=True)
assert jd(r_lone).get('discarded') is True, \
    f'a lone all-off-tile stroke is still discarded (brush parity, t59 F2): {jd(r_lone)}'
assert not ann_alive(A_lone), 'the discarded lone stroke is gone'
print('U3 OK — brush-parity preserved: a lone all-off-tile stroke still discards')

print('\nt111 fused-finish data-loss contract tests passed.')
