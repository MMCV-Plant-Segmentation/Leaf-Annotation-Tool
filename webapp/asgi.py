"""Composite ASGI application served by granian-asgi (see webapp/wsgi.py:launch_granian).

Two dispatchers, one entry point:
  scope['type'] == 'websocket' → _ws_handler (auth + ping/pong + Phase 1 op FIFO).
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

WS ops (Phase 1+2 — the polyline undo-determinism fix, extended to ALL annotation
mutations): each connection also carries an ordered `op` channel — client→server
`{type:"op", opId, op, payload}` where op is one of:
  create | edit | reverse                  (Phase 1: paint/edit/stroke-reverse)
  erase  | relabel | mutate | reverse_merge (Phase 2: brush eraser, label PATCH, bulk
                                             delete/restore, merge-undo)
Each op dispatches to the SAME do_* mutators the REST routes call (webapp/projects.py)
→ server→client `{type:"ack", opId, result}` or `{type:"error", opId, message}`. Ops
are processed STRICTLY SEQUENTIALLY per connection: each op's DB mutation completes and
its ack is sent before the next frame is read. That FIFO ordering — plus the ONE
mutation path — is what dissolves the two racing client-side chains that made polyline
undoes non-deterministic; Phase 2 extends the same FIFO to every remaining mutation so
draw-undo/redo, erase and relabel share the same ordering guarantee. Admin viewers
(BUGS #15) may NOT mutate: their ops are rejected here server-side (even though REST
leaves admin-as-annotator seeding available).
"""
from __future__ import annotations

import asyncio
import json
import os
import traceback
from collections import defaultdict
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs

from asgiref.wsgi import WsgiToAsgi
from flask.sessions import SecureCookieSessionInterface

from . import db as _db
from . import projects as _projects
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
    session_data = _authed_session(scope)
    return session_data.get('user_id') if session_data else None


def _authed_session(scope: dict[str, Any]) -> dict | None:
    """Extract the full session dict (user_id + username) from the Flask session cookie
    carried in ASGI headers. Returns None for any unauthenticated / malformed handshake."""
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
    return _load_session(raw)


# ── WS op dispatch (Phase 1+2 — single ordered channel for ALL annotation mutations) ─

# op → do_* function on webapp.projects. Each mutator returns (result_dict, status).
# Every op payload MUST match the body the equivalent REST endpoint accepts; per-op
# extras (strokeId / annotationId in the URL for edit/reverse/relabel) are pulled out
# of the payload here.
_OP_DISPATCH: dict[str, str] = {
    # Phase 1 — paint/edit paths.
    'create':        'do_create_annotation',
    'edit':          'do_edit_stroke',
    'reverse':       'do_reverse_stroke_edit',
    # Phase 2 — the remaining annotation mutations, on the SAME FIFO channel.
    'erase':         'do_erase_stroke',
    'relabel':       'do_update_annotation',
    'mutate':        'do_mutate_annotations',
    'reverse_merge': 'do_reverse_annotation_merge',
}


def _apply_op_sync(op: str, project_id: str | None, payload: dict, *,
                    username: str | None, user_id, is_admin: bool):
    """Blocking DB call — runs in a thread so the event loop stays responsive. Returns
    (result_dict, status_code). Any unexpected exception is caught and surfaced as a
    500-shaped tuple so the WS ack path can always send an error frame."""
    fn_name = _OP_DISPATCH.get(op)
    if fn_name is None:
        return {'error': f'unknown op: {op}'}, 400
    # `relabel` is keyed by annotationId (not project_id) — its REST cousin lives at
    # PATCH /api/annotations/<annotation_id> with no project in the URL. Every other op
    # needs the handshake's project_id.
    if op != 'relabel' and not project_id:
        return {'error': 'projectId required (WS handshake query)'}, 400
    fn = getattr(_projects, fn_name)
    con = _db.get_db()
    try:
        # Body-only ops (mirror the REST route bodies verbatim).
        if op in ('create', 'erase', 'mutate', 'reverse_merge'):
            return fn(con, project_id, payload,
                     username=username, user_id=user_id, is_admin=is_admin)
        if op == 'relabel':
            annotation_id = payload.get('annotationId')
            if not annotation_id:
                return {'error': 'annotationId required'}, 400
            return fn(con, annotation_id, payload,
                     username=username, user_id=user_id, is_admin=is_admin)
        # edit / reverse: strokeId lives in the payload (WS ops don't use URL params).
        stroke_id = payload.get('strokeId')
        if not stroke_id:
            return {'error': 'strokeId required'}, 400
        return fn(con, project_id, stroke_id, payload,
                 username=username, user_id=user_id, is_admin=is_admin)
    except Exception as exc:  # noqa: BLE001 — surface as error frame, don't kill the socket
        traceback.print_exc()
        return {'error': f'internal error: {exc}'}, 500
    finally:
        _db.close_db(con)


async def _handle_op_frame(frame: dict, project_id: str | None, session_data: dict,
                            send: Callable[[dict], Awaitable[None]]) -> None:
    """Process ONE op frame end-to-end: dispatch → ack/error. Called sequentially per
    connection from _ws_handler (each op's DB work + ack completes before the next
    frame is read), so this is the single FIFO ordering point for annotation ops."""
    op_id = frame.get('opId')
    op    = frame.get('op')
    payload = frame.get('payload') or {}

    async def _err(message: str) -> None:
        await send({'type': 'websocket.send',
                    'text': json.dumps({'type': 'error', 'opId': op_id, 'message': message})})

    if not op_id:
        await _err('opId required')
        return
    if op not in _OP_DISPATCH:
        await _err(f'unknown op: {op}')
        return

    username = session_data.get('username') or ''
    user_id  = session_data.get('user_id')
    is_admin = username == 'admin'

    # BUGS #15: admin viewer is FE read-only; block admin mutations at the WS boundary
    # (REST leaves admin-as-annotator seeding open, but the WS is annotator-owned).
    if is_admin:
        await _err('admin viewer cannot mutate over the ops channel')
        return

    # SQLite is blocking — run the mutation in a thread so we don't stall the event loop
    # (the per-connection ordering guarantee is still preserved because we await here
    # before reading the next frame in _ws_handler).
    result, status = await asyncio.to_thread(
        _apply_op_sync, op, project_id, payload,
        username=username, user_id=user_id, is_admin=is_admin)

    if status < 400:
        await send({'type': 'websocket.send',
                    'text': json.dumps({'type': 'ack', 'opId': op_id, 'result': result})})
    else:
        await _err((result or {}).get('error') or 'op failed')


# ── WS handler ────────────────────────────────────────────────────────────────

async def _ws_handler(scope, receive, send) -> None:
    """Phase 0 auth (Flask session cookie) + ping/pong; Phase 1 also serves the single
    ordered `op` channel for annotation mutations.

    Rejects unauthenticated handshakes with close code 1008 BEFORE accepting (browser
    never sees an 'open' event). Authenticated connections are added to the shape-only
    _connections registry keyed on (projectId, imageId) parsed from the query string.

    Ops are processed STRICTLY SEQUENTIALLY per connection: each op's DB mutation + ack
    completes before the next frame is read. That per-connection FIFO is the single
    ordering guarantee that dissolves the polyline-persist / undo race on the client.
    """
    # ASGI spec: first message on a websocket scope is 'websocket.connect'.
    connect = await receive()
    if connect.get('type') != 'websocket.connect':
        return

    session_data = _authed_session(scope)
    if not session_data or session_data.get('user_id') is None:
        await send({'type': 'websocket.close', 'code': 1008})
        return

    await send({'type': 'websocket.accept'})

    qs         = parse_qs(scope.get('query_string', b'').decode('latin-1'))
    project_id = qs.get('projectId', [None])[0]
    image_id   = qs.get('imageId', [None])[0]
    key        = (project_id, image_id)
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
            ptype = payload.get('type')
            if ptype == 'ping':
                await send({'type': 'websocket.send',
                            'text': json.dumps({'type': 'pong'})})
            elif ptype == 'op':
                # Await the whole op (DB mutation + ack) before reading the next frame
                # — this is what makes the per-connection channel strictly FIFO.
                await _handle_op_frame(payload, project_id, session_data, send)
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
