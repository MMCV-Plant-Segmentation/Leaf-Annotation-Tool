"""Backend acceptance tests for Alembic adoption (webapp/db.py's auto_create_schema()).

See docs/plans/Plan — Adopt Alembic (baseline + forward migrations).md. Covers:
  B1. Fresh DB (nothing on disk) -> `alembic upgrade head` builds the full baseline
      schema, and the app boots against it.
  B2. Simulated pre-Alembic DB (tables already at today's shape, no `alembic_version`)
      -> `alembic stamp` records the baseline WITHOUT running upgrade() (verified by
      monkeypatching alembic.command.{stamp,upgrade} to track which is called), and
      every existing row survives byte-for-byte.
  B3. Re-running auto_create_schema() against an already-versioned DB is a no-op:
      exactly one alembic_version row, unchanged, no errors.
  B4. An already-versioned DB never gets re-stamped (only upgraded).

Run with: uv run python3 webapp/tests/test_alembic.py
"""

import importlib.util
import os
import sqlite3
import tempfile
from pathlib import Path

TMP_ROOT = tempfile.mkdtemp(prefix='leaf-anno-alembic-test-')
os.environ['SECRET_KEY'] = 'test-secret'

from webapp import db  # noqa: E402  (env vars must be set first)

REPO = Path(__file__).resolve().parents[2]

# Load the baseline revision module directly (NOT through Alembic) so we can build a
# "pre-Alembic" DB using the exact same CREATE TABLE statements, without touching
# alembic_version — i.e. reproduce today's real schema shape from scratch.
_spec = importlib.util.spec_from_file_location(
    'baseline_0001', REPO / 'alembic' / 'versions' / '0001_baseline.py'
)
_baseline = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_baseline)


def _fresh_data_dir(name: str) -> Path:
    d = Path(TMP_ROOT) / name
    d.mkdir(parents=True)
    return d


class _CallTracker:
    """Swap in for alembic.command.stamp / .upgrade to record what actually ran,
    while still delegating to the real implementation."""

    def __init__(self, real):
        self.real = real
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args[1:], kwargs))  # args[0] is the AlembicConfig
        return self.real(*args, **kwargs)


def _patched_commands():
    from alembic import command
    stamp_tracker = _CallTracker(command.stamp)
    upgrade_tracker = _CallTracker(command.upgrade)
    command.stamp = stamp_tracker
    command.upgrade = upgrade_tracker
    return command, stamp_tracker, upgrade_tracker


def _restore_commands(command, stamp_tracker, upgrade_tracker):
    command.stamp = stamp_tracker.real
    command.upgrade = upgrade_tracker.real


# ── B1: fresh DB -> upgrade head, full schema, app boots ─────────────────────
print('\n── B1: fresh DB -> alembic upgrade head builds the full baseline ──')

data_dir = _fresh_data_dir('fresh')
os.environ['HT_DATA_DIR'] = str(data_dir)
db.configure(__import__('webapp.config', fromlist=['AppConfig']).AppConfig(data_dir=data_dir))

command, stamp_t, upgrade_t = _patched_commands()
try:
    db.auto_create_schema()
finally:
    _restore_commands(command, stamp_t, upgrade_t)

assert len(stamp_t.calls) == 0, f'fresh DB should never stamp, got {stamp_t.calls}'
assert len(upgrade_t.calls) == 1, f'fresh DB should upgrade exactly once, got {upgrade_t.calls}'
assert upgrade_t.calls[0][0][0] == 'head'

con = db.get_db()
try:
    tables = {
        r['name'] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    av = con.execute('SELECT version_num FROM alembic_version').fetchone()
finally:
    db.close_db(con)

expected_tables = {
    'alembic_version', 'users', 'invite_codes', 'settings', 'annotation_set', 'merge',
    'reannot_session', 'reannot_pile', 'reannot_generation', 'reannot_polygon', 'project',
    'project_annotator', 'project_image', 'tile', 'batch', 'batch_tile', 'annotator_tile',
    'annotation', 'annotation_tile', 'meta',
}
assert expected_tables <= tables, f'missing tables: {expected_tables - tables}'
assert av['version_num'] == db.BASELINE_REVISION
print(f'  ✓  fresh DB has all {len(expected_tables)} expected tables, stamped at head')

from webapp import app as appmod  # noqa: E402  (import after schema exists)
appmod.app.secret_key = 'test-secret'
client = appmod.app.test_client()
r = client.get('/login')
assert r.status_code == 200, f'app should boot and serve /login, got {r.status_code}'
print('  ✓  app boots against the fresh DB (GET /login -> 200)')


# ── B2: simulated pre-Alembic DB -> stamped (not upgraded), data intact ──────
print('\n── B2: pre-Alembic DB (tables exist, no alembic_version) -> stamp, not rebuild ──')

data_dir2 = _fresh_data_dir('legacy')
os.environ['HT_DATA_DIR'] = str(data_dir2)
db.configure(__import__('webapp.config', fromlist=['AppConfig']).AppConfig(data_dir=data_dir2))

db_path = db._db_path()
db_path.parent.mkdir(parents=True, exist_ok=True)
con = sqlite3.connect(str(db_path))
for stmt in _baseline._STATEMENTS:
    con.execute(stmt)
con.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
con.execute(
    "INSERT INTO project (id, name, created_at) VALUES ('p1', 'Legacy Project', '2026-01-01')"
)
con.commit()
con.close()

# Sanity: this really is "pre-Alembic" — no alembic_version table yet.
con = sqlite3.connect(str(db_path))
pre_tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
con.close()
assert 'alembic_version' not in pre_tables

command, stamp_t, upgrade_t = _patched_commands()
try:
    db.auto_create_schema()
finally:
    _restore_commands(command, stamp_t, upgrade_t)

assert len(stamp_t.calls) == 1, f'legacy DB should stamp exactly once, got {stamp_t.calls}'
assert stamp_t.calls[0][0][0] == db.BASELINE_REVISION
assert len(upgrade_t.calls) == 1, 'legacy DB should ALSO upgrade (to catch post-baseline revisions)'
print('  ✓  legacy DB -> command.stamp(baseline) called, then command.upgrade(head)')

con = db.get_db()
try:
    av = con.execute('SELECT version_num FROM alembic_version').fetchone()
    users = con.execute('SELECT id, username FROM users').fetchall()
    projects = con.execute('SELECT id, name FROM project').fetchall()
finally:
    db.close_db(con)
assert av['version_num'] == db.BASELINE_REVISION
assert users == [{'id': 1, 'username': 'admin'}], users
assert projects == [{'id': 'p1', 'name': 'Legacy Project'}], projects
print('  ✓  pre-existing rows (users, project) survive the stamp byte-for-byte')


# ── B3/B4: already-versioned DB -> upgrade is a no-op, never re-stamped ──────
print('\n── B3/B4: re-running auto_create_schema() on an already-versioned DB ──')

command, stamp_t, upgrade_t = _patched_commands()
try:
    db.auto_create_schema()
    db.auto_create_schema()
finally:
    _restore_commands(command, stamp_t, upgrade_t)

assert len(stamp_t.calls) == 0, f'already-versioned DB must never be re-stamped, got {stamp_t.calls}'
assert len(upgrade_t.calls) == 2, upgrade_t.calls

con = db.get_db()
try:
    av_rows = con.execute('SELECT version_num FROM alembic_version').fetchall()
    users2 = con.execute('SELECT id, username FROM users').fetchall()
finally:
    db.close_db(con)
assert av_rows == [{'version_num': db.BASELINE_REVISION}], av_rows
assert users2 == [{'id': 1, 'username': 'admin'}], 'repeated boot must not touch data'
print('  ✓  repeated boot: no re-stamp, single alembic_version row, data unchanged')


print('\n\nALL ALEMBIC BACKEND TESTS PASSED ✓  (data dir root:', TMP_ROOT, ')')
