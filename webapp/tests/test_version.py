"""
Backend acceptance tests for stack-wide versioning (webapp/version.py, db.py's
BASELINE_REVISION / migrate_meta, GET /api/version).

Covers:
  V1. get_version() in a real git checkout returns the packaged version + a real
      short SHA (both non-"unknown").
  V2. get_version() falls back to "unknown"/"dev" when env is unset and the cwd
      it shells `git` from is NOT a git checkout.
  V3. GET /api/version requires login (401/redirect when logged out).
  V4. GET /api/version, logged in, returns all four keys with the right shapes;
      schemaVersion is the current Alembic revision (single source of truth —
      see docs/plans/Plan — Adopt Alembic (baseline + forward migrations).md).
  V5. The `meta` table holds an app_version row after boot, idempotently across
      repeated boots (auto_create_schema() + migrate_meta() called twice doesn't error
      or duplicate/lose rows).

Run with: uv run python3 webapp/tests/test_version.py
"""

import os
import shutil
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-version-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from webapp import db, app as appmod
from webapp import version as versionmod

db.auto_create_schema()
db.migrate_meta()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
client = app.test_client()


def jdump(r):
    return r.get_json()


# ── V1: get_version() in a real git checkout ──────────────────────────────────
print('\n── V1: get_version() resolves packaged version + real git SHA ──')

v = versionmod.get_version()
assert v['appVersion'] != 'unknown', f'expected a real appVersion, got {v["appVersion"]!r}'
assert v['gitSha'] != 'unknown', f'expected a real gitSha in this checkout, got {v["gitSha"]!r}'
assert v['builtAt'] == 'dev', f'expected "dev" builtAt (no BUILD_TIME env), got {v["builtAt"]!r}'
print(f'  ✓  appVersion={v["appVersion"]!r} gitSha={v["gitSha"]!r} builtAt={v["builtAt"]!r}')


# ── V2: fallback when not a git checkout and env unset ────────────────────────
print('\n── V2: fallback to "unknown" outside a git checkout ──')

non_git_dir = tempfile.mkdtemp(prefix='leaf-anno-nongit-')
try:
    sha = versionmod._read_git_sha(cwd=non_git_dir)
    assert sha == 'unknown', f'expected "unknown" outside a git checkout, got {sha!r}'
    print('  ✓  _read_git_sha() returns "unknown" for a non-git directory')

    # env override always wins regardless of the runtime git state.
    os.environ['GIT_SHA'] = 'deadbeef'
    os.environ['BUILD_TIME'] = '2026-07-01T00:00:00Z'
    os.environ['APP_VERSION'] = '9.9.9'
    try:
        v_env = versionmod.get_version()
        assert v_env['gitSha'] == 'deadbeef'
        assert v_env['builtAt'] == '2026-07-01T00:00:00Z'
        assert v_env['appVersion'] == '9.9.9'
        print('  ✓  env-baked GIT_SHA/BUILD_TIME/APP_VERSION take priority over runtime resolution')
    finally:
        del os.environ['GIT_SHA']
        del os.environ['BUILD_TIME']
        del os.environ['APP_VERSION']
finally:
    shutil.rmtree(non_git_dir, ignore_errors=True)


# ── V3: GET /api/version requires login ───────────────────────────────────────
print('\n── V3: GET /api/version is login-gated ──')

anon_client = app.test_client()
r_anon = anon_client.get('/api/version')
assert r_anon.status_code in (302, 401), f'expected redirect/401 when logged out, got {r_anon.status_code}'
print(f'  ✓  logged-out GET /api/version → {r_anon.status_code}')


# ── V4: GET /api/version, logged in, returns all four keys ────────────────────
print('\n── V4: GET /api/version returns all four keys ──')

with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'

r = client.get('/api/version')
assert r.status_code == 200, f'expected 200, got {r.status_code}'
body = jdump(r)
for key in ('appVersion', 'gitSha', 'builtAt', 'schemaVersion'):
    assert key in body, f'missing key {key!r} in {body}'
assert body['schemaVersion'] == db.BASELINE_REVISION, \
    f'expected schemaVersion={db.BASELINE_REVISION!r} (the head Alembic revision), got {body["schemaVersion"]!r}'
print(f'  ✓  GET /api/version → {body}')


# ── V5: meta table (app_version) idempotent across repeated boots ────────────
print('\n── V5: meta.app_version present, idempotent across repeated boots ──')

con = db.get_db()
try:
    rows = {r['key']: r['value'] for r in con.execute('SELECT key, value FROM meta').fetchall()}
finally:
    db.close_db(con)
assert rows.get('app_version'), rows
print(f'  ✓  meta rows present after first boot: {rows}')

# Calling auto_create_schema()+migrate_meta() again (as a second process boot would)
# must not error, and must not duplicate/lose the rows.
db.auto_create_schema()
db.migrate_meta()
con2 = db.get_db()
try:
    rows2 = {r['key']: r['value'] for r in con2.execute('SELECT key, value FROM meta').fetchall()}
    count = con2.execute("SELECT COUNT(*) AS n FROM meta WHERE key = 'app_version'").fetchone()['n']
finally:
    db.close_db(con2)
assert rows2 == rows, f'meta rows changed across a repeated boot: {rows} -> {rows2}'
assert count == 1, f'expected exactly one app_version row, got {count}'
print('  ✓  repeated boot leaves meta unchanged, no dupes')


print('\n\nALL VERSION BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
