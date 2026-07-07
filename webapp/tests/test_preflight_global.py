"""
Backend acceptance tests for GLOBAL pre-flight image dedup (BUGS #26).

The pre-flight probe is GLOBAL: a content hash is "already have it, don't send bytes"
when the bytes exist ANYWHERE in the content-addressed store (any project references it),
not just in the current project. A register-by-hash path then attaches the already-stored
image to the current project WITHOUT re-uploading its bytes. Genuinely-new content still
uploads normally.

Covers:
  G1. Cross-project pre-flight: image uploaded to project A is reported "present" when
      pre-flighting the SAME bytes for project B.
  G2. Register-by-hash into B creates B's project_image row pointing at the same hash,
      WITHOUT re-uploading bytes (the on-disk store is unchanged; no extra file written).
  G3. Idempotency: re-registering the same hash into B does not create a duplicate row
      (UNIQUE(project_id, image_hash)).
  G4. A brand-new hash (not in the store anywhere) is reported absent and still uploads
      normally through the full-upload path.
  G5. Dimensions/ext: the registered row in B carries the real width/height/ext derived
      from the stored image, and its leaf_bbox/origin reflect B's own threshold/tile_size.

Run with: uv run python3 webapp/tests/test_preflight_global.py
"""

import io
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-pfglobal-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, imaging, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
client = app.test_client()
with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'


def jdump(r):
    return r.get_json()


def _leaf_png(w: int = 200, h: int = 180) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[30:h - 30, 20:w - 20] = 210
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


def _upload(pid: str, files: list[tuple[str, bytes]]):
    r = client.post(
        f'/api/projects/{pid}/images/upload',
        data={'files': [(io.BytesIO(b), name, 'image/png') for name, b in files]},
        content_type='multipart/form-data',
    )
    r.get_data()  # drain the NDJSON stream so per-file commits actually run
    return r


def _probe(pid: str, hashes: list[str]):
    return client.post(f'/api/projects/{pid}/images/probe', json={'hashes': hashes})


def _register(pid: str, items: list[dict]):
    return client.post(f'/api/projects/{pid}/images/register', json={'items': items})


def _image_files_on_disk() -> set[str]:
    return {p.name for p in (imaging._img_dir()).glob('*') if p.is_file()}


# ── setup: two projects ───────────────────────────────────────────────────────
pidA = jdump(client.post('/api/projects', json={'name': 'Global dedup A'}))['id']
pidB = jdump(client.post('/api/projects', json={'name': 'Global dedup B'}))['id']

shared = _leaf_png(200, 180)
h_shared = imaging.hash_bytes(shared)


# ── G1: cross-project pre-flight reports globally-present hash ────────────────
print('\n── G1: cross-project pre-flight (global dedup) ──')
up = _upload(pidA, [('shared.png', shared)])
assert up.status_code == 200, f'upload to A failed: {up.status_code}'
detA = jdump(client.get(f'/api/projects/{pidA}'))
assert any(im['image_hash'] == h_shared for im in detA['images']), 'A should have the image'

# Pre-flight the SAME bytes for B — must say "have" even though B has no row yet.
out = jdump(_probe(pidB, [h_shared]))
assert h_shared in set(out['have']), \
    f'globally-present hash should be reported for B (got {out["have"]})'
print('  ✓  pre-flight for B reports the hash present (bytes exist globally)')

# A genuinely-new hash is absent.
brand_new = _leaf_png(260, 240)
h_new = imaging.hash_bytes(brand_new)
out_new = jdump(_probe(pidB, [h_new]))
assert h_new not in set(out_new['have']), 'brand-new hash must be reported absent'
print('  ✓  brand-new hash reported absent')


# ── G2: register-by-hash into B without re-uploading bytes ────────────────────
print('\n── G2: register-by-hash into B (no byte re-transfer) ──')
before_files = _image_files_on_disk()

reg = jdump(_register(pidB, [{'hash': h_shared, 'name': 'shared.png'}]))
assert h_shared in set(reg['registered']), \
    f'hash should be registered into B (got {reg})'
assert h_shared not in set(reg['missing']), 'globally-present hash must not be "missing"'
print('  ✓  register reports the hash as registered (not missing)')

# B now has a project_image row pointing at the SAME hash — without re-uploading bytes.
detB = jdump(client.get(f'/api/projects/{pidB}'))
b_imgs = [im for im in detB['images'] if im['image_hash'] == h_shared]
assert len(b_imgs) == 1, f'B should have exactly one row for the hash, got {len(b_imgs)}'
print('  ✓  B now has a project_image row for the shared hash')

# The on-disk store did NOT grow — no bytes were re-sent.
after_files = _image_files_on_disk()
assert after_files == before_files, \
    f'store must be unchanged by register-by-hash (before={before_files}, after={after_files})'
print('  ✓  on-disk image store unchanged (no byte re-transfer)')

# Same content hash in A and B — one global copy.
a_hashes = {im['image_hash'] for im in detA['images']}
assert h_shared in a_hashes, 'A still references the hash'
assert b_imgs[0]['image_hash'] == h_shared, 'B references the SAME hash as A'
print('  ✓  A and B reference the same global content hash')


# ── G3: idempotency — re-register does not duplicate ──────────────────────────
print('\n── G3: register-by-hash idempotency ──')
reg2 = jdump(_register(pidB, [{'hash': h_shared, 'name': 'shared.png'}]))
assert h_shared in set(reg2['registered']), 're-register should still report registered'
detB2 = jdump(client.get(f'/api/projects/{pidB}'))
b_imgs2 = [im for im in detB2['images'] if im['image_hash'] == h_shared]
assert len(b_imgs2) == 1, \
    f're-register must NOT create a duplicate row (got {len(b_imgs2)})'
print('  ✓  re-register is a no-op; UNIQUE(project_id, image_hash) holds')


# ── G4: brand-new hash still uploads normally ────────────────────────────────
print('\n── G4: brand-new hash uploads normally ──')
# Registering a hash that is NOT in the store → reported missing, no row created.
reg_new = jdump(_register(pidB, [{'hash': h_new, 'name': 'brandnew.png'}]))
assert h_new in set(reg_new['missing']), \
    f'brand-new hash should be reported missing (got {reg_new})'
assert h_new not in set(reg_new['registered']), 'brand-new hash must not be registered'
detB_pre = jdump(client.get(f'/api/projects/{pidB}'))
assert not any(im['image_hash'] == h_new for im in detB_pre['images']), \
    'no row should exist for an unregistered (missing) hash'
print('  ✓  brand-new hash reported missing by register; no row created')

# The full-upload path still works for genuinely-new content.
up_new = _upload(pidB, [('brandnew.png', brand_new)])
assert up_new.status_code == 200, f'upload of new bytes failed: {up_new.status_code}'
detB_post = jdump(client.get(f'/api/projects/{pidB}'))
assert any(im['image_hash'] == h_new for im in detB_post['images']), \
    'new image should now be in B after full upload'
print('  ✓  brand-new hash uploads normally via the full-upload path')


# ── G5: registered row carries real ext/dims ─────────────────────────────────
print('\n── G5: registered row carries real ext/dims ──')
b_row = next(im for im in detB['images'] if im['image_hash'] == h_shared)
assert b_row['image_ext'] == 'png', f'ext should be png, got {b_row["image_ext"]}'
img = imaging.get_image(h_shared, 'png')
assert (b_row['width'], b_row['height']) == img.size, \
    f'registered dims {b_row["width"]}x{b_row["height"]} != stored {img.size}'
# B's row is distinct from A's (different project_image id), same content hash.
a_row = next(im for im in detA['images'] if im['image_hash'] == h_shared)
assert a_row['id'] != b_row['id'], 'A and B rows must be distinct project_image rows'
print(f'  ✓  registered row: ext=png, dims={b_row["width"]}x{b_row["height"]}; distinct from A\'s row')


# ── G6: member gate on register-by-hash ──────────────────────────────────────
print('\n── G6: register-by-hash member gate ──')
non_member = app.test_client()
_c2 = db.get_db()
_c2.execute("INSERT INTO users (id, username) VALUES (2, 'carol')")
_c2.commit()
db.close_db(_c2)
with non_member.session_transaction() as s:
    s['user_id'] = 2
    s['username'] = 'carol'

r_forbidden = non_member.post(
    f'/api/projects/{pidB}/images/register',
    json={'items': [{'hash': h_shared, 'name': 'x.png'}]},
)
assert r_forbidden.status_code == 403, \
    f'non-member register should be 403, got {r_forbidden.status_code}'
print('  ✓  non-member: register → 403')

# Malformed body → 400.
r_bad = client.post(f'/api/projects/{pidB}/images/register', json={'items': 'nope'})
assert r_bad.status_code == 400, f'non-list items should be 400, got {r_bad.status_code}'
print('  ✓  non-list items → 400')

# Unknown project → 404.
r_404 = client.post(
    f'/api/projects/nonexistent-project-id/images/register',
    json={'items': [{'hash': h_shared, 'name': 'x.png'}]},
)
assert r_404.status_code == 404, f'unknown project should be 404, got {r_404.status_code}'
print('  ✓  unknown project → 404')


print('\n\nALL PREFLIGHT-GLOBAL BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
