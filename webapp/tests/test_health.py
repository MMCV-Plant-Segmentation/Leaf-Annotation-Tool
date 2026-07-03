"""
Backend acceptance test for the unauthenticated health-check endpoint
(GET /api/health).

Covers:
  H1. GET /api/health returns HTTP 200 even with NO session (no auth decorator —
      unlike the login-gated GET /api/version).
  H2. The JSON body has a `status` field equal to the string "ok".

Modeled on webapp/tests/test_version.py: env-first setup, a temp data dir,
auto_create_schema(), then the Flask app's test client.

Run with: uv run python3 webapp/tests/test_health.py
"""

import os
import tempfile

TMP = tempfile.mkdtemp(prefix='leaf-anno-health-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

from webapp import db as dbmod
from webapp import app as appmod

dbmod.auto_create_schema()
dbmod.migrate_meta()

app = appmod.app
app.secret_key = 'test-secret'
client = app.test_client()


# ── H1: GET /api/health is reachable with NO session (no auth) ───────────────
print('\n── H1: GET /api/health is reachable without a login ──')

# A freshly-built test client carries no session cookie, so this is an anonymous
# (logged-out) request — exactly the liveness-probe use case.
r = client.get('/api/health')
assert r.status_code == 200, f'expected 200, got {r.status_code}'
print(f'  ✓  anonymous GET /api/health → {r.status_code}')


# ── H2: the body's `status` field is the string "ok" ─────────────────────────
print('\n── H2: JSON body has status == "ok" ──')

body = r.get_json()
assert body is not None, f'expected a JSON body, got {r.data!r}'
assert body.get('status') == 'ok', f'expected status "ok", got {body.get("status")!r}'
print(f'  ✓  body = {body}')


print('\n\nALL HEALTH BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
