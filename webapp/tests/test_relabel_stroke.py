"""Backend acceptance test for compound labels Phase 2b: label-only PATCH of a fused
(brush) mask.

`PATCH /api/annotations/<id>` used to return 422 for ANY edit of a `kind='stroke'`
annotation — including a label-only relabel, which blocks the Phase 2b relabel UI
(select a painted lesion, pick a new compound in the same paint drop-down). This test
covers the loosened guard added in webapp/projects.py's `update_annotation`:

  R1. A label-only PATCH (body has `label`, no `points`) on a `stroke` annotation
      succeeds (200), updates the label AND its denormalised `label_snapshot` to the
      new compound's colour/selections, and the change persists (re-GET the batch
      canvas — the "reload" path — surfaces the new label+colour).
  R2. Relabelling a stroke whose tile was already `completed` re-opens it to `dirty`
      (same "editing reopens a completed tile" policy as every other mutation).
  R3. A PATCH that also carries `points` (any geometry edit) on a stroke still 422s —
      erase + redraw remains the only way to reshape a fused mask.

Standalone-script style (mirrors test_taxonomy_v2.py / test_backend.py): env-first
setup, ephemeral temp data dir, auto_create_schema(), Flask test client, print PASS
lines, exit non-zero on the first failure (bare asserts).

Run with: uv run python3 webapp/tests/test_relabel_stroke.py
"""

import io
import os
import tempfile
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='leaf-anno-relabel-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from webapp import db as dbmod
from webapp import app as appmod

dbmod.auto_create_schema()
dbmod.migrate_meta()

_c = dbmod.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (username) VALUES ('carol')")
_c.commit()
_USER_ID = {r['username']: r['id'] for r in _c.execute('SELECT id, username FROM users').fetchall()}
dbmod.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
client = app.test_client()

with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'


def _j(r):
    return r.get_json()


def _make_leaf_png_bytes() -> bytes:
    import numpy as np
    from PIL import Image
    arr = np.zeros((180, 200), np.uint8)
    arr[30:150, 20:180] = 210
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── Setup: a project with two compounds (single required group) + one batch/image ──
print('\n── setup: project with two compounds, seeded image + batch ──')

g1 = {'id': 'g-type', 'name': 'Type', 'order': 0, 'required': True,
      'members': [{'id': 'm-lesion', 'name': 'lesion', 'order': 0},
                  {'id': 'm-blight', 'name': 'blight', 'order': 1}]}
c_lesion = {'id': 'c-lesion', 'name': 'lesion', 'color': '#16a34a',
            'selections': {'g-type': 'm-lesion'}}
c_blight = {'id': 'c-blight', 'name': 'blight', 'color': '#dc2626',
            'selections': {'g-type': 'm-blight'}}
r = client.post('/api/projects', json={
    'name': 'Relabel', 'tile_size_px': 64, 'groups': [g1], 'compounds': [c_lesion, c_blight],
})
assert r.status_code == 201, _j(r)
pid = _j(r)['id']

# Carol is a real roster member (admin paints as her below) — annotator_tile rows are
# only minted for roster members, and R2 needs one to prove relabel reopens a completed
# tile.
r = client.post(f'/api/projects/{pid}/annotators', json={'user_id': _USER_ID['carol']})
assert r.status_code == 201, _j(r)

src = Path(TMP) / 'leaf.png'
src.write_bytes(_make_leaf_png_bytes())
r = client.post(f'/api/projects/{pid}/images/import', json={'path': str(src)})
assert r.status_code == 200 and _j(r)['imported'] == 1, _j(r)
r = client.patch(f'/api/projects/{pid}', json={'black_threshold': 0})
assert r.status_code == 200, _j(r)
r = client.post(f'/api/projects/{pid}/batches', json={'size': 5})
assert r.status_code == 201, _j(r)
batch_id = _j(r)['id']
img_id = _j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
print('  ✓  project + image + batch ready')


# ── Paint a stroke labelled 'lesion' (green) ─────────────────────────────────
print('\n── paint a stroke, then relabel it via label-only PATCH ──')

r = client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': img_id, 'annotator': 'carol', 'kind': 'stroke',
    'points': [[20, 20], [60, 60]], 'label': 'lesion', 'passNo': 1,
    'strokeWidth': 8, 'outline': [[10, 10], [70, 10], [70, 70], [10, 70]],
})
assert r.status_code == 201, _j(r)
ann = _j(r)
assert ann['label'] == 'lesion' and ann['labelColor'].lower() == '#16a34a', ann
ann_id = ann['id']
tile_id = ann['tileIds'][0]
print('  painted lesion:', ann_id, 'tile:', tile_id)

# Complete that tile (so R2 below can prove relabel re-opens it).
con = dbmod.get_db()
at_id = con.execute(
    "SELECT at.id FROM annotator_tile at JOIN batch_tile bt ON bt.id = at.batch_tile_id "
    "WHERE bt.tile_id = ? AND at.annotator = 'carol'", (tile_id,)).fetchone()['id']
dbmod.close_db(con)
assert _j(client.patch(f'/api/annotator-tiles/{at_id}', json={'state': 'completed'}))['state'] == 'completed'

# R3 (checked first, before relabelling): a geometry edit on a stroke still 422s, even
# when the body ALSO carries a label change.
r = client.patch(f'/api/annotations/{ann_id}', json={'points': [[21, 21], [61, 61]], 'label': 'blight'})
assert r.status_code == 422, _j(r)
print('  ✓  points/geometry PATCH on a stroke still 422s (erase+redraw only)')

# R1: label-only PATCH succeeds and re-snapshots to the new compound.
r = client.patch(f'/api/annotations/{ann_id}', json={'label': 'blight'})
assert r.status_code == 200, _j(r)
out = _j(r)
assert out['label'] == 'blight', out
assert out['labelColor'].lower() == '#dc2626', out
assert out['labelSnapshot']['name'] == 'blight', out
assert out['labelSnapshot']['selections']['g-type']['memberName'] == 'blight', out
print('  ✓  label-only PATCH relabels + re-snapshots (green → red)')

# Persists across a "reload" (fresh batch-canvas read).
batch = _j(client.get(f'/api/batches/{batch_id}?annotator=carol'))
found = next(a for im in batch['images'] for a in im['annotations'] if a['id'] == ann_id)
assert found['label'] == 'blight' and found['labelColor'].lower() == '#dc2626', found
print('  ✓  relabel survives a reload (fresh batch-canvas read)')

# R2: relabelling a completed tile reopens it (dirty) — same policy as any other edit.
con = dbmod.get_db()
state = con.execute('SELECT state FROM annotator_tile WHERE id = ?', (at_id,)).fetchone()['state']
dbmod.close_db(con)
assert state == 'dirty', f'relabel should reopen a completed tile, got {state}'
print('  ✓  relabelling a completed tile reopens it to dirty')

# The stroke's geometry (rings) is untouched by the label-only patch.
assert out['rings'] == ann['rings'], 'label-only relabel must not touch geometry'
print('  ✓  geometry (rings) unchanged by the label-only relabel')


print('\n\nALL RELABEL-STROKE BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
