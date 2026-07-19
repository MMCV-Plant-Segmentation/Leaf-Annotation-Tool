"""Polyline tile-deferral + finish contract (t59) — the BE side of the redesign.

Christian, 2026-07-19. Today the FIRST polyline click 422s the moment its footprint
touches no tile (`do_create_annotation` — "annotation must intersect at least one tile"),
which resets the per-click session and spuriously mints a second annotation. The new
model (see docs/plans/Task — Polyline defer-bounds-to-tool-stop (t59).md):

  F1. Off-tile clicks are ACCEPTED + persisted WHILE drawing — the create path no longer
      422s a polyline footprint that touches no tile. (Half the rendering logic is on the
      BE; the point is persisted, validated later.)

  F2. On FINISH (a `final: true` marker on the SAME stroke-edit path — NOT a new endpoint)
      a stroke that touches NO tile at all is DISCARDED, exactly like a no-tile brush
      stroke: the persisted annotation is deleted and the response signals the discard so
      the FE can surface the same notice the brush shows.

  F3. On FINISH a stroke that touches >=1 tile is KEPT (not discarded).

  F4. WHOLE-STROKE keep/discard, NOT per-point clipping: a stroke with one off-tile vertex
      but which still touches a tile is kept WHOLE — the off-tile vertex is retained, not
      pruned. ("Discard like brush" is all-or-nothing on the whole footprint.)

RED until t59 lands: F1 currently 422s; the `final` finish contract does not exist yet.
Standalone-script style (mirrors test_polyline_perclick.py): env-first setup, ephemeral
temp data dir, Flask test client, bare asserts, exit non-zero on first failure.

The subagent implements against this; it does NOT edit this test.
"""
import io
import json as _json
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-polyfin-test-')
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


def _leaf_png(w=260, h=220) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


r = client.post('/api/projects', json={'name': 'PolyFinish', 'tile_size_px': 128})
pid = jdump(r)['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = jdump(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = jdump(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = jdump(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2          # comfortably ON a tile
OFF = [2000, 2000]                            # far outside the image → intersects NO tile


def create(points, label, sw=12, expect=None):
    r2 = client.post(f'/api/projects/{pid}/annotations', json={
        'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
        'label': label, 'strokeWidth': sw, 'tool': 'polyline',
        'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}})
    if expect is not None:
        assert r2.status_code == expect, f'create expected {expect}, got {r2.status_code}: {jdump(r2)}'
    return r2


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


def stroke_points(sid):
    con = db.get_db()
    try:
        row = con.execute('SELECT points_json FROM stroke WHERE id = ?', (sid,)).fetchone()
        return _json.loads(row['points_json']) if row and row['points_json'] else []
    finally:
        db.close_db(con)


# ── F1: an off-tile FIRST click is accepted + persisted (was a 422 that reset the session) ──
c1 = create([OFF], label='f1', expect=201)
d1 = jdump(c1)
assert d1['kind'] == 'stroke', f'off-tile click still persists as a stroke, got {d1["kind"]!r}'
assert d1.get('strokes') and d1['strokes'][0]['id'], 'the off-tile click persisted a real stroke'
assert ann_alive(d1['id']), 'the off-tile annotation is live (persisted, not rejected)'
print('F1 OK — off-tile first click is accepted + persisted (no mid-draw 422)')


# ── F2: FINISH of an all-off-tile stroke discards it, like a no-tile brush stroke ───────────
c2 = create([OFF], label='f2', expect=201)
d2 = jdump(c2)
sid2, aid2 = d2['strokes'][0]['id'], d2['id']
# extend with another off-tile vertex, still touching no tile
r_ext = edit(sid2, points=[OFF, [2100, 2100]])
assert r_ext.status_code == 200, f'off-tile extend should be accepted, got {r_ext.status_code}: {jdump(r_ext)}'
r_fin = edit(sid2, final=True)
assert r_fin.status_code == 200, f'finish should return 200, got {r_fin.status_code}: {jdump(r_fin)}'
assert jdump(r_fin).get('discarded') is True, f'a no-tile stroke is discarded on finish: {jdump(r_fin)}'
assert not ann_alive(aid2), 'the discarded annotation is gone (deleted, same as a no-tile brush stroke)'
print('F2 OK — finish discards a no-tile stroke (brush-parity), signalling discarded=True')


# ── F3: FINISH of an on-tile stroke keeps it ────────────────────────────────────────────────
c3 = create([[cx, cy]], label='f3', expect=201)
d3 = jdump(c3)
sid3, aid3 = d3['strokes'][0]['id'], d3['id']
r_fin3 = edit(sid3, final=True)
assert r_fin3.status_code == 200, f'finish (on-tile) should be 200, got {r_fin3.status_code}: {jdump(r_fin3)}'
assert jdump(r_fin3).get('discarded') is not True, f'an on-tile stroke is NOT discarded: {jdump(r_fin3)}'
assert ann_alive(aid3), 'the on-tile annotation survives finish'
print('F3 OK — finish keeps an on-tile stroke')


# ── F4: WHOLE-STROKE, not per-point — an off-tile vertex on a tile-touching stroke is kept ──
c4 = create([[cx, cy]], label='f4', expect=201)
d4 = jdump(c4)
sid4, aid4 = d4['strokes'][0]['id'], d4['id']
r_ext4 = edit(sid4, points=[[cx, cy], OFF])   # one on-tile vertex, one off-tile vertex
assert r_ext4.status_code == 200, f'mixed extend accepted, got {r_ext4.status_code}: {jdump(r_ext4)}'
r_fin4 = edit(sid4, final=True)
assert r_fin4.status_code == 200, f'finish (mixed) 200, got {r_fin4.status_code}: {jdump(r_fin4)}'
assert jdump(r_fin4).get('discarded') is not True, 'a tile-touching stroke is kept even with an off-tile vertex'
assert ann_alive(aid4), 'the mixed stroke survives finish'
assert OFF in stroke_points(sid4), \
    'the off-tile vertex is RETAINED (whole-stroke keep, NOT per-point clipping)'
print('F4 OK — whole-stroke keep: off-tile vertex retained on a tile-touching stroke')


print('\npolyline finish/tile-deferral contract tests passed.')
