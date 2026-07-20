"""Vertex snapping — PHASE 2a (BACKEND): shared-vertex references + id-stable reconciliation (t50).

Christian, 2026-07-20. Phase 1 normalized stroke vertices into `vertex`/`stroke_vertex` (each point a
DISTINCT vertex, no sharing). Phase 2 makes a draw-time SNAP lock vertices together by having the new
stroke reference the SAME `vertex` row as the one it snapped onto — shared identity, so moving that
vertex moves every stroke that references it (transitively). The FE (phase 2b) does the kdbush
nearest-vertex detection; THIS phase is the backend contract that lets a snap persist as a real shared
reference, plus the id-stable reconciliation the per-click polyline edit needs.

Model (see docs/plans/Task — Polyline vertex snapping (P-4 t50).md):
  - The read payload exposes a stable **`vertexIds`** array per stroke (parallel to `points`), so the
    FE can build its index (position → vertex id) and later reference an existing vertex.
  - Create/edit accept an optional **`vertexRefs`** array (parallel to `points`): per point, an existing
    vertex id to REFERENCE (a snap → shared/locked), or null to MINT a fresh vertex. Absent `vertexRefs`
    = mint all (phase-1 behaviour; back-compatible).
  - Writing a stroke RECONCILES rather than blindly re-mints: a point that refs an existing vertex id
    keeps that id (no re-mint), so ids are STABLE across the per-click polyline edits (a click re-sends
    the whole growing list) — otherwise every click would churn ids and break a lock another stroke made
    mid-draw. Orphaned vertices (referenced by no stroke after the write) are GC'd; SHARED ones survive.

Contract:
  P1. The read payload exposes one stable vertexId per point (parallel to points).
  P2. Creating a stroke whose point refs an existing vertex SHARES it (one vertex row, >=2 refs); both
      strokes read that vertex id at that point, at the shared canonical position.
  P3. Transitive: a third stroke referencing the same vertex → three refs to the one vertex.
  P4. Re-sending a stroke's OWN vertexIds as refs on edit keeps those ids stable (no re-mint) and does
      not orphan a vertex it shares with another stroke.
  P5. Dropping a point (edit with fewer points, no ref) GCs its vertex IF now orphaned, but a shared
      vertex survives.

RED until phase 2a lands: reads expose no vertexIds; create/edit ignore vertexRefs; writing always
mints (phase 1). Standalone-script style. The subagent implements against this; it does NOT edit it.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-vsnap-test-')
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


pid = j(client.post('/api/projects', json={'name': 'VSnap', 'tile_size_px': 128}))['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
tx, ty, tw, th = t0['x'], t0['y'], t0['w'], t0['h']
cx, cy = tx + tw // 2, ty + th // 2


def make(points, refs=None, label='v', sw=12, tool='polyline'):
    body = {'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': points,
            'label': label, 'strokeWidth': sw, 'tool': tool,
            'viewport': {'x': tx, 'y': ty, 'w': tw, 'h': th}}
    if refs is not None:
        body['vertexRefs'] = refs
    r = client.post(f'/api/projects/{pid}/annotations', json=body)
    assert r.status_code == 201, f'create failed: {j(r)}'
    return j(r)


def stroke_id_of(annotation_id):
    con = db.get_db()
    try:
        return con.execute('SELECT id FROM stroke WHERE annotation_id = ?',
                           (annotation_id,)).fetchone()['id']
    finally:
        db.close_db(con)


def stroke_out(annotation_id):
    """The stroke payload the FE consumes: {points, vertexIds, ...}."""
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    a = next(x for x in live if x['id'] == annotation_id)
    return a['strokes'][0]


def stroke_out_by_sid(sid):
    """Resolve a stroke's payload by its STABLE stroke id. do_edit_stroke re-mints a fresh
    annotation id per component on every non-final edit (documented; test_polyline_edit.py works
    around the same churn), so a post-edit read must track the stroke, not a stale annotation id."""
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    for a in live:
        for st in a.get('strokes') or []:
            if st['id'] == sid:
                return st
    raise AssertionError(f'stroke {sid} not found under any live annotation')


def ref_count(vertex_id):
    con = db.get_db()
    try:
        return con.execute('SELECT COUNT(*) c FROM stroke_vertex WHERE vertex_id = ?',
                           (vertex_id,)).fetchone()['c']
    finally:
        db.close_db(con)


def vertex_exists(vertex_id):
    con = db.get_db()
    try:
        return con.execute('SELECT 1 FROM vertex WHERE id = ?', (vertex_id,)).fetchone() is not None
    finally:
        db.close_db(con)


# ── P1: the read payload exposes a stable vertexId per point ─────────────────────────────
aA = make([[cx - 40, cy, 10.0], [cx, cy - 10, 12.0], [cx + 40, cy, 14.0]], label='p1')
soA = stroke_out(aA['id'])
assert 'vertexIds' in soA and len(soA['vertexIds']) == len(soA['points']) == 3, \
    f"read must expose one vertexId per point, got {soA.get('vertexIds')}"
assert len(set(soA['vertexIds'])) == 3, 'the three points must have three distinct vertex ids'
vA0, vA1, vA2 = soA['vertexIds']
assert ref_count(vA0) == 1, 'a freshly created vertex is referenced once'
print('P1 OK — read exposes a stable vertexId per point')

# ── P2: creating a stroke that REFS an existing vertex SHARES it (the lock) ────────────────
# B's first point snaps onto A's first vertex (same coords + a ref to vA0); the rest are fresh.
aB = make([[cx - 40, cy, 16.0], [cx - 40, cy + 50, 16.0]], refs=[vA0, None], label='p2')
soB = stroke_out(aB['id'])
assert soB['vertexIds'][0] == vA0, f"B's snapped point must reference the SAME vertex vA0, got {soB['vertexIds'][0]}"
assert ref_count(vA0) == 2, f'vA0 must now be shared by A and B (2 refs), got {ref_count(vA0)}'
assert soB['points'][0][0] == cx - 40 and soB['points'][0][1] == cy, \
    "B's snapped point reads at the shared vertex's canonical position"
assert soB['vertexIds'][1] != vA0 and ref_count(soB['vertexIds'][1]) == 1, "B's non-snapped point is its own fresh vertex"
print('P2 OK — a snap persists as a shared vertex reference (moving vA0 will move both)')

# ── P3: transitive — a third stroke on the same vertex makes a 3-cluster ───────────────────
aC = make([[cx - 40, cy, 8.0]], refs=[vA0], label='p3')
assert stroke_out(aC['id'])['vertexIds'][0] == vA0 and ref_count(vA0) == 3, \
    f'vA0 shared by A, B, C (3 refs), got {ref_count(vA0)}'
print('P3 OK — snapping is transitive (one vertex, three referencing strokes)')

# ── P4: re-sending a stroke's OWN vertexIds as refs keeps ids stable + doesn't orphan a share ─
sidA = stroke_id_of(aA['id'])
# Edit A, re-sending its existing three points with their known ids as refs (a no-op-shape edit).
re = client.patch(f'/api/projects/{pid}/strokes/{sidA}',
                  json={'points': [[cx - 40, cy, 10.0], [cx, cy - 10, 12.0], [cx + 40, cy, 14.0]],
                        'strokeWidth': 12, 'vertexRefs': [vA0, vA1, vA2]})
assert re.status_code == 200, f'edit should 200, got {re.status_code}: {j(re)}'
assert stroke_out_by_sid(sidA)['vertexIds'] == [vA0, vA1, vA2], 'ids must be STABLE across an edit that refs them (no re-mint)'
assert ref_count(vA0) == 3, f'vA0 still shared by A, B, C after the edit — not re-minted/orphaned, got {ref_count(vA0)}'
print('P4 OK — id-stable reconciliation (per-click edits never churn ids or break a share)')

# ── P5: dropping a point GCs its vertex if orphaned, but a shared vertex survives ──────────
# Edit A down to only its MIDDLE point: vA2 (A-only) is GC'd; vA0 survives even though A dropped it
# (B and C still reference it); vA1 survives (A still references it).
re = client.patch(f'/api/projects/{pid}/strokes/{sidA}',
                  json={'points': [[cx, cy - 10, 12.0]], 'strokeWidth': 12, 'vertexRefs': [vA1]})
assert re.status_code == 200, f'edit should 200, got {re.status_code}: {j(re)}'
assert not vertex_exists(vA2), "vA2 (referenced only by A, now dropped) must be GC'd"
assert vertex_exists(vA0) and ref_count(vA0) == 2, \
    f'vA0 must survive — still shared by B and C even though A dropped it, got refs={ref_count(vA0)}'
assert vertex_exists(vA1), 'vA1 (still referenced by A) must survive'
print('P5 OK — orphan GC drops dropped-and-unshared vertices, preserves shared ones')

print('\nALL VERTEX-SNAPPING PERSIST (phase 2a) CHECKS PASSED')
