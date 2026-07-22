"""t124 — a password change invalidates that user's active sessions (per-user session epoch).

Christian, 2026-07-22: changing a password must log the user out EVERYWHERE, including the
device that made the change (choice B) — that device then hits the standard "you've been
logged out" popup on its next token-gated action (the existing 401 flow).

Mechanism (per-user "session epoch"):
  - `users.session_epoch` INTEGER NOT NULL DEFAULT 0 (new Alembic revision).
  - api_login stamps `session['epoch'] = row.session_epoch`.
  - login_required / admin_required re-check per request: the user must still exist AND
    `session.get('epoch', 0) == row.session_epoch`, else session.clear() + 401.
  - Every password write bumps the epoch: api_update_password, api_reset_user,
    api_accept_invite, and the _sync_admin overwrite.

BACKWARD-COMPAT (load-bearing): the epoch check reads `session.get('epoch', 0)` — a session
with NO epoch key (every session_transaction-based test login; any pre-existing cookie after
deploy) is treated as epoch 0, matching a fresh user's DEFAULT 0. So existing tests stay green
and a plain redeploy does NOT force-logout everyone; only a real password write (epoch 0->1)
staleness a prior session. This is REQUIRED — a strict presence check would 401 every
session_transaction test.

CONTRACT (RED until t124 lands):
  E1. Two devices logged in as the same user both authenticate on a login_required route.
  E2. A self password-change from device B -> device A (a DIFFERENT session) is now 401.
  E3. (choice B) device B — the one that MADE the change — is ALSO 401 afterwards.
  E4. A fresh login with the NEW password authenticates; the OLD password no longer logs in.
  E5. Admin reset of a user invalidates that user's existing sessions.
  E6. Backward-compat: a session_transaction session (no epoch key) on an unchanged user is
      treated as epoch 0 and stays valid (guards the whole existing test corpus).

Standalone-script style (mirrors test_membership.py). The implementer does NOT edit this file.
"""
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-epoch-test-')
os.environ['SECRET_KEY'] = 'test-secret'

from werkzeug.security import generate_password_hash
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")  # admin via session_transaction
_c.execute("INSERT INTO users (id, username, password_hash) VALUES (2, 'alice', ?)",
           (generate_password_hash('origpass1'),))
_c.execute("INSERT INTO users (id, username, password_hash) VALUES (3, 'bob', ?)",
           (generate_password_hash('bobpass12'),))
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True

PROBE = '/api/users/members'   # a login_required route (200 logged-in, 401 not)


def login(client, username, password):
    return client.post('/api/login', json={'username': username, 'password': password})


# ── E1: two devices, same user, both authenticated ──────────────────────────────────────
devA = app.test_client()   # "other" device — stands in for another active session
devB = app.test_client()   # the device that will change the password
assert login(devA, 'alice', 'origpass1').status_code == 200
assert login(devB, 'alice', 'origpass1').status_code == 200
assert devA.get(PROBE).status_code == 200, 'device A authenticates before the change'
assert devB.get(PROBE).status_code == 200, 'device B authenticates before the change'
print('E1 OK — two devices both authenticated')

# ── E2 + E3: self-change from B logs out A (other) AND B (current) — choice B ─────────────
r = devB.patch('/api/me/password',
               json={'current_password': 'origpass1', 'password': 'newpass12', 'confirm': 'newpass12'})
assert r.status_code == 200, f'self password-change should 200, got {r.status_code} {r.get_json()}'
assert devA.get(PROBE).status_code == 401, \
    '*** t124: another active session (device A) must be logged out after a password change ***'
assert devB.get(PROBE).status_code == 401, \
    'choice B: the device that made the change is ALSO logged out (next token-gated call 401s)'
print('E2+E3 OK — a self password-change logs out every session, including the current device')

# ── E4: new password works; old password no longer logs in ───────────────────────────────
devC = app.test_client()
assert login(devC, 'alice', 'newpass12').status_code == 200, 'fresh login with the new password'
assert devC.get(PROBE).status_code == 200
assert login(app.test_client(), 'alice', 'origpass1').status_code == 401, 'old password is dead'
print('E4 OK — new password authenticates; old password is rejected')

# ── E5: admin reset invalidates the target user's sessions ────────────────────────────────
devBob = app.test_client()
assert login(devBob, 'bob', 'bobpass12').status_code == 200
assert devBob.get(PROBE).status_code == 200
admin = app.test_client()
with admin.session_transaction() as s:      # admin via session_transaction (epoch absent -> 0)
    s['user_id'] = 1
    s['username'] = 'admin'
assert admin.post('/api/users/3/reset').status_code == 200, 'admin reset of bob'
assert devBob.get(PROBE).status_code == 401, 'admin reset invalidates the target user\'s existing sessions'
print('E5 OK — admin reset invalidates the target user\'s sessions')

# ── E6: backward-compat — a session_transaction session (no epoch key) stays valid ────────
# The admin above never had a password change, so its epoch-less session must still authenticate
# (session.get('epoch', 0) == users.session_epoch default 0). This guards the whole existing
# session_transaction-based test corpus from the new per-request check.
assert admin.get(PROBE).status_code == 200, \
    'a session_transaction session (no epoch key) on an unchanged user must stay valid (epoch 0)'
print('E6 OK — epoch-less sessions on unchanged users stay valid (backward-compat)')

print('\nt124 session-epoch contract tests passed.')
