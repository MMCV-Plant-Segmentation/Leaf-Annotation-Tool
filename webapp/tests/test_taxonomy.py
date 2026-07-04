"""
Backend acceptance test for the per-project label taxonomy (Option A).

Covers the three behaviours the taxonomy layer must guarantee:

  T1. Read + write a project's label set through the API/object format:
      POST /api/projects with a `classes` body of canonical objects, then PATCH the
      set and read it back — each label is `{id,name,color,order}` round-tripped.

  T2. The OLD `classes_json` string-array form (e.g. '["lesion","midrib"]') upgrades
      transparently to the NEW object form on read (lazy upgrade), with ids/colors/
      order filled in. We plant the legacy string directly into the DB column and read
      the project back through the API.

  T3. A brand-new / empty project defaults to a single REMOVABLE `unknown` label — no
      hardcoded lesion/midrib/uncertain. Creating a project with no `classes` (and with
      an explicit empty list) yields exactly one `unknown` label.

Standalone-script style (mirrors test_backend.py / test_health.py): env-first setup,
ephemeral temp data dir, auto_create_schema(), Flask test client, print PASS lines,
exit non-zero on the first failure (bare asserts).

Run with: uv run python webapp/tests/test_taxonomy.py
"""

import os
import json
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-tax-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from webapp import db as dbmod
from webapp import app as appmod
from webapp import taxonomy

dbmod.auto_create_schema()
dbmod.migrate_meta()

# Seed a real admin user so the created_by_user_id FK is satisfied and the login
# session has a valid user_id (mirrors test_backend.py).
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


# ── T1: read + write a project's label set (canonical object form) ──────────
print('\n── T1: write then read back a canonical label set ──')

labels_in = [
    {'id': 'lbl-lesion', 'name': 'lesion', 'color': '#dc2626', 'order': 0},
    {'id': 'lbl-midrib', 'name': 'midrib', 'color': '#16a34a', 'order': 1},
]
r = client.post('/api/projects', json={
    'name': 'TaxRW', 'tile_size_px': 64, 'black_threshold': 0, 'classes': labels_in,
})
assert r.status_code == 201, _j(r)
pid = _j(r)['id']
out = _j(r)['classes']
print('  created classes =', out)
assert isinstance(out, list) and len(out) == 2, out
for got, want in zip(out, labels_in):
    assert got['id'] == want['id'], got
    assert got['name'] == want['name'], got
    assert got['color'].lower() == want['color'].lower(), got
    assert got['order'] == want['order'], got
print('  ✓  POST round-trips the canonical object list')

# PATCH a new set (rename + add + recolour) and read it back via GET.
patched = [
    {'id': 'lbl-lesion', 'name': ' lesion ', 'color': '#000000', 'order': 0},
    {'id': 'lbl-midrib', 'name': 'midrib', 'color': '#16a34a', 'order': 1},
    {'id': 'lbl-new', 'name': 'rust', 'color': '#d97706', 'order': 2},
]
r = client.patch(f'/api/projects/{pid}', json={'classes': patched})
assert r.status_code == 200, _j(r)
got = _j(client.get(f'/api/projects/{pid}'))['classes']
print('  after PATCH classes =', got)
assert [g['name'] for g in got] == ['lesion', 'midrib', 'rust'], got  # name trimmed
assert got[0]['color'] == '#000000', got
assert [g['order'] for g in got] == [0, 1, 2], got
print('  ✓  PATCH trims/extends/recolours and reads back correctly')


# ── T2: OLD string-array `classes_json` upgrades to object form on read ──────
print('\n── T2: legacy string-array classes_json upgrades on read ──')

pid2 = _j(client.post('/api/projects', json={'name': 'TaxLegacy', 'tile_size_px': 64}))['id']
con = dbmod.get_db()
con.execute(
    "UPDATE project SET classes_json = ? WHERE id = ?",
    (json.dumps(['lesion', 'midrib', 'uncertain']), pid2),
)
con.commit()
dbmod.close_db(con)

got2 = _j(client.get(f'/api/projects/{pid2}'))['classes']
print('  upgraded classes =', got2)
assert isinstance(got2, list) and len(got2) == 3, got2
assert [g['name'] for g in got2] == ['lesion', 'midrib', 'uncertain'], got2
for i, g in enumerate(got2):
    assert isinstance(g['id'], str) and g['id'], g          # id filled in
    assert g['color'].startswith('#') and len(g['color']) == 7, g  # color filled in
    assert g['order'] == i, g                                # contiguous order re-stamped
# classes_json is NOT mutated by a pure read (lazy upgrade; persisted on next write).
con = dbmod.get_db()
raw = con.execute('SELECT classes_json FROM project WHERE id = ?', (pid2,)).fetchone()['classes_json']
dbmod.close_db(con)
assert json.loads(raw) == ['lesion', 'midrib', 'uncertain'], raw
print('  ✓  string-array upgraded to objects; raw column left untouched by read')

# Now a write (PATCH) persists the upgraded object form.
client.patch(f'/api/projects/{pid2}', json={'classes': got2})
con = dbmod.get_db()
raw2 = con.execute('SELECT classes_json FROM project WHERE id = ?', (pid2,)).fetchone()['classes_json']
dbmod.close_db(con)
stored = json.loads(raw2)
assert isinstance(stored, list) and all(isinstance(s, dict) for s in stored), stored
assert stored[0].get('name') == 'lesion', stored
assert stored[0].get('color', '').startswith('#'), stored
print('  ✓  write persists the upgraded object form to classes_json')


# ── T3: new/empty project defaults to a single removable `unknown` label ────
print('\n── T3: new/empty project seeds a single removable `unknown` ──')

# (a) no `classes` key at all.
r = client.post('/api/projects', json={'name': 'TaxEmpty1', 'tile_size_px': 64})
assert r.status_code == 201, _j(r)
c1 = _j(r)['classes']
print('  no-classes default =', c1)
assert len(c1) == 1 and c1[0]['name'] == 'unknown', c1
assert {'lesion', 'midrib', 'uncertain'}.isdisjoint({x['name'] for x in c1}), c1
print('  ✓  omitted classes → single unknown (no lesion/midrib/uncertain)')

# (b) explicit empty list.
r = client.post('/api/projects', json={'name': 'TaxEmpty2', 'tile_size_px': 64, 'classes': []})
assert r.status_code == 201, _j(r)
c2 = _j(r)['classes']
print('  empty-list default =', c2)
assert len(c2) == 1 and c2[0]['name'] == 'unknown', c2
print('  ✓  explicit [] → single unknown')

# (c) "unknown" is REMOVABLE: deleting it (writing []) leaves the stored column '[]',
#     and a subsequent read re-seeds 'unknown' (project is never truly label-less).
pid3 = _j(r)['id']
r = client.patch(f'/api/projects/{pid3}', json={'classes': []})
assert r.status_code == 200, _j(r)
con = dbmod.get_db()
raw3 = con.execute('SELECT classes_json FROM project WHERE id = ?', (pid3,)).fetchone()['classes_json']
dbmod.close_db(con)
assert json.loads(raw3) == [], raw3
re_read = _j(client.get(f'/api/projects/{pid3}'))['classes']
print('  after deleting all, read-back =', re_read)
assert len(re_read) == 1 and re_read[0]['name'] == 'unknown', re_read
print('  ✓  unknown is removable (empty write stored; read re-seeds unknown)')

# (d) sanity: the module-level normalise_classes agrees (no hardcoded trio anywhere).
seeded = taxonomy.normalise_classes(None)
assert [s['name'] for s in seeded] == ['unknown'], seeded
assert 'lesion' not in [s['name'] for s in seeded]
print('  ✓  taxonomy.normalise_classes(None) seeds only unknown')


print('\n\nALL TAXONOMY BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
