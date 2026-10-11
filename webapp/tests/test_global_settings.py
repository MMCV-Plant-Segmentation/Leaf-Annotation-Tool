"""
Backend acceptance tests for t164 — global settings readable by any logged-in user.

Christian (2026-10-10): the batch merge UX (everything after "merge-ready") is unfinished, so it
is OFF by default behind a whole-app ADMIN toggle. The toggle is stored in the existing
key/value `settings` table (key MERGE_ENABLED, written via the admin-only PATCH /api/settings).
Members need to READ it (they see the merge buttons), but /api/settings is admin-only and also
holds BACKUP_DIR — so a separate, read-only GET /api/global-settings exposes ONLY the
allowlisted, non-sensitive app-wide flags.

  G1. Login required (401 when logged out).
  G2. Default: {"merge_enabled": false} for a plain member — exactly that key, nothing else
      (BACKUP_DIR etc. never leak).
  G3. Admin PATCH /api/settings {"MERGE_ENABLED": "1"} → members read merge_enabled: true;
      "0" turns it back off.
  G4. Members cannot write it (PATCH /api/settings stays admin-only: 403).
  G5. GET /api/global-settings is read-only (no PATCH/POST/PUT on it).

Run with: uv run python3 webapp/tests/test_global_settings.py
"""
import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-globalsettings-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from werkzeug.security import generate_password_hash

from webapp import app as appmod
from webapp import db

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', ?)",
           (generate_password_hash('admin-pw-1'),))
_c.execute("INSERT INTO users (id, username, password_hash) VALUES (2, 'bob', ?)",
           (generate_password_hash('bob-pw-1'),))
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'


def client_as(uid, name):
    c = app.test_client()
    with c.session_transaction() as s:
        s['user_id'] = uid
        s['username'] = name
    return c


admin = client_as(1, 'admin')
bob = client_as(2, 'bob')
anon = app.test_client()

failures = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        failures.append(msg)


print('\n── G1: login required ──')
r = anon.get('/api/global-settings')
check(r.status_code == 401, f'logged-out GET → 401 (got {r.status_code})')

print('\n── G2: default off, allowlisted keys only ──')
# A BACKUP_DIR row exists — it must not leak through the member-readable endpoint.
r = admin.patch('/api/settings', json={'BACKUP_DIR': '/secret/backups'})
check(r.status_code == 200, f'admin can still PATCH /api/settings (got {r.status_code})')
r = bob.get('/api/global-settings')
check(r.status_code == 200, f'member GET → 200 (got {r.status_code})')
check(r.get_json() == {'merge_enabled': False}, f'default body is exactly {{"merge_enabled": false}} (got {r.get_json()})')

print('\n── G3: admin toggles it via the existing settings endpoint ──')
r = admin.patch('/api/settings', json={'MERGE_ENABLED': '1'})
check(r.status_code == 200, f'admin PATCH MERGE_ENABLED=1 → 200 (got {r.status_code})')
check(bob.get('/api/global-settings').get_json() == {'merge_enabled': True}, 'member now reads merge_enabled: true')
check(admin.get('/api/settings').get_json().get('MERGE_ENABLED', {}).get('value') == '1',
      'admin GET /api/settings shows MERGE_ENABLED = "1"')
admin.patch('/api/settings', json={'MERGE_ENABLED': '0'})
check(bob.get('/api/global-settings').get_json() == {'merge_enabled': False}, '"0" turns it back off')

print('\n── G4: members cannot write it ──')
r = bob.patch('/api/settings', json={'MERGE_ENABLED': '1'})
check(r.status_code == 403, f'member PATCH /api/settings → 403 (got {r.status_code})')
check(bob.get('/api/global-settings').get_json() == {'merge_enabled': False}, 'still off after the refused write')

print('\n── G5: read-only endpoint ──')
for method in ('patch', 'post', 'put'):
    r = getattr(admin, method)('/api/global-settings', json={'merge_enabled': True})
    check(r.status_code == 405, f'{method.upper()} /api/global-settings → 405 (got {r.status_code})')
check(bob.get('/api/global-settings').get_json() == {'merge_enabled': False}, 'unchanged by those attempts')

if failures:
    print(f'\n{len(failures)} FAILED')
    sys.exit(1)
print('\nALL PASS')
