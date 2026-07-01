"""Admin sync-status proxy: fetch_sync_status() asks the `backup-status` sidecar
(compose `--profile backup`) for litestream/lsyncd freshness, over the compose
network only. The main app never mounts BACKUP_DIR and never depends on backup to
run — see docs/plans/Plan — Admin sync-status panel.md (DECISION: build the status
sidecar, 2026-07-01).

If the sidecar is unreachable (no backup profile — dev/local — or it's mid-restart),
this returns {'configured': False} rather than raising, so GET /api/sync-status
always answers 200 and the admin panel just shows "backup not configured".
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

_URL_DEFAULT = 'http://backup-status:8098/status'
_TIMEOUT_S = 1.5


def fetch_sync_status(timeout: float = _TIMEOUT_S) -> dict:
    url = os.environ.get('BACKUP_STATUS_URL', _URL_DEFAULT)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 — internal compose-network URL
            body = json.loads(resp.read().decode('utf-8'))
    except (urllib.error.URLError, OSError, ValueError):
        return {'configured': False}
    body['configured'] = True
    return body
