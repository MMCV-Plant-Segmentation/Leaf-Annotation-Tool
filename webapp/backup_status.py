"""backup-status sidecar (compose `--profile backup`): a tiny stdlib-only HTTP server
that tells the admin panel how fresh the DB replica (litestream) and files mirror
(lsyncd) are — by parsing each tool's OWN self-reported status, never by stat-ing the
backup data itself. See docs/plans/Plan — Admin sync-status panel.md, DECISION
(Christian, 2026-07-01): build the status sidecar (option C).

  - DB freshness    <- scrape litestream's built-in Prometheus metrics endpoint
                       (`addr: :9090` in ops/litestream.yml) over the compose network.
                       litestream has no "last sync unix time" gauge (see
                       litestream.io/reference/metrics — only cumulative counters), so
                       freshness is derived by tracking `litestream_sync_count` across
                       scrapes: each time the counter visibly increases we stamp "now"
                       as the last-sync time and report age since that stamp.
  - Files freshness <- parse lsyncd's own `statusFile` (shared via the small read-only
                       `lsyncd-status` volume in compose.yaml — never ${BACKUP_DIR}).
                       lsyncd rewrites this file on a fixed heartbeat regardless of
                       activity, so its header timestamp is a live "lsyncd is alive as
                       of T" signal.

No `${BACKUP_DIR}` mount anywhere in this file — only the compose network (litestream)
and the shared status-file volume (lsyncd). Deliberately dependency-light: stdlib only,
so the sidecar image needs no `pip install`.

Run standalone: `python3 -m webapp.backup_status`. Env vars:
  LITESTREAM_METRICS_URL   default http://litestream:9090/metrics
  LSYNCD_STATUS_FILE       default /var/run/lsyncd/status
  PORT                     default 8098
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_LITESTREAM_URL_DEFAULT = 'http://litestream:9090/metrics'
_LSYNCD_STATUS_DEFAULT = '/var/run/lsyncd/status'
_PORT_DEFAULT = 8098
_FETCH_TIMEOUT_S = 2.0


# ── litestream: scrape Prometheus text metrics, derive freshness from a counter ──

_SYNC_COUNT_RE = re.compile(r'^litestream_sync_count(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.MULTILINE)


def parse_litestream_sync_count(metrics_text: str) -> float | None:
    """Sum all `litestream_sync_count` samples (one per watched DB; this deployment
    only replicates app.db, but summing is robust if that ever changes). None if the
    metric is absent (e.g. wrong URL, litestream not yet ready)."""
    matches = _SYNC_COUNT_RE.findall(metrics_text)
    if not matches:
        return None
    return sum(float(v) for v in matches)


def _age_payload(last_sync_epoch: float, now: float) -> dict:
    age = max(0.0, now - last_sync_epoch)
    iso = datetime.fromtimestamp(last_sync_epoch, tz=timezone.utc).isoformat()
    return {'lastSyncIso': iso, 'ageSec': round(age, 1)}


class LitestreamFreshness:
    """Tracks `litestream_sync_count` across scrapes to infer a last-sync wall-clock
    time. On the first successful scrape the stamp is seeded to "now" (age 0) rather
    than "unknown", since a present counter already means litestream is up and has
    reported at least once."""

    def __init__(self) -> None:
        self._last_count: float | None = None
        self._last_change: float | None = None

    def observe(self, metrics_text: str, now: float | None = None) -> dict | None:
        now = time.time() if now is None else now
        count = parse_litestream_sync_count(metrics_text)
        if count is None:
            return None
        if self._last_count is None or count > self._last_count:
            self._last_change = now
        self._last_count = count
        return _age_payload(self._last_change, now)


# ── lsyncd: parse its own status-file heartbeat ──────────────────────────────────

_LSYNCD_HEADER_RE = re.compile(r'^Lsyncd status report at (.+)$', re.MULTILINE)
# Lua's os.date() with no format uses the C locale's "%c" (e.g. "Wed Jul  1 12:00:00
# 2026", note the double space before a single-digit day) — collapsed below.
_LSYNCD_TIME_FMT = '%a %b %d %H:%M:%S %Y'


def parse_lsyncd_status(status_text: str, now: float | None = None) -> dict | None:
    """Parse lsyncd's `statusFile` header line into a freshness payload, or None if
    the text doesn't look like a status report at all."""
    now = time.time() if now is None else now
    m = _LSYNCD_HEADER_RE.search(status_text)
    if not m:
        return None
    cleaned = ' '.join(m.group(1).split())
    try:
        parsed = time.strptime(cleaned, _LSYNCD_TIME_FMT)
    except ValueError:
        return None
    return _age_payload(time.mktime(parsed), now)


# ── fetch helpers (network / filesystem — kept apart from the pure parsers above) ──

def fetch_litestream_metrics(url: str, timeout: float = _FETCH_TIMEOUT_S) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 — internal compose-network URL
            return resp.read().decode('utf-8', errors='replace')
    except (urllib.error.URLError, OSError, ValueError):
        return None


def read_lsyncd_status(path: str) -> str | None:
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            return fh.read()
    except OSError:
        return None


_litestream_freshness = LitestreamFreshness()


def build_status() -> dict:
    """Assemble the `/status` JSON body: {db, files, ok}. `db`/`files` are None when
    their source can't be reached/parsed; `ok` is True only when both are present."""
    litestream_url = os.environ.get('LITESTREAM_METRICS_URL', _LITESTREAM_URL_DEFAULT)
    lsyncd_path = os.environ.get('LSYNCD_STATUS_FILE', _LSYNCD_STATUS_DEFAULT)

    metrics_text = fetch_litestream_metrics(litestream_url)
    db = _litestream_freshness.observe(metrics_text) if metrics_text is not None else None

    status_text = read_lsyncd_status(lsyncd_path)
    files = parse_lsyncd_status(status_text) if status_text is not None else None

    return {'db': db, 'files': files, 'ok': db is not None and files is not None}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        pass  # quiet by default — a status heartbeat isn't worth per-request access logs

    def do_GET(self) -> None:
        if self.path != '/status':
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(build_status()).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    port = int(os.environ.get('PORT', _PORT_DEFAULT))
    ThreadingHTTPServer(('0.0.0.0', port), _Handler).serve_forever()


if __name__ == '__main__':
    main()
