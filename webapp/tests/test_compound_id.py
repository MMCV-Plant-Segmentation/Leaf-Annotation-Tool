"""Annotations reference a compound by ID; composition immutable; delete-reassign (t64).

Christian, 2026-07-19. Today an annotation stores its label as a NAME string plus a frozen
`label_snapshot`; renaming a compound leaves old lesions showing the stale name/colour, and
deleting a referenced compound silently orphans lesions. The new model (see
docs/plans/Task — Annotations reference compound by ID; composition immutable (t64).md):

  C1. An annotation stores a stable `annotation.compound_id` (new column, migration 0009).
      Painting resolves the label NAME the FE sends to the matching compound and stores its id.

  C2. Display resolves {name,color,selections} LIVE by compound_id from the CURRENT taxonomy —
      so renaming/recolouring a compound flows through to every annotation using it (no stale
      snapshot). `label_snapshot` is demoted to a migration-only fallback.

  C3. A saved compound's COMPOSITION (its `selections`) is IMMUTABLE — editing an existing
      compound (same id) may change name+colour but NEVER its selections. (Changing composition
      is done by creating a NEW compound id.)

  C4. Deleting an UNREFERENCED compound needs no ceremony — it just goes (no reassignment prompt;
      only bother the user "when data loss would occur otherwise").

  C5. Deleting a REFERENCED compound with NO reassignment target is REJECTED (4xx naming the
      blocked compound) — never a silent orphan.

  C6. Deleting a REFERENCED compound WITH a reassignment target (a `reassignCompounds` map on the
      taxonomy-save request) re-points the referencing annotations to the target compound, then
      removes the original. The re-pointed lesion then resolves to the target's name/colour.

RED until t64 lands: there is no `compound_id` column, resolution is frozen-snapshot, and the
save path neither enforces immutability nor guards referenced-compound deletion.

Standalone-script style (mirrors test_taxonomy_v2.py / test_polyline_perclick.py). The subagent
implements against this; it does NOT edit this test.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-compid-test-')
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


def _leaf_png(w=260, h=220) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# ── fixed taxonomy: one required group with three members; three compounds ───────────────
G = [{'id': 'g1', 'name': 'Class', 'required': True, 'members': [
    {'id': 'm1', 'name': 'alpha'}, {'id': 'm2', 'name': 'gamma'}, {'id': 'm3', 'name': 'delta'}]}]
CA = {'id': 'cA', 'name': 'alpha', 'color': '#111111', 'selections': {'g1': 'm1'}}
CB = {'id': 'cB', 'name': 'gamma', 'color': '#222222', 'selections': {'g1': 'm2'}}
CC = {'id': 'cC', 'name': 'delta', 'color': '#444444', 'selections': {'g1': 'm3'}}

r = client.post('/api/projects', json={'name': 'CompoundId', 'tile_size_px': 128,
                                       'groups': G, 'compounds': [CA, CB, CC]})
pid = j(r)['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()
image_id = j(client.get(f'/api/projects/{pid}'))['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
t0 = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['tiles'][0]
cx, cy = t0['x'] + t0['w'] // 2, t0['y'] + t0['h'] // 2


def save_tax(compounds, reassign=None):
    body = {'groups': G, 'compounds': compounds}
    if reassign is not None:
        body['reassignCompounds'] = reassign
    return client.patch(f'/api/projects/{pid}', json=body)


def compounds_now():
    return {c['id']: c for c in j(client.get(f'/api/projects/{pid}'))['compounds']}


def the_ann():
    live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
    assert len(live) == 1, f'expected exactly one painted annotation, got {len(live)}'
    return live[0]


def compound_id_of(aid):
    con = db.get_db()
    try:
        row = con.execute('SELECT compound_id FROM annotation WHERE id = ?', (aid,)).fetchone()
        return row['compound_id'] if row else None
    finally:
        db.close_db(con)


# paint a lesion with compound 'alpha' (on-tile brush)
c = client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': [[cx, cy]],
    'label': 'alpha', 'strokeWidth': 12, 'tool': 'brush',
    'viewport': {'x': t0['x'], 'y': t0['y'], 'w': t0['w'], 'h': t0['h']}})
assert c.status_code == 201, f'paint failed: {j(c)}'
aid = j(c)['id']


# ── C1: the annotation stores compound_id == cA (column exists + create resolves it) ─────
assert compound_id_of(aid) == 'cA', \
    f"painting 'alpha' must store compound_id 'cA', got {compound_id_of(aid)!r}"
print('C1 OK — annotation stores a stable compound_id')


# ── C2: live resolution — renaming/recolouring the compound flows through to the lesion ──
CA2 = {'id': 'cA', 'name': 'alpha2', 'color': '#333333', 'selections': {'g1': 'm1'}}
assert save_tax([CA2, CB, CC]).status_code == 200
a = the_ann()
assert a['label'] == 'alpha2', f"label resolves LIVE to the renamed compound, got {a['label']!r}"
assert a['labelColor'] == '#333333', f'colour resolves LIVE to the recoloured compound, got {a["labelColor"]!r}'
print('C2 OK — label + colour resolve live by compound_id (rename flows through)')


# ── C3: composition immutable — editing an existing compound's selections is not honoured ─
save_tax([{'id': 'cA', 'name': 'alpha2', 'color': '#333333', 'selections': {'g1': 'm2'}}, CB, CC])
assert compounds_now()['cA']['selections'] == {'g1': 'm1'}, \
    "a saved compound's selections are IMMUTABLE — the change to {g1:m2} must not stick"
print('C3 OK — compound composition is immutable (only name/colour editable)')


# ── C4: deleting an UNREFERENCED compound (cC) needs no reassignment ──────────────────────
r4 = save_tax([CA2, CB])                      # drop cC — nothing references it
assert r4.status_code == 200, f'dropping an unreferenced compound should just work: {j(r4)}'
assert 'cC' not in compounds_now(), 'cC is gone'
print('C4 OK — an unreferenced compound deletes freely (no prompt)')


# ── C5: deleting a REFERENCED compound (cA) with NO target is rejected, naming it ─────────
r5 = save_tax([CB])                           # drop cA — the lesion references it, no reassign
assert 400 <= r5.status_code < 500, \
    f'dropping a REFERENCED compound with no target must be rejected, got {r5.status_code}: {j(r5)}'
assert 'cA' in str(j(r5)), f'the rejection should name the blocked compound cA: {j(r5)}'
assert 'cA' in compounds_now(), 'the rejected delete left cA in place (no data loss)'
print('C5 OK — deleting a referenced compound with no target is rejected (no silent orphan)')


# ── C6: deleting a REFERENCED compound WITH a target re-points the lesions ────────────────
r6 = save_tax([CB], reassign={'cA': 'cB'})    # drop cA, move its lesions to cB
assert r6.status_code == 200, f'reassign-then-delete should succeed: {j(r6)}'
assert 'cA' not in compounds_now(), 'cA removed after reassignment'
assert compound_id_of(aid) == 'cB', f'the lesion is re-pointed to cB, got {compound_id_of(aid)!r}'
a = the_ann()
assert a['label'] == 'gamma' and a['labelColor'] == '#222222', \
    f'the re-pointed lesion now resolves to cB (gamma/#222222), got {a["label"]!r}/{a["labelColor"]!r}'
print('C6 OK — reassign-then-delete re-points lesions to the target compound')


print('\ncompound-id / immutability / delete-reassign contract tests passed.')
