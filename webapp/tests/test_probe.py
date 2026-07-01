"""
Backend acceptance tests for the pre-flight upload-dedup probe endpoint.

Covers:
  P1. Known-vector: the hash scheme is sha256(bytes).hexdigest()[:24] (24 hex chars).
  P2. Probe returns EXACTLY the present subset (present ∩ candidates; absent excluded).
  P3. Per-project scoping: a hash present in project A is NOT reported for project B.
  P4. Empty / malformed body handling.
  P5. Member gate: non-member → 403; member → 200.

Run with: uv run python3 webapp/tests/test_probe.py
"""

import hashlib
import io
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-probe-test-')
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


def _probe(cl, pid: str, hashes: list[str]):
    return cl.post(f'/api/projects/{pid}/images/probe', json={'hashes': hashes})


# ── P1: known-vector — hash scheme is sha256(bytes).hexdigest()[:24] ───────────
print('\n── P1: known hash vector ──')
sample = b'the quick brown fox'
expected = hashlib.sha256(sample).hexdigest()[:24]
assert imaging.hash_bytes(sample) == expected, \
    f'hash_bytes mismatch: {imaging.hash_bytes(sample)} != {expected}'
assert len(expected) == 24, f'hash length should be 24, got {len(expected)}'
# The full digest truncated to 24 hex chars == first 12 bytes.
assert expected == hashlib.sha256(sample).hexdigest()[:24]
print(f'  ✓  sha256(bytes).hexdigest()[:24] == {expected} (len 24)')


# ── P2: probe returns exactly the present subset ──────────────────────────────
print('\n── P2: present subset ──')
pid = jdump(client.post('/api/projects', json={'name': 'Probe test'}))['id']
f1, f2 = _leaf_png(200, 180), _leaf_png(220, 160)
h1, h2 = imaging.hash_bytes(f1), imaging.hash_bytes(f2)
resp = _upload(pid, [('a.png', f1), ('b.png', f2)])
assert resp.status_code == 200, f'upload failed: {resp.status_code}'

absent = imaging.hash_bytes(_leaf_png(300, 300))  # never uploaded
out = jdump(_probe(client, pid, [h1, h2, absent]))
have = set(out['have'])
assert have == {h1, h2}, f'have should be exactly the present pair, got {have}'
assert absent not in have, 'absent hash must not be reported present'
print('  ✓  probe returns exactly the present hashes; absent excluded')

# Probing with only absent hashes → empty have.
out_none = jdump(_probe(client, pid, [absent]))
assert out_none['have'] == [], f'all-absent probe should be empty, got {out_none["have"]}'
print('  ✓  all-absent probe → have == []')


# ── P3: per-project scoping ───────────────────────────────────────────────────
print('\n── P3: per-project scoping ──')
pid2 = jdump(client.post('/api/projects', json={'name': 'Probe test 2'}))['id']
# h1/h2 live in pid, NOT pid2. Probing pid2 for them must return nothing.
out2 = jdump(_probe(client, pid2, [h1, h2]))
assert out2['have'] == [], f'hashes from another project leaked: {out2["have"]}'
print('  ✓  hashes present in project A are not reported for project B')


# ── P4: empty / malformed body ────────────────────────────────────────────────
print('\n── P4: empty / malformed body ──')
out_empty = jdump(_probe(client, pid, []))
assert out_empty['have'] == [], f'empty hashes → empty have, got {out_empty}'
r_bad = client.post(f'/api/projects/{pid}/images/probe', json={'hashes': 'nope'})
assert r_bad.status_code == 400, f'non-list hashes should be 400, got {r_bad.status_code}'
print('  ✓  empty list → have == []; non-list → 400')


# ── P5: member gate ───────────────────────────────────────────────────────────
print('\n── P5: member gate ──')
non_member = app.test_client()
_c2 = db.get_db()
_c2.execute("INSERT INTO users (id, username) VALUES (2, 'bob')")
_c2.commit()
db.close_db(_c2)
with non_member.session_transaction() as s:
    s['user_id'] = 2
    s['username'] = 'bob'

r_forbidden = _probe(non_member, pid, [h1])
assert r_forbidden.status_code == 403, f'non-member probe should be 403, got {r_forbidden.status_code}'
print('  ✓  non-member: probe → 403')

# Add bob as a member; now he can probe.
r_add = client.post(f'/api/projects/{pid}/annotators', json={'user_id': 2})
assert r_add.status_code == 201, f'failed to add bob: {r_add.status_code}'
r_ok = _probe(non_member, pid, [h1, absent])
assert r_ok.status_code == 200, f'member probe should be 200, got {r_ok.status_code}'
assert set(jdump(r_ok)['have']) == {h1}, 'member probe should see present subset'
print('  ✓  member: probe → 200 with correct subset')

# Unknown project → 404.
r_404 = _probe(client, 'nonexistent-project-id', [h1])
assert r_404.status_code == 404, f'unknown project should be 404, got {r_404.status_code}'
print('  ✓  unknown project → 404')


print('\n\nALL PROBE BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
