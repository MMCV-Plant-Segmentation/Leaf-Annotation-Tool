"""
Stack-wide version identity: build (what code is running) + schema (what DB shape
it expects). See docs/plans/Plan — Version everything (stack-wide).md.

Resolution order (robust-over-cheap — authoritative source first, graceful fallback):
  - appVersion ← env APP_VERSION → else the packaged `version` (read once from
    pyproject.toml at module load) → else "unknown".
  - gitSha     ← env GIT_SHA (baked at image build) → else runtime
    `git rev-parse --short HEAD` (dev checkout, cached at module load) → else "unknown".
  - builtAt    ← env BUILD_TIME (baked at image build) → else "dev".
  - schemaVersion ← the current Alembic revision, read from `alembic_version.version_num`
    via a connection the caller passes in (see db.py's BASELINE_REVISION / db.py's
    auto_create_schema(), which stamps/upgrades that table); None if no connection is
    given or the table doesn't exist yet.

Pure function, no Flask/app-context dependency: get_version() only touches env vars,
a cached pyproject read, a cached `git` shell-out, and (optionally) a passed-in
sqlite3.Connection. Safe to import and call from anywhere, including standalone tests.
"""

import os
import subprocess
import sqlite3
import tomllib
from pathlib import Path

_BASE = Path(__file__).parent.parent
_GIT_TIMEOUT_S = 2.0


def _read_packaged_version() -> str:
    """Read `project.version` from pyproject.toml. Falls back to "unknown" if the
    file is missing/unparseable (e.g. a packaged wheel without the source tree)."""
    try:
        data = tomllib.loads((_BASE / 'pyproject.toml').read_text())
        return str(data['project']['version'])
    except Exception:
        return 'unknown'


def _read_git_sha(cwd: Path = _BASE) -> str:
    """Shell out to `git rev-parse --short HEAD`, bounded by a short timeout so a
    hung/missing git binary never blocks startup. Returns "unknown" on any failure
    (not a git checkout, git not installed, timeout, etc.)."""
    try:
        result = subprocess.run(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_S,
        )
        if result.returncode == 0:
            sha = result.stdout.strip()
            if sha:
                return sha
    except Exception:
        pass
    return 'unknown'


# Cached at module load — these are process-lifetime constants, no need to re-read
# pyproject.toml or re-shell to git on every request.
_PACKAGED_VERSION = _read_packaged_version()
_RUNTIME_GIT_SHA = _read_git_sha()


def app_version() -> str:
    """Resolved appVersion: env APP_VERSION → packaged pyproject version."""
    return os.environ.get('APP_VERSION') or _PACKAGED_VERSION


def _git_sha() -> str:
    return os.environ.get('GIT_SHA') or _RUNTIME_GIT_SHA


def _built_at() -> str:
    return os.environ.get('BUILD_TIME') or 'dev'


def _schema_version(con: sqlite3.Connection | None) -> str | None:
    if con is None:
        return None
    try:
        row = con.execute('SELECT version_num FROM alembic_version').fetchone()
    except Exception:
        return None
    if row is None:
        return None
    return row['version_num'] if isinstance(row, dict) else row[0]


def get_version(con: sqlite3.Connection | None = None) -> dict:
    """Return {appVersion, gitSha, builtAt, schemaVersion}.

    `con`, if given, is used to read `alembic_version.version_num` (the current schema
    revision); schemaVersion is None if no connection is passed or the table isn't
    there yet. No app-context dependency — callers pass any open sqlite3.Connection
    (e.g. from db.get_db()).
    """
    return {
        'appVersion': app_version(),
        'gitSha': _git_sha(),
        'builtAt': _built_at(),
        'schemaVersion': _schema_version(con),
    }
