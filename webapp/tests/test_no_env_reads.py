"""Permanent guard: the app must never read environment variables directly outside of
the handful of legitimate entrypoint/boundary modules — everything downstream reads
`cfg`/AppConfig (see webapp/config.py, docs/plans/Task — env hygiene.md).

This scans every webapp/**/*.py file for os.environ / os.getenv / bare getenv(...) and
fails if any turn up OUTSIDE the allowlist below. The allowlist is intentionally a
small, named set of files — not a blanket per-file skip for anything big or
security-adjacent — so a regression (e.g. someone adding `os.environ.get(...)` back
into auth.py or a route handler) fails this test immediately.

Allowed (legitimate env boundaries):
  webapp/config.py         — default_data_dir()'s XDG_DATA_HOME read (a boundary default).
  webapp/asgi.py           — the granian-asgi worker boot: reads the ONE launcher-set
                             env var (HT_LAUNCH_LOG) pointing at the launch ledger to
                             reconstitute AppConfig. No other env reads.
  webapp/version.py        — build identity (APP_VERSION/GIT_SHA/BUILD_TIME) is
                             legitimately env-baked.
  webapp/backup_status.py  — a SEPARATE sidecar process/entrypoint, not the main app.
  webapp/wsgi.py           — HANDLED SPECIALLY (per-line, not whole-file): the launcher
                             is allowed to read/pass the launcher-set HT_LAUNCH_LOG
                             ledger pointer to the granian worker, and NOTHING ELSE. Any
                             env read that doesn't reference LAUNCH_LOG_ENV in the SAME
                             line here fails this test.
  webapp/db.py             — HANDLED SPECIALLY (per-line): only _env_default_config()'s
                             HT_DATA_DIR fallback, used when db.configure() was never called.

Everything else — including webapp/app.py, which after the entrypoint-consolidation
refactor is a pure-flag CLI (deploy_lib and container_entry own the file/secret sources)
— must read `cfg`/AppConfig only. If this test fails, either route the new read through
AppConfig (preferred) or, if it's a genuine new boundary, add it to ALLOWLIST above with
a reason.

Run with: uv run python3 webapp/tests/test_no_env_reads.py
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WEBAPP = REPO / 'webapp'

# Files allowed to read env directly, in full. (webapp/wsgi.py and webapp/db.py are
# handled separately below since only a NAMED set of lines in each file is a legitimate
# boundary — everything else in those files must remain env-free.)
ALLOWLIST_WHOLE_FILE = {
    WEBAPP / 'config.py',
    WEBAPP / 'asgi.py',
    WEBAPP / 'version.py',
    WEBAPP / 'backup_status.py',
}

# webapp/wsgi.py: ONLY lines that reference the launcher-set HT_LAUNCH_LOG env var (via
# the LAUNCH_LOG_ENV constant) are allowed. This is the launcher→granian-worker handoff
# — the single env var wsgi.py may touch after the deploy consolidation moved the
# prod/env-sourced AppConfig builder out of this file entirely. Any OTHER env read added
# to wsgi.py still fails this test.
WSGI_ALLOWED_TOKEN = 'LAUNCH_LOG_ENV'

# webapp/db.py: only the _env_default_config() fallback may read env. Matched by exact
# (stripped) line text so any OTHER env read added to db.py still fails this test.
DB_PY_ALLOWED_LINES = {
    "data_dir = Path(os.environ['HT_DATA_DIR']) if os.environ.get('HT_DATA_DIR') else default_data_dir()",
}

ENV_READ_RE = re.compile(r'os\.environ|os\.getenv|(?<!\.)\bgetenv\(')


def _py_files():
    for path in sorted(WEBAPP.rglob('*.py')):
        if 'tests' in path.relative_to(WEBAPP).parts:
            continue
        yield path


violations = []
for path in _py_files():
    if path in ALLOWLIST_WHOLE_FILE:
        continue
    text = path.read_text()
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not ENV_READ_RE.search(line):
            continue
        if path == WEBAPP / 'wsgi.py' and WSGI_ALLOWED_TOKEN in line:
            continue
        if path == WEBAPP / 'db.py' and line.strip() in DB_PY_ALLOWED_LINES:
            continue
        violations.append(f'{path.relative_to(REPO)}:{lineno}: {line.strip()}')

if violations:
    msg = '\n'.join(violations)
    raise AssertionError(
        f'found {len(violations)} app-internal environment-variable read(s) outside the '
        f'allowlisted entrypoint/boundary files — route these through AppConfig instead '
        f'(see webapp/config.py):\n{msg}'
    )

print(f'  ✓  no app-internal os.environ/getenv reads outside the allowlist '
      f'({len(list(_py_files()))} files scanned)')
print('\n\nALL NO-ENV-READS TESTS PASSED ✓')
