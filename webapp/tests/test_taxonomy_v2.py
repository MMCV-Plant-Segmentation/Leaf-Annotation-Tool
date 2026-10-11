"""Backend acceptance test for taxonomy v2 (compound labels) + the migration.

Covers the Phase-1 behaviours the task spec requires:

  V1. A project can define >=2 groups with members and mark a group REQUIRED; the read
      surface returns groups + compounds + the legacy flat `classes` projection.

  V2. Build/save/colour compounds with required-group enforcement: a compound missing a
      required group is INVALID and never appears in the paint palette (`classes` /
      `compounds`), while a complete one round-trips its name + colour.

  V3. Painting with a compound snapshots {name, color, selections} into the annotation's
      SINGLE `label_snapshot` column; the lesion renders in the compound's colour
      (labelColor) and the snapshot round-trips. Per-group selections are queryable.

  V4. A pre-existing FLAT-label project (legacy string-array `classes_json`) auto-migrates
      on read: its labels become single-group compounds with the SAME names + colours, and
      a single-group project behaves exactly like today (flat `classes` unchanged). The
      migration is idempotent (re-read is a no-op) and existing lesions keep rendering.

  V5. Deleting a REFERENCED preset is REJECTED without a reassignment target (t64 — no silent
      orphan); V5b: with a `reassignCompounds` target the lesion re-points to it. (Full
      delete/reassign matrix in test_compound_id.py C4–C6.)

  V6. The `annotation.label_snapshot` column exists (migration 0004 ran) and persists the
      label + selections in one serialized (JSON, base64-friendly) column.

Standalone-script style (mirrors test_taxonomy.py / test_backend.py): env-first setup,
ephemeral temp data dir, auto_create_schema(), Flask test client, print PASS lines, exit
non-zero on the first failure (bare asserts).

Run with: uv run python webapp/tests/test_taxonomy_v2.py
"""

import base64
import io
import json
import os
import tempfile
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='leaf-anno-taxv2-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from webapp import db as dbmod
from webapp import app as appmod
from webapp import taxonomy

dbmod.auto_create_schema()
dbmod.migrate_meta()

# Seed a real admin user so created_by_user_id FK + session user_id are valid.
_c = dbmod.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.commit()
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


# Per-project counter so each seed writes a distinct file (distinct hash) — avoids the
# content-addressed dedup across the two projects seeded in this test.
_seed_counter = {'n': 0}


def _seed_images_and_batch(pid: str) -> tuple[str, str]:
    """Import one leaf-shaped PNG (via the synchronous path import), confirm tiling,
    create a batch -> (imageId, batchId).

    Uses the buffered path-import (admin) endpoint rather than the streaming upload so the
    import commit is synchronous and visible to the immediate follow-up GET.
    """
    _seed_counter['n'] += 1
    src = Path(TMP) / f'leaf_{pid[:8]}_{_seed_counter["n"]}.png'
    src.write_bytes(_make_leaf_png_bytes())
    r = client.post(f'/api/projects/{pid}/images/import', json={'path': str(src)})
    assert r.status_code == 200, _j(r)
    assert _j(r)['imported'] == 1, _j(r)
    # Confirm tiling with defaults (unlocks batches).
    r = client.patch(f'/api/projects/{pid}', json={'black_threshold': 0})
    assert r.status_code == 200, _j(r)
    r = client.post(f'/api/projects/{pid}/batches', json={'size': 5})
    assert r.status_code == 201, _j(r)
    batch_id = _j(r)['id']
    img_id = _j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
    return img_id, batch_id


# ── V1: >=2 groups, one required, read surface ───────────────────────────────
print('\n── V1: define >=2 groups + members, mark one required ──')

g1 = {'id': 'g-type', 'name': 'Type', 'order': 0, 'required': True,
      'members': [{'id': 'm-lesion', 'name': 'lesion', 'order': 0},
                  {'id': 'm-midrib', 'name': 'midrib', 'order': 1}]}
g2 = {'id': 'g-sev', 'name': 'Severity', 'order': 1, 'required': False,
      'members': [{'id': 's-high', 'name': 'high', 'order': 0}]}
body = {'name': 'TaxV2', 'tile_size_px': 64, 'groups': [g1, g2], 'compounds': []}
r = client.post('/api/projects', json=body)
assert r.status_code == 201, _j(r)
pid = _j(r)['id']
proj = _j(client.get(f'/api/projects/{pid}'))
print('  groups =', [g['name'] for g in proj['groups']])
assert len(proj['groups']) == 2, proj['groups']
assert proj['groups'][0]['name'] == 'Type' and proj['groups'][0]['required'] is True
assert proj['groups'][1]['name'] == 'Severity' and proj['groups'][1]['required'] is False
assert [m['name'] for m in proj['groups'][0]['members']] == ['lesion', 'midrib']
# Members carry NO colour.
assert all('color' not in m for g in proj['groups'] for m in g['members'])
print('  ✓  two groups with members; required flag honoured; members colourless')


# ── V2: build/save/colour compounds with required-group enforcement ─────────
print('\n── V2: compound required-validation blocks invalid compounds ──')

# A compound selecting only the optional group → INVALID (missing required 'Type').
bad = {'id': 'c-bad', 'name': 'bad', 'color': '#000000',
       'selections': {'g-sev': 's-high'}}
# A complete compound selecting the required group (optional included) → VALID.
good = {'id': 'c-good', 'name': 'lesion-high', 'color': '#dc2626',
        'selections': {'g-type': 'm-lesion', 'g-sev': 's-high'}}
# A compound selecting only the required group → VALID (optional may be omitted).
minimal = {'id': 'c-min', 'name': 'lesion', 'color': '#16a34a',
           'selections': {'g-type': 'm-lesion'}}
r = client.patch(f'/api/projects/{pid}',
                 json={'groups': [g1, g2], 'compounds': [bad, good, minimal]})
assert r.status_code == 200, _j(r)
proj = _j(client.get(f'/api/projects/{pid}'))
palette_names = [c['name'] for c in proj['compounds']]
print('  paintable compounds =', palette_names)
assert 'bad' not in palette_names, 'invalid compound leaked into palette'
assert set(palette_names) == {'lesion-high', 'lesion'}, palette_names
# The flat `classes` projection mirrors the valid palette (single-group parity).
cls_names = [c['name'] for c in proj['classes']]
assert set(cls_names) == {'lesion-high', 'lesion'}, cls_names
# Colour round-trips.
good_out = next(c for c in proj['compounds'] if c['name'] == 'lesion-high')
assert good_out['color'].lower() == '#dc2626', good_out
print('  ✓  invalid compound hidden; valid ones keep name+colour; classes mirrors palette')


# ── V3: painting snapshots {name,color,selections} in one column; round-trips ─
print('\n── V3: painting snapshots the compound into label_snapshot ──')

img_id, batch_id = _seed_images_and_batch(pid)
# Paint a brush stroke labelled 'lesion-high' (the valid compound).
r = client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': img_id, 'annotator': 'admin', 'kind': 'stroke',
    'points': [[20, 20], [60, 60]], 'label': 'lesion-high', 'passNo': 1,
    'strokeWidth': 8, 'outline': [[10, 10], [70, 10], [70, 70], [10, 70]],
})
assert r.status_code == 201, _j(r)
ann = _j(r)
print('  labelColor =', ann.get('labelColor'), '| snapshot name =',
      (ann.get('labelSnapshot') or {}).get('name'))
assert ann.get('labelColor', '').lower() == '#dc2626', ann
snap = ann['labelSnapshot']
assert snap['name'] == 'lesion-high'
assert snap['color'].lower() == '#dc2626'
assert snap['selections']['g-type']['memberName'] == 'lesion'
assert snap['selections']['g-sev']['memberName'] == 'high'
# Per-group selections are queryable (group + member names resolved at snapshot time).
assert snap['selections']['g-type']['groupName'] == 'Type'
print('  ✓  snapshot stored on the lesion; labelColor + selections round-trip')

# The batch canvas read surfaces the same snapshot + colour.
batch = _j(client.get(f'/api/batches/{batch_id}?annotator=admin'))
found = [a for im in batch['images'] for a in im['annotations']]
assert found and found[0]['labelColor'] and found[0]['labelSnapshot']['name'] == 'lesion-high'
# The batch canvas also surfaces the compounds palette.
assert any(c['name'] == 'lesion-high' for c in batch['compounds']), batch['compounds']
print('  ✓  batch canvas read surfaces snapshot colour + the compounds palette')

# V6: the snapshot lives in the SINGLE label_snapshot column (JSON, base64-friendly).
con = dbmod.get_db()
row = con.execute('SELECT label_snapshot FROM annotation WHERE id = ?', (ann['id'],)).fetchone()
dbmod.close_db(con)
assert row['label_snapshot'] is not None
raw_snap = json.loads(row['label_snapshot'])
assert raw_snap['name'] == 'lesion-high' and raw_snap['selections']['g-type']['memberName'] == 'lesion'
# base64-friendly: the column is plain JSON text (round-trips through base64 cleanly).
assert isinstance(base64.b64encode(row['label_snapshot'].encode()).decode(), str)
print('  ✓  snapshot persisted in the single label_snapshot column (JSON/base64-friendly)')


# ── V4: flat-label project auto-migrates; idempotent; lesions keep rendering ─
print('\n── V4: flat-label project auto-migrates and behaves unchanged ──')

pid2 = _j(client.post('/api/projects', json={'name': 'FlatLegacy', 'tile_size_px': 64}))['id']
# Plant a legacy string-array classes_json (the pre-v2 prod shape).
con = dbmod.get_db()
con.execute("UPDATE project SET classes_json = ? WHERE id = ?",
            (json.dumps(['lesion', 'midrib', 'uncertain']), pid2))
con.commit()
dbmod.close_db(con)

proj2 = _j(client.get(f'/api/projects/{pid2}'))
# Flat `classes` unchanged: same names, colours filled, contiguous order.
flat_names = [c['name'] for c in proj2['classes']]
assert flat_names == ['lesion', 'midrib', 'uncertain'], flat_names
# Wrapped into ONE default group named 'Class', each old label a member + a compound.
assert len(proj2['groups']) == 1 and proj2['groups'][0]['name'] == 'Class', proj2['groups']
member_names = [m['name'] for m in proj2['groups'][0]['members']]
assert member_names == ['lesion', 'midrib', 'uncertain'], member_names
compound_names = [c['name'] for c in proj2['compounds']]
assert compound_names == ['lesion', 'midrib', 'uncertain'], compound_names
# Each migrated compound KEEPS a colour (filled from the palette).
assert all(c['color'].startswith('#') for c in proj2['compounds'])
print('  ✓  flat labels → one Class group + per-label compounds (same names+colours)')

# Idempotent: writing the upgraded form then re-reading is a no-op.
client.patch(f'/api/projects/{pid2}', json={'classes': proj2['classes']})
proj2b = _j(client.get(f'/api/projects/{pid2}'))
assert [c['name'] for c in proj2b['classes']] == ['lesion', 'midrib', 'uncertain']
assert [c['name'] for c in proj2b['compounds']] == ['lesion', 'midrib', 'uncertain']
print('  ✓  migration idempotent (write-upgraded then re-read is a no-op)')

# A legacy lesion (bare label text) keeps rendering; a single-group migrated compound
# snapshots cleanly too (colour = the migrated colour).
img2, batch2 = _seed_images_and_batch(pid2)
r = client.post(f'/api/projects/{pid2}/annotations', json={
    'imageId': img2, 'annotator': 'admin', 'kind': 'stroke',
    'points': [[20, 20], [60, 60]], 'label': 'midrib', 'passNo': 1,
    'strokeWidth': 8, 'outline': [[10, 10], [70, 10], [70, 70], [10, 70]],
})
assert r.status_code == 201, _j(r)
legacy_ann = _j(r)
assert legacy_ann['label'] == 'midrib'
assert legacy_ann['labelSnapshot'] is not None
assert legacy_ann['labelSnapshot']['name'] == 'midrib'
assert legacy_ann['labelColor'].startswith('#')
print('  ✓  legacy lesion renders; migrated single-group compound snapshots too')


# ── V5: deleting a REFERENCED preset is REJECTED without a reassignment target (t64) ──
# SUPERSEDES the old "delete → lesion keeps rendering via a frozen snapshot" policy: t64 no
# longer silently orphans lesions. The full delete/reassign matrix (unreferenced-free / no-target
# / with-target) lives in test_compound_id.py C4–C6; here we pin it against this file's fixtures.
print('\n── V5: deleting a referenced preset with no target is rejected ──')

# Try to remove 'lesion-high' (c-good) — the painted lesion above references it.
r = client.patch(f'/api/projects/{pid}',
                 json={'groups': [g1, g2], 'compounds': [minimal]})
assert 400 <= r.status_code < 500, f'referenced-compound delete without a target must 4xx: {r.status_code} {_j(r)}'
assert 'c-good' in str(_j(r)) or 'lesion-high' in str(_j(r)), _j(r)  # the error names the blocked compound
# The rejected delete left the compound in place; the lesion keeps resolving to it LIVE.
proj = _j(client.get(f'/api/projects/{pid}'))
assert 'lesion-high' in [c['name'] for c in proj['compounds']], proj['compounds']
batch = _j(client.get(f'/api/batches/{batch_id}?annotator=admin'))
found = [a for im in batch['images'] for a in im['annotations']]
assert found, 'lesion vanished'
assert found[0]['label'] == 'lesion-high', found[0]
assert found[0]['labelColor'].lower() == '#dc2626', found[0]
print('  ✓  referenced-compound delete without a target is rejected; lesion intact')


# ── V5b: deleting a REFERENCED preset WITH a reassignment target re-points the lesion (t64) ──
print('\n── V5b: reassign-then-delete re-points the lesion to the target ──')

# Drop 'lesion-high' (c-good) AND reassign its lesions to 'lesion' (c-min) in one save.
r = client.patch(f'/api/projects/{pid}',
                 json={'groups': [g1, g2], 'compounds': [minimal],
                       'reassignCompounds': {'c-good': 'c-min'}})
assert r.status_code == 200, _j(r)
proj = _j(client.get(f'/api/projects/{pid}'))
assert 'lesion-high' not in [c['name'] for c in proj['compounds']], proj['compounds']
# The painted lesion is re-pointed to 'lesion' and now resolves to ITS name + colour, LIVE.
batch = _j(client.get(f'/api/batches/{batch_id}?annotator=admin'))
found = [a for im in batch['images'] for a in im['annotations']]
assert found[0]['label'] == 'lesion', found[0]
assert found[0]['labelColor'].lower() == '#16a34a', found[0]
assert found[0]['labelSnapshot']['selections']['g-type']['memberName'] == 'lesion', found[0]
print('  ✓  reassign-then-delete: lesion re-points to the target compound (live)')


print('\n\nALL TAXONOMY-V2 BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
