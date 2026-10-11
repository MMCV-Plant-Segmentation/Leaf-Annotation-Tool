"""Backend acceptance tests for the admin-password model (webapp/app.py's _sync_admin,
webapp/config.py's AppConfig.admin_password).

2026-07-17: the seed-vs-force split is GONE. admin_password is CLI-only (deploy.py's
--admin-password, never sourced from a config file), so it is always explicit operator
intent — it CREATES-or-OVERWRITES the admin. There is no "seed-only" mode and no
admin_password_force flag any more. The restore/restart safety comes from simply NOT
passing the flag. Covers:
  N1. No admin, password set -> creates the admin with that password.
  N2. Admin exists, NO password -> left untouched (restart / restore-from-backup path).
  N3. Admin exists, password set -> OVERWRITES it (explicit operator intent).
  N4. No admin, no password -> RuntimeError (a first deployment must set --admin-password).

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


# ── N1: a password on an empty DB creates the admin (first deployment) ────────
print('\n── N1: admin_password on an empty DB creates the admin ──')

assert _admin_hash() is None, 'expected no admin user before first boot'
appmod._sync_admin(AppConfig(data_dir=Path(TMP), admin_password='first-boot-pw'))
h1 = _admin_hash()
assert h1 is not None, 'expected an admin user to be created'
assert check_password_hash(h1, 'first-boot-pw')
print('  ✓  admin created with the given password')


# ── N2: NO password leaves an existing admin untouched (restart / restore) ────
print('\n── N2: no admin_password leaves an existing admin untouched ──')

appmod._sync_admin(AppConfig(data_dir=Path(TMP), admin_password=None))
h2 = _admin_hash()
assert h2 == h1, 'admin password_hash must be unchanged when no password is given'
assert check_password_hash(h2, 'first-boot-pw'), 'original password must still work'
print('  ✓  existing admin untouched when --admin-password is omitted (restore-safe)')


# ── N3: a password OVERWRITES an existing admin (explicit operator intent) ────
print('\n── N3: admin_password overwrites an existing admin ──')

appmod._sync_admin(AppConfig(data_dir=Path(TMP), admin_password='rotated-pw'))
h3 = _admin_hash()
assert h3 != h2, 'expected the password_hash to change'
assert check_password_hash(h3, 'rotated-pw')
assert not check_password_hash(h3, 'first-boot-pw'), 'old password must no longer work'
print('  ✓  --admin-password overwrote the existing admin')


# ── N4: no admin + no password -> RuntimeError (first deployment must set it) ─
print('\n── N4: no admin + no password -> RuntimeError ──')

TMP2 = tempfile.mkdtemp(prefix='leaf-anno-adminpw-test2-')
db.configure(AppConfig(data_dir=Path(TMP2)))
db.auto_create_schema()
try:
    appmod._sync_admin(AppConfig(data_dir=Path(TMP2), admin_password=None))
    raise AssertionError('expected RuntimeError when no admin exists and no password is set')
except RuntimeError as exc:
    assert 'admin' in str(exc).lower(), exc
    print(f'  ✓  RuntimeError raised as expected: {exc}')
finally:
    db.configure(AppConfig(data_dir=Path(TMP)))  # restore for any later use in-process


print('\n\nALL ADMIN-PASSWORD BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
