"""Composite ASGI application served by granian-asgi (see webapp/wsgi.py:launch_granian).

Two dispatchers, one entry point:
  scope['type'] == 'websocket' → _ws_handler (auth + ping/pong; Phase 0 skeleton).
  everything else (http, lifespan) → asgiref.wsgi.WsgiToAsgi(<Flask app>).

The websocket branch MUST run first — WsgiToAsgi raises on the websocket scope.

Config handoff: launcher writes a JSONL `starting` record to HT_LAUNCH_LOG; this module
reads the LATEST such record at import time to reconstitute AppConfig and calls the
existing create_app(cfg) path. No ambient env sniffing (that's why this file is
allowlisted in test_no_env_reads — the ONE env var read is the launcher-set ledger
pointer).

WS auth (Phase 0): the Flask session cookie is parsed with the SAME signing serializer
`session` uses via SecureCookieSessionInterface — no invented token auth, no
side-channel — so a WS handshake fails closed for anyone who doesn't already have a
`login_required`-valid session.

Connection registry: `_connections` is keyed `(projectId, imageId)` → set of send
callables. Phase 0 populates the shape but never broadcasts on it; Phase 2 will bind
create/edit/erase/undo op-echos to that registry.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs

from asgiref.wsgi import WsgiToAsgi
from flask.sessions import SecureCookieSessionInterface

from .app import create_app
from .wsgi import LAUNCH_LOG_ENV, cfg_from_ledger, mark_failed, mark_ready

# ── Boot ──────────────────────────────────────────────────────────────────────

_ledger = os.environ.get(LAUNCH_LOG_ENV)
if not _ledger:
    raise RuntimeError(
        f'{LAUNCH_LOG_ENV} not set — webapp.asgi must be launched via '
        'webapp.wsgi.launch_granian, which writes the launch ledger and hands its path '
        'down to the worker via this env var.'
    )

_cfg, _launch_id = cfg_from_ledger(Path(_ledger))
try:
    _flask_app = create_app(_cfg)
except Exception as exc:  # noqa: BLE001 — boot failure must be recorded before re-raising
    mark_failed(_launch_id, repr(exc))
    raise

_wsgi_app = WsgiToAsgi(_flask_app)
mark_ready(_launch_id)

# ── WebSocket state ───────────────────────────────────────────────────────────

# (projectId, imageId) → set of send-callables. Phase 0 tracks the shape only; Phase 2
# broadcasts create/edit/erase/undo op-echos to per-image subscriber sets.
_connections: dict[tuple[str | None, str | None], set[Callable[[dict], Awaitable[None]]]] = defaultdict(set)


# ── WS auth (Flask-session parity with login_required) ────────────────────────

def _cookie_dict(header_value: str) -> dict[str, str]:
    """Bare-minimum RFC-6265 cookie parse. We only need name/value pairs, not
    Domain/Path/etc., because we're reading a browser-set Cookie header."""
    out: dict[str, str] = {}
    for part in header_value.split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            out[k.strip()] = v.strip()
    return out


def _load_session(cookie_value: str) -> dict | None:
    """Decode a Flask session cookie the SAME way login_required does — via
    SecureCookieSessionInterface (same salt + digest + signing serializer). Returns
    None on any parse/signature/expiry failure (equivalent to no session)."""
    interface  = SecureCookieSessionInterface()
    serializer = interface.get_signing_serializer(_flask_app)
    if serializer is None:
        return None
    try:
        return serializer.loads(cookie_value)
    except Exception:  # noqa: BLE001 — any signing failure ≡ unauthenticated
        return None


def _authed_user(scope: dict[str, Any]) -> int | None:
    """Extract user_id from the Flask session cookie carried in ASGI headers."""
    headers = {k.decode('latin-1').lower(): v.decode('latin-1')
               for k, v in scope.get('headers', [])}
    cookie_header = headers.get('cookie', '')
    if not cookie_header:
        return None
    cookies = _cookie_dict(cookie_header)
    name    = _flask_app.config.get('SESSION_COOKIE_NAME') or 'session'
    raw     = cookies.get(name)
    if not raw:
        return None
    session_data = _load_session(raw)
    if not session_data:
        return None
    return session_data.get('user_id')


# ── WS handler ────────────────────────────────────────────────────────────────

async def _ws_handler(scope, receive, send) -> None:
    """Phase 0: auth off the Flask session, then ping/pong. NO annotation ops.

    Rejects unauthenticated handshakes with close code 1008 BEFORE accepting (browser
    never sees an 'open' event). Authenticated connections are added to the shape-only
    _connections registry keyed on (projectId, imageId) parsed from the query string.
    """
    # ASGI spec: first message on a websocket scope is 'websocket.connect'.
    connect = await receive()
    if connect.get('type') != 'websocket.connect':
        return

    if _authed_user(scope) is None:
        await send({'type': 'websocket.close', 'code': 1008})
        return

    await send({'type': 'websocket.accept'})

    qs  = parse_qs(scope.get('query_string', b'').decode('latin-1'))
    key = (qs.get('projectId', [None])[0], qs.get('imageId', [None])[0])
    _connections[key].add(send)
    try:
        while True:
            msg   = await receive()
            mtype = msg.get('type')
            if mtype == 'websocket.disconnect':
                break
            if mtype != 'websocket.receive':
                continue
            text = msg.get('text')
            if not text:
                continue
            try:
                payload = json.loads(text)
            except (ValueError, TypeError):
                continue
            if payload.get('type') == 'ping':
                await send({'type': 'websocket.send',
                            'text': json.dumps({'type': 'pong'})})
    finally:
        _connections[key].discard(send)
        if not _connections[key]:
            _connections.pop(key, None)


# ── Composite ASGI callable ───────────────────────────────────────────────────

async def app(scope, receive, send) -> None:
    """Intercept websocket FIRST (WsgiToAsgi raises on that scope), delegate everything
    else (http + lifespan) to the Flask app via asgiref."""
    if scope['type'] == 'websocket':
        return await _ws_handler(scope, receive, send)
    return await _wsgi_app(scope, receive, send)
