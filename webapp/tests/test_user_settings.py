"""
Backend acceptance tests for self-service account settings (webapp/auth.py's
PATCH /api/me/username and PATCH /api/me/password).

See docs task "Settings — let a logged-in user change their OWN username + password":
  U1. Username change: happy path updates users.username AND session['username']
      (verified via /api/me reflecting the new name on the SAME client).
  U2. Username change: uniqueness enforced (409) against another user's name.
  U3. Username change: empty username rejected (400).
  P1. Password change: happy path requires + verifies the CURRENT password, then
      the new password logs in successfully and the old one no longer works.
  P2. Password change: wrong current password rejected (400), password unchanged.
  P3. Password change: new/confirm mismatch rejected (400).
  P4. Password change: new password too short rejected (400).
  A1. Both endpoints require login (401 when logged out).

Run with: uv run python3 webapp/tests/test_user_settings.py
"""
import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-usersettings-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from werkzeug.security import generate_password_hash

from webapp import app as appmod
from webapp import db

db.auto_create_schema()
_c = db.get_db()
_c.execute(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', ?)",
    (generate_password_hash('alice-pw-1'),),
)
_c.execute(
    "INSERT INTO users (id, username, password_hash) VALUES (2, 'bob', ?)",
    (generate_password_hash('bob-pw-1'),),
)
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'

alice = app.test_client()
with alice.session_transaction() as s:
    s['user_id']  = 1
    s['username'] = 'alice'


def jdump(r):
    return r.get_json()


# ── A1: login required ────────────────────────────────────────────────────────
print('\n── A1: both endpoints require login ──')

anon = app.test_client()
r = anon.patch('/api/me/username', json={'username': 'whoever'})
assert r.status_code == 401, f'expected 401 logged-out on username change, got {r.status_code}'
r = anon.patch('/api/me/password', json={'current_password': 'x', 'password': 'newpassword1', 'confirm': 'newpassword1'})
assert r.status_code == 401, f'expected 401 logged-out on password change, got {r.status_code}'
print('  ✓  anonymous client gets 401 on both endpoints')


# ── U3: empty username rejected ───────────────────────────────────────────────
print('\n── U3: empty username rejected ──')

r = alice.patch('/api/me/username', json={'username': '   '})
assert r.status_code == 400, f'expected 400 for blank username, got {r.status_code}'
print('  ✓  blank username -> 400')


# ── U2: uniqueness enforced ────────────────────────────────────────────────────
print('\n── U2: username uniqueness enforced ──')

r = alice.patch('/api/me/username', json={'username': 'bob'})
assert r.status_code == 409, f'expected 409 for username clash, got {r.status_code}'
me = jdump(alice.get('/api/me'))
assert me['username'] == 'alice', f'alice username should be unchanged, got {me}'
print('  ✓  username clash -> 409, alice unchanged')


# ── U1: happy path updates DB row AND session ─────────────────────────────────
print('\n── U1: username change happy path ──')

r = alice.patch('/api/me/username', json={'username': 'alice2'})
assert r.status_code == 200, f'expected 200, got {r.status_code}: {jdump(r)}'
assert jdump(r)['username'] == 'alice2'
me = jdump(alice.get('/api/me'))
assert me['username'] == 'alice2', f'session not updated: {me}'
con = db.get_db()
try:
    row = con.execute('SELECT username FROM users WHERE id = 1').fetchone()
finally:
    db.close_db(con)
assert row['username'] == 'alice2', f'DB row not updated: {row}'
print('  ✓  users.username AND session[\'username\'] both reflect the new name')

# Log in fresh with the new username to confirm it round-trips through /api/login too.
fresh = app.test_client()
r = fresh.post('/api/login', json={'username': 'alice2', 'password': 'alice-pw-1'})
assert r.status_code == 200, f'expected login with new username to succeed, got {r.status_code}'
print('  ✓  can log in with the new username')


# ── P4: new password too short ────────────────────────────────────────────────
print('\n── P4: new password too short rejected ──')

r = alice.patch('/api/me/password', json={
    'current_password': 'alice-pw-1', 'password': 'short', 'confirm': 'short',
})
assert r.status_code == 400, f'expected 400 for short password, got {r.status_code}'
print('  ✓  short new password -> 400')


# ── P3: new/confirm mismatch ──────────────────────────────────────────────────
print('\n── P3: new/confirm mismatch rejected ──')

r = alice.patch('/api/me/password', json={
    'current_password': 'alice-pw-1', 'password': 'newpassword1', 'confirm': 'newpassword2',
})
assert r.status_code == 400, f'expected 400 for mismatched confirm, got {r.status_code}'
print('  ✓  mismatched confirm -> 400')


# ── P2: wrong current password ────────────────────────────────────────────────
print('\n── P2: wrong current password rejected ──')

r = alice.patch('/api/me/password', json={
    'current_password': 'totally-wrong', 'password': 'newpassword1', 'confirm': 'newpassword1',
})
assert r.status_code == 400, f'expected 400 for wrong current password, got {r.status_code}'
r_login_old = app.test_client().post('/api/login', json={'username': 'alice2', 'password': 'alice-pw-1'})
assert r_login_old.status_code == 200, 'old password should still work after a rejected change'
print('  ✓  wrong current password -> 400, password unchanged')


# ── P1: happy path ─────────────────────────────────────────────────────────────
print('\n── P1: password change happy path ──')

r = alice.patch('/api/me/password', json={
    'current_password': 'alice-pw-1', 'password': 'brand-new-pw-1', 'confirm': 'brand-new-pw-1',
})
assert r.status_code == 200, f'expected 200, got {r.status_code}: {jdump(r)}'

r_login_new = app.test_client().post('/api/login', json={'username': 'alice2', 'password': 'brand-new-pw-1'})
assert r_login_new.status_code == 200, 'expected login with the new password to succeed'

r_login_old2 = app.test_client().post('/api/login', json={'username': 'alice2', 'password': 'alice-pw-1'})
assert r_login_old2.status_code == 401, 'old password must no longer work'
print('  ✓  new password works, old password rejected')


print('\n\nALL USER-SETTINGS BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
