"""Backend acceptance tests for admin-password seed/force semantics (webapp/app.py's
_sync_admin, webapp/config.py's AppConfig.admin_password / admin_password_force).

See docs/plans/Task — env hygiene.md: env-sourced ADMIN_PASSWORD must SEED only (never
clobber an admin restored from a prod snapshot); an explicit --admin-password CLI flag
is the only thing that force-updates an existing admin. Covers:
  P1. No admin, password set (force=False, the env-sourced default) -> seeds the admin
      user with that password.
  P2. Admin already exists, password set but force=False (env-sourced) -> password_hash
      is NOT touched (no-clobber).
  P3. Admin already exists, password set AND force=True (--admin-password) -> password
      IS overwritten.
  P4. No admin, no password at all -> RuntimeError (first-boot guard unchanged).

Run with: uv run python3 webapp/tests/test_admin_password.py
"""
import os
import tempfile
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='leaf-anno-adminpw-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from werkzeug.security import check_password_hash

from webapp import app as appmod
from webapp import db
from webapp.config import AppConfig

db.configure(AppConfig(data_dir=Path(TMP)))
db.auto_create_schema()


def _admin_hash() -> str | None:
    con = db.get_db()
    try:
        row = con.execute("SELECT password_hash FROM users WHERE username = 'admin'").fetchone()
    finally:
        db.close_db(con)
    return row['password_hash'] if row else None


# ── P1: seed the admin on first boot (no admin exists yet) ────────────────────
print('\n── P1: env-sourced admin_password seeds the admin on first boot ──')

assert _admin_hash() is None, 'expected no admin user before first boot'
appmod._sync_admin(AppConfig(data_dir=Path(TMP), admin_password='first-boot-pw'))
h1 = _admin_hash()
assert h1 is not None, 'expected an admin user to be seeded'
assert check_password_hash(h1, 'first-boot-pw')
print('  ✓  admin seeded with the first-boot password')


# ── P2: no-clobber — force=False must NOT touch an existing admin ─────────────
print('\n── P2: env-sourced admin_password (force=False) does not clobber an existing admin ──')

appmod._sync_admin(AppConfig(data_dir=Path(TMP), admin_password='dev-env-changeme',
                              admin_password_force=False))
h2 = _admin_hash()
assert h2 == h1, 'admin password_hash must be unchanged when force=False'
assert check_password_hash(h2, 'first-boot-pw'), 'original password must still work'
assert not check_password_hash(h2, 'dev-env-changeme'), \
    'the env-sourced password must NOT have been applied'
print('  ✓  existing admin untouched by a non-forced admin_password (e.g. dev .env)')


# ── P3: --admin-password (force=True) DOES overwrite the existing admin ───────
print('\n── P3: admin_password_force=True force-updates an existing admin ──')

appmod._sync_admin(AppConfig(data_dir=Path(TMP), admin_password='forced-override-pw',
                              admin_password_force=True))
h3 = _admin_hash()
assert h3 != h2, 'expected the password_hash to change under force=True'
assert check_password_hash(h3, 'forced-override-pw')
assert not check_password_hash(h3, 'first-boot-pw')
print('  ✓  --admin-password force-updated the existing admin')


# ── P4: first boot with no password at all -> RuntimeError ────────────────────
print('\n── P4: no admin + no password on first boot -> RuntimeError ──')

TMP2 = tempfile.mkdtemp(prefix='leaf-anno-adminpw-test2-')
cfg2 = AppConfig(data_dir=Path(TMP2))
db.configure(cfg2)
db.auto_create_schema()
try:
    appmod._sync_admin(AppConfig(data_dir=Path(TMP2), admin_password=None))
    raise AssertionError('expected RuntimeError when no admin exists and no password is set')
except RuntimeError as exc:
    assert 'ADMIN_PASSWORD' in str(exc)
    print(f'  ✓  RuntimeError raised as expected: {exc}')
finally:
    db.configure(AppConfig(data_dir=Path(TMP)))  # restore for any later use in-process


print('\n\nALL ADMIN-PASSWORD BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
