"""t109 — surface broken/orphaned labels (one code path: orphaned painted labels folded
into INVALID compounds, shown in the editor + paintable in the annotator).

CONTRACT (RED until t109 lands — `fold_orphans`, the `broken` read surface, the
`brokenCompounds` payload field, and the annotator dropdown carrying broken labels do not
exist yet):

  O1. `taxonomy.fold_orphans(classes_json, painted)` — the PURE migration transform — folds
      each orphaned painted label (effective label matching no current compound) into an
      INVALID compound (name=label, color=snapshot color) and returns a repoint map pointing
      the orphaned annotations at the new compound. Idempotent.
  O2. `taxonomy_out(...)['broken']` lists the INVALID compounds projected to {id,name,color};
      `classes`/`compounds` (the valid palette) still EXCLUDE them.
  O3. A folded orphan's new compound_id RESOLVES via `compounds_by_id`, and its rendered
      name+color are UNCHANGED (no visible regression).
  O4. The project GET payload carries `brokenCompounds`; the annotate-canvas payload carries
      `broken` so the annotator dropdown can offer broken labels (paintable).
  O5. Deleting a broken compound that lesions reference -> 409 blockedCompoundId with no
      reassign; with a reassign target -> repoints + persists (existing t64 plumbing).

Standalone-script style (mirrors test_compound_id.py). The subagent implements against this;
it does NOT edit this test.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-orphan-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import json

import numpy as np
from PIL import Image
from webapp import db, app as appmod, taxonomy

# ── O1/O2/O3: PURE transform + read surface (no app needed) ──────────────────────────────
# A project taxonomy with ONE valid compound 'alpha'. 'lesion' is an orphan: painted, but no
# compound owns it. 'beta' is a compound gone INVALID (its member was deleted) but still
# referenced — already invalid without folding.
G = [{'id': 'g1', 'name': 'Class', 'required': True,
      'members': [{'id': 'm1', 'name': 'alpha'}]}]
C_ALPHA = {'id': 'cA', 'name': 'alpha', 'color': '#111111', 'selections': {'g1': 'm1'}}
C_BETA_INVALID = {'id': 'cB', 'name': 'beta', 'color': '#222222', 'selections': {'g1': 'mX'}}  # mX deleted
classes_json = json.dumps({'schema': 'compound-v2', 'groups': G,
                           'compounds': [C_ALPHA, C_BETA_INVALID]})

# painted rows: a1 valid 'alpha'; a2 orphan 'lesion' (bare label, snapshot carries its colour);
# a3 references the already-invalid 'beta' by compound_id.
painted = [
    {'id': 'a1', 'label': 'alpha', 'snapshot': {'name': 'alpha', 'color': '#111111'}, 'compound_id': 'cA'},
    {'id': 'a2', 'label': 'lesion', 'snapshot': {'name': 'lesion', 'color': '#abcdef'}, 'compound_id': None},
    {'id': 'a3', 'label': 'beta', 'snapshot': {'name': 'beta', 'color': '#222222'}, 'compound_id': 'cB'},
]

res = taxonomy.fold_orphans(classes_json, painted)
folded = res['classes_json']
repoint = res['repoint']

# O1: 'lesion' became an invalid compound; a2 repointed onto it; 'alpha'/'beta' untouched.
by_id = taxonomy.compounds_by_id(folded)
lesion_ids = [cid for cid, c in by_id.items() if taxonomy.compound_label(c, taxonomy.normalise_taxonomy(folded)['groups']) == 'lesion']
assert len(lesion_ids) == 1, f"exactly one 'lesion' compound expected, got {lesion_ids}"
lesion_cid = lesion_ids[0]
assert repoint.get('a2') == lesion_cid, f"a2 must repoint to the new 'lesion' compound, got {repoint.get('a2')!r}"
assert 'a1' not in repoint and 'a3' not in repoint, 'only the orphan a2 is repointed'
print('O1 OK — orphan folded into an invalid compound + repointed')

# O2: broken read surface lists 'lesion' AND the already-invalid 'beta'; palette excludes both.
tax = taxonomy.taxonomy_out(folded)
broken_names = {b['name'] for b in tax['broken']}
assert broken_names == {'lesion', 'beta'}, f"broken must be lesion+beta, got {broken_names}"
assert {c['name'] for c in tax['compounds']} == {'alpha'}, 'valid palette is alpha only'
assert {c['name'] for c in tax['classes']} == {'alpha'}, 'classes projection excludes broken'
lesion_broken = next(b for b in tax['broken'] if b['name'] == 'lesion')
assert lesion_broken['color'] == '#abcdef', f"lesion keeps its snapshot colour, got {lesion_broken['color']}"
print('O2 OK — broken surface lists both broken labels; valid palette excludes them')

# O3: the folded orphan resolves live to the SAME name+colour (no render change).
snap = taxonomy.resolve_compound_snapshot(folded, lesion_cid)
assert snap and snap['name'] == 'lesion' and snap['color'] == '#abcdef', f'lesion resolves unchanged, got {snap}'
# idempotent: re-folding does not add a second 'lesion'.
res2 = taxonomy.fold_orphans(folded, painted)
by_id2 = taxonomy.compounds_by_id(res2['classes_json'])
lesion_ct = sum(1 for c in by_id2.values()
                if taxonomy.compound_label(c, taxonomy.normalise_taxonomy(res2['classes_json'])['groups']) == 'lesion')
assert lesion_ct == 1, f'fold_orphans is idempotent (one lesion), got {lesion_ct}'
print('O3 OK — folded orphan resolves unchanged; fold is idempotent')

# ── O4/O5: API — broken carried in both payloads + delete/reassign ───────────────────────
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


# Project starts with alpha (valid) + beta (invalid). Paint alpha, then hand-craft an orphan
# 'lesion' row directly (the API can't create orphans post-t64 delete-guard — this simulates
# legacy data), then fold via the API-visible path (a re-save / the migration equivalent).
r = client.post('/api/projects', json={'name': 'Orphans', 'tile_size_px': 128,
                                        'groups': G, 'compounds': [C_ALPHA, C_BETA_INVALID]})
pid = j(r)['id']
client.post(f'/api/projects/{pid}/images/upload',
            data={'files': [(io.BytesIO(_leaf_png()), 'leaf.png', 'image/png')]},
            content_type='multipart/form-data').get_data()

proj = j(client.get(f'/api/projects/{pid}'))
# O4a: the editor payload carries brokenCompounds (beta is invalid).
assert 'brokenCompounds' in proj, 'project GET must carry brokenCompounds'
assert {b['name'] for b in proj['brokenCompounds']} == {'beta'}, \
    f"brokenCompounds should list beta, got {proj.get('brokenCompounds')}"
assert {c['name'] for c in proj['compounds']} == {'alpha'}, 'valid palette excludes beta'
print('O4a OK — project GET carries brokenCompounds; palette excludes them')

# O4b: the annotate-canvas payload carries `broken` so the dropdown can paint a broken label.
image_id = proj['images'][0]['id']
batch_id = j(client.post(f'/api/projects/{pid}/batches', json={'size': 16}))['id']
canvas = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))
assert 'broken' in canvas, 'annotate-canvas payload must carry broken labels for the dropdown'
assert {b['name'] for b in canvas['broken']} == {'beta'}, \
    f"canvas broken should list beta, got {canvas.get('broken')}"
print('O4b OK — annotate-canvas payload carries broken labels (paintable)')

# O5: deleting the broken 'beta' — a reference exists (paint it first so beta is referenced).
# Painting a BROKEN label works today (resolution matches the full compound list) — that's the
# annotator-carry behaviour Christian wants; it also makes beta referenced for the delete-guard.
img = canvas['images'][0]
t0 = img['tiles'][0]
cx, cy = t0['x'] + t0['w'] // 2, t0['y'] + t0['h'] // 2
c = client.post(f'/api/projects/{pid}/annotations', json={
    'imageId': image_id, 'annotator': 'alice', 'kind': 'stroke', 'points': [[cx, cy]],
    'label': 'beta', 'strokeWidth': 12, 'tool': 'brush',
    'viewport': {'x': t0['x'], 'y': t0['y'], 'w': t0['w'], 'h': t0['h']}})
assert c.status_code == 201, f'painting the broken label beta should succeed: {j(c)}'


def save_tax(compounds, reassign=None):
    body = {'groups': G, 'compounds': compounds}
    if reassign is not None:
        body['reassignCompounds'] = reassign
    return client.patch(f'/api/projects/{pid}', json=body)


# Drop beta (delete the broken label) with NO reassign -> 409 naming it.
r = save_tax([C_ALPHA])
assert r.status_code == 409, f'dropping a referenced broken compound must 409, got {r.status_code}'
assert j(r).get('blockedCompoundId') == 'cB', f"blockedCompoundId should be cB, got {j(r)}"
print('O5a OK — deleting a referenced broken compound is blocked (409 blockedCompoundId)')

# With a reassign to alpha -> repoints + persists; beta gone, no orphaned lesion.
r = save_tax([C_ALPHA], reassign={'cB': 'cA'})
assert r.status_code == 200, f'reassigning then deleting broken must succeed, got {r.status_code}: {j(r)}'
after = j(client.get(f'/api/projects/{pid}'))
assert {c['name'] for c in after['compounds']} == {'alpha'}, 'beta removed'
assert not after.get('brokenCompounds'), f'no broken compounds remain, got {after.get("brokenCompounds")}'
live = j(client.get(f'/api/batches/{batch_id}?annotator=alice'))['images'][0]['annotations']
assert all(a.get('label') == 'alpha' for a in live), f'the beta lesion repointed to alpha, got {live}'
print('O5b OK — reassign repoints the lesion + removes the broken compound')

print('ALL ORPHAN-LABEL CONTRACTS PASS')
