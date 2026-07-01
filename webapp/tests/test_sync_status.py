"""Backend acceptance tests for the backup sync-status feature (GET /api/sync-status
and the backup-status sidecar's own parsers).

See docs/plans/Plan — Admin sync-status panel.md, DECISION (Christian, 2026-07-01):
build the status sidecar (option C). Covers:
  Y1. GET /api/sync-status requires login (401/redirect when logged out).
  Y2. GET /api/sync-status requires admin (403 for a logged-in non-admin user) —
      the same admin_required guard as PATCH /api/settings.
  Y3. GET /api/sync-status, admin, sidecar unreachable -> 200 {'configured': False}.
      Never a 500: the main app must degrade gracefully with no backup profile up.
  Y4. webapp.backup_status.LitestreamFreshness.observe() derives ageSec from a
      sample litestream Prometheus metrics payload across successive scrapes.
  Y5. webapp.backup_status.parse_lsyncd_status() parses a sample lsyncd status file
      into {lastSyncIso, ageSec} correctly.
  Y6. webapp.backup_status.build_status() reports ok=False when either source is
      unreachable, ok=True when both parse.

Run with: uv run python3 webapp/tests/test_sync_status.py
"""

import os
import tempfile
import time

TMP = tempfile.mkdtemp(prefix='leaf-anno-syncstatus-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'
# Nothing listens here — exercises the "sidecar unreachable" path with no real network
# dependency and no timeout delay (connection refused on localhost is instant).
os.environ['BACKUP_STATUS_URL'] = 'http://127.0.0.1:1/status'

from webapp import app as appmod
from webapp import backup_status as bs
from webapp import db

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (id, username) VALUES (2, 'member')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'


# ── Y1: GET /api/sync-status requires login ───────────────────────────────────
print('\n── Y1: GET /api/sync-status is login-gated ──')

anon = app.test_client()
r = anon.get('/api/sync-status')
assert r.status_code in (302, 401), f'expected redirect/401 when logged out, got {r.status_code}'
print(f'  ✓  logged-out GET /api/sync-status → {r.status_code}')


# ── Y2: GET /api/sync-status requires admin, not just login ───────────────────
print('\n── Y2: GET /api/sync-status requires admin ──')

member = app.test_client()
with member.session_transaction() as s:
    s['user_id'] = 2
    s['username'] = 'member'
r = member.get('/api/sync-status')
assert r.status_code == 403, f'expected 403 for non-admin, got {r.status_code}'
print('  ✓  non-admin GET /api/sync-status → 403')


# ── Y3: admin + unreachable sidecar degrades to configured:false ──────────────
print('\n── Y3: unreachable backup-status sidecar degrades gracefully ──')

admin = app.test_client()
with admin.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'
r = admin.get('/api/sync-status')
assert r.status_code == 200, f'expected 200 even when the sidecar is down, got {r.status_code}'
body = r.get_json()
assert body == {'configured': False}, f'expected {{"configured": False}}, got {body}'
print(f'  ✓  GET /api/sync-status (sidecar down) → 200 {body}')


# ── Y4: LitestreamFreshness derives ageSec from a real metrics payload ────────
print('\n── Y4: LitestreamFreshness.observe() tracks litestream_sync_count deltas ──')

SAMPLE_METRICS_3 = (
    '# HELP litestream_sync_count Number of sync operations performed\n'
    '# TYPE litestream_sync_count counter\n'
    'litestream_sync_count{db="/data/app.db"} 3\n'
    'litestream_db_size{db="/data/app.db"} 40960\n'
)
SAMPLE_METRICS_5 = SAMPLE_METRICS_3.replace('} 3\n', '} 5\n', 1)

tracker = bs.LitestreamFreshness()
t0 = 1_000_000.0

first = tracker.observe(SAMPLE_METRICS_3, now=t0)
assert first is not None and first['ageSec'] == 0.0, first
print(f'  ✓  first scrape (count=3) seeds age=0: {first}')

still_3 = tracker.observe(SAMPLE_METRICS_3, now=t0 + 30)
assert still_3['ageSec'] == 30.0, still_3
print(f'  ✓  unchanged count 30s later ages to 30s: {still_3}')

bumped = tracker.observe(SAMPLE_METRICS_5, now=t0 + 45)
assert bumped['ageSec'] == 0.0, bumped
print(f'  ✓  count increasing (3→5) resets age to 0: {bumped}')

later = tracker.observe(SAMPLE_METRICS_5, now=t0 + 105)
assert later['ageSec'] == 60.0, later
print(f'  ✓  60s after the bump, unchanged count ages to 60s: {later}')

assert bs.parse_litestream_sync_count('no such metric here') is None
print('  ✓  metrics payload missing the counter entirely → None')


# ── Y5: parse_lsyncd_status() parses a sample status file ─────────────────────
print("\n── Y5: parse_lsyncd_status() parses lsyncd's own status-file heartbeat ──")

SAMPLE_LSYNCD = (
    'Lsyncd status report at Wed Jul  1 12:00:00 2026\n\n'
    'sync1 source=/data/\n'
    'There are 0 delays\n\n'
    'Inotify:\n'
)
now_epoch = time.mktime(time.strptime('Wed Jul  1 12:05:00 2026', '%a %b %d %H:%M:%S %Y'))
result = bs.parse_lsyncd_status(SAMPLE_LSYNCD, now=now_epoch)
assert result is not None, 'expected a parsed result'
assert result['ageSec'] == 300.0, result
print(f'  ✓  status file dated 12:00:00, "now"=12:05:00 → ageSec=300: {result}')

bad = bs.parse_lsyncd_status('not a status file at all', now=now_epoch)
assert bad is None, bad
print('  ✓  unparseable text → None (no crash)')


# ── Y6: build_status() reflects reachability of both sources ──────────────────
print('\n── Y6: build_status() ok flag reflects both sources ──')


def _fake_fetch_ok(url, timeout=2.0):
    return SAMPLE_METRICS_5


def _fake_fetch_down(url, timeout=2.0):
    return None


def _fake_read_ok(path):
    return SAMPLE_LSYNCD


def _fake_read_down(path):
    return None


orig_fetch, orig_read = bs.fetch_litestream_metrics, bs.read_lsyncd_status
try:
    bs.fetch_litestream_metrics = _fake_fetch_ok
    bs.read_lsyncd_status = _fake_read_ok
    both_up = bs.build_status()
    assert both_up['ok'] is True, both_up
    assert both_up['db'] is not None and both_up['files'] is not None, both_up
    print(f'  ✓  both sources reachable → ok=True: {both_up}')

    bs.read_lsyncd_status = _fake_read_down
    files_down = bs.build_status()
    assert files_down['ok'] is False, files_down
    assert files_down['files'] is None, files_down
    print(f'  ✓  lsyncd status file missing → ok=False, files=None: {files_down}')

    bs.fetch_litestream_metrics = _fake_fetch_down
    bs.read_lsyncd_status = _fake_read_down
    both_down = bs.build_status()
    assert both_down == {'db': None, 'files': None, 'ok': False}, both_down
    print(f'  ✓  both sources unreachable → ok=False, db=files=None: {both_down}')
finally:
    bs.fetch_litestream_metrics = orig_fetch
    bs.read_lsyncd_status = orig_read


print('\n\nALL SYNC-STATUS BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
