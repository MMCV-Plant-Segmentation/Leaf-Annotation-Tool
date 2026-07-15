#!/usr/bin/env python3
"""Single-command project gate — concurrency-safe, with verbosity levels.

Runs every check we'd otherwise run by hand and prints a compact, token-cheap digest:
  - backend test scripts  (auto-discovered: webapp/tests/test_*.py)
  - tsc / lint / build
  - the full Playwright suite against a self-managed NON-forking Flask server, started via
    webapp.app:run_ephemeral() — the SAME config→seed→create_app path main()/wsgi.py use
    (see webapp/config.py, webapp/seed.py). run_ephemeral() keeps the non-forking
    `use_reloader=False` server start (dodges the sandbox's exit-144 reaper) unchanged.

Concurrency-safe: an EPHEMERAL port (bind :0) and a PER-RUN temp dir (passed explicitly as
AppConfig.data_dir — no more HT_DATA_DIR env-var-before-import — + Playwright fixture dir +
storageState) mean two gates can run at once without colliding.

Usage:
  uv run python scripts/gate.py            # full gate, compact default output
  uv run python scripts/gate.py --no-e2e   # backend + tsc/lint/build only
  uv run python scripts/gate.py -v         # also tail each stage's log
  uv run python scripts/gate.py -q         # only the final summary line

Invoke directly with `uv run python scripts/gate.py`. Tracked in-repo (see .gitignore history).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent          # .../code
FE = REPO / 'webapp' / 'frontend'

# Reuse the SAME port primitive the deploy/app entrypoints use (webapp/seed.py) instead of a
# hand-rolled copy — the gate is one of resolve_port()'s intended 'auto' callers (see seed.py's
# module docstring). REPO must be importable for this; it is when run via `uv run`.
sys.path.insert(0, str(REPO))
from webapp.seed import free_port  # noqa: E402

# Fixed test secrets — not sensitive (e2e-only), passed as explicit AppConfig fields to the
# ephemeral server subprocess rather than env vars (see playwright_stage()).
SERVER_SECRET_KEY      = 'e2e-test-secret-key-not-for-production'
SERVER_ADMIN_PASSWORD  = 'e2e-admin-pw'


@dataclass
class Stage:
    name: str
    ok: bool
    log: Path | None = None
    detail: str = ''                       # e.g. "239 passed, 0 failed"
    failures: list[str] = field(default_factory=list)


# ── helpers ──────────────────────────────────────────────────────────────────

def run(cmd: list[str], log: Path, env: dict | None = None, cwd: Path | None = None) -> bool:
    """Run a command, append stdout+stderr to `log`, return True on exit 0."""
    full_env = {**os.environ, **(env or {})}
    with log.open('ab') as fh:
        proc = subprocess.run(cmd, cwd=str(cwd or REPO), env=full_env, stdout=fh, stderr=fh)
    return proc.returncode == 0


def wait_for_server(port: int, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    url = f'http://localhost:{port}/login'
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.4)
    return False


def parse_playwright(json_path: Path) -> tuple[int, int, int, int, list[str]]:
    """Return (passed, failed, flaky, skipped, failing_titles) from a PW JSON report."""
    data = json.loads(json_path.read_text())
    stats = data.get('stats', {})
    passed = int(stats.get('expected', 0))
    failed = int(stats.get('unexpected', 0))
    flaky = int(stats.get('flaky', 0))
    skipped = int(stats.get('skipped', 0))
    fails: list[str] = []

    def walk(suite: dict) -> None:
        for spec in suite.get('specs', []):
            if not spec.get('ok', True):
                projs = sorted({t.get('projectName', '') for t in spec.get('tests', [])} - {''})
                tag = f" [{','.join(projs)}]" if projs else ''
                fails.append(f"{spec.get('title', '?')}{tag}")
        for sub in suite.get('suites', []):
            walk(sub)

    for s in data.get('suites', []):
        walk(s)
    return passed, failed, flaky, skipped, fails


# ── stages ───────────────────────────────────────────────────────────────────

def backend_stages(log_dir: Path) -> list[Stage]:
    stages: list[Stage] = []
    tests = sorted(glob.glob(str(REPO / 'webapp' / 'tests' / 'test_*.py')))
    for t in tests:
        name = Path(t).stem
        log = log_dir / f'{name}.log'
        ok = run(['uv', 'run', 'python', t], log)
        stages.append(Stage(f'backend:{name}', ok, log))
    return stages


def static_stages(log_dir: Path) -> list[Stage]:
    specs = [
        ('tsc', ['npx', 'tsc', '--noEmit']),
        ('lint', ['npm', 'run', 'lint']),
        ('build', ['npm', 'run', 'build']),
    ]
    stages: list[Stage] = []
    for name, cmd in specs:
        log = log_dir / f'{name}.log'
        stages.append(Stage(name, run(cmd, log, cwd=FE), log))
    return stages


def playwright_stage(log_dir: Path, fixture_dir: Path, state_file: Path) -> Stage:
    log = log_dir / 'pw.log'
    json_path = log_dir / 'pw.json'
    server_log = log_dir / 'server.log'
    # Grab a free port with the SHARED webapp/seed.py primitive and hand it to both the server
    # and Playwright. The server runs port_policy='auto', so resolve_port() re-confirms it's free
    # and only falls back to another free port in the unlikely race where it got taken — the exact
    # 'auto' contract the env-unif work introduced (deploy.py start test uses the same pair).
    port = free_port()

    # Ephemeral launcher: same config→seed→create_app path as main()/wsgi.py, via
    # webapp.app:run_ephemeral(). db_seed='clean' gives this run a guaranteed-empty per-run data
    # dir; port_policy='auto' is the shared free-port policy. Config values are passed explicitly
    # (not env vars) — no more HT_DATA_DIR-before-import.
    server_code = (
        'from pathlib import Path; '
        'from webapp.app import run_ephemeral; '
        'from webapp.config import AppConfig; '
        'run_ephemeral(AppConfig('
        f'data_dir=Path({str(fixture_dir)!r}), port={port}, port_policy={"auto"!r}, '
        f'db_seed={"clean"!r}, secret_key={SERVER_SECRET_KEY!r}, '
        f'admin_password={SERVER_ADMIN_PASSWORD!r}))'
    )
    server_cmd = ['uv', 'run', 'python', '-c', server_code]
    with server_log.open('ab') as sfh:
        server = subprocess.Popen(server_cmd, cwd=str(REPO), env=os.environ, stdout=sfh, stderr=sfh)
    try:
        if not wait_for_server(port):
            return Stage('playwright:full', False, server_log, 'server failed to start')
        pw_env = {
            'TEST_PORT': str(port),
            'HT_E2E_FIXTURE_DIR': str(fixture_dir),
            'HT_E2E_STATE_FILE': str(state_file),
            'PLAYWRIGHT_JSON_OUTPUT_NAME': str(json_path),
        }
        pw_cmd = [
            'npx', 'playwright', 'test',
            '--project=unit', '--project=fast', '--project=full',
            '--reporter=list,json',
        ]
        ok = run(pw_cmd, log, env=pw_env, cwd=FE)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()

    if not json_path.exists():
        return Stage('playwright:full', False, log, 'no JSON report produced')
    passed, failed, flaky, skipped, fails = parse_playwright(json_path)
    detail = f'{passed} passed, {failed} failed'
    if flaky:
        detail += f', {flaky} flaky'
    return Stage('playwright:full', ok and failed == 0, log, detail, fails)


# ── rendering ────────────────────────────────────────────────────────────────

def render(stages: list[Stage], log_dir: Path, level: int) -> None:
    """level: 0 quiet, 1 default, 2 verbose."""
    backend = [s for s in stages if s.name.startswith('backend:')]
    pw = next((s for s in stages if s.name == 'playwright:full'), None)
    all_ok = all(s.ok for s in stages)

    if level >= 1:
        print(f'── gate ── (logs: {log_dir})')
        for s in stages:
            suffix = f'  ({s.detail})' if s.detail else ''
            print(f'  {s.name:<28} {"PASS" if s.ok else "FAIL"}{suffix}')
            if level >= 2 and s.log and s.log.exists():
                tail = s.log.read_text(errors='replace').splitlines()[-20:]
                for line in tail:
                    print(f'      | {line}')
        print()

    # Summary counts (printed at every level — the token-cheap heart of the digest).
    if backend:
        print(f'backend: {sum(s.ok for s in backend)}/{len(backend)} passed')
    if pw and pw.detail:
        print(f'playwright: {pw.detail}')

    # Names of any failures — actionable without opening logs.
    failed_stages = [s for s in stages if not s.ok]
    if failed_stages:
        print('FAILURES:')
        for s in failed_stages:
            if s.failures:
                for title in s.failures:
                    print(f'  {s.name}: {title}')
            else:
                print(f'  {s.name} → {s.log}')
                # Emit a log-tail on any log-only failure so in-jail agents (which can't
                # read the /tmp log dir) can still diagnose. Bounded (last 40 lines) to
                # keep the digest token-cheap.
                if s.log and s.log.exists():
                    tail = s.log.read_text(errors='replace').splitlines()[-40:]
                    for line in tail:
                        print(f'    | {line}')

    print('GATE: ALL GREEN' if all_ok else 'GATE: FAILURES')


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description='Project gate (concurrency-safe).')
    ap.add_argument('--no-e2e', action='store_true', help='skip Playwright (backend + tsc/lint/build only)')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('-v', '--verbose', action='store_true', help='tail each stage log')
    g.add_argument('-q', '--quiet', action='store_true', help='only the final summary')
    args = ap.parse_args()
    level = 2 if args.verbose else (0 if args.quiet else 1)

    run_dir = Path(tempfile.mkdtemp(prefix='leaf-gate-'))
    log_dir = run_dir / 'logs'
    fixture_dir = run_dir / 'fixture'
    state_file = run_dir / 'auth.json'
    log_dir.mkdir()
    fixture_dir.mkdir()

    ok = False
    try:
        stages = backend_stages(log_dir) + static_stages(log_dir)
        if not args.no_e2e:
            stages.append(playwright_stage(log_dir, fixture_dir, state_file))
        render(stages, log_dir, level)
        ok = all(s.ok for s in stages)
        return 0 if ok else 1
    finally:
        # Always drop the per-run data/fixture dir (and session state). On success drop
        # everything; on failure keep the logs so the failure is diagnosable.
        shutil.rmtree(fixture_dir, ignore_errors=True)
        state_file.unlink(missing_ok=True)
        if ok:
            shutil.rmtree(run_dir, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
