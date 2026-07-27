"""
t103 Phase C — server-side wrapper around the shared `geo-engine` WASM module
(`geo-engine/geo_engine.wasm`). Same code the leaf FE's browser `WebAssembly` runtime calls
(Phase B), driven here via `wasmtime-py` — so BE and FE stroke-outline / fuse geometry are
bit-for-bit the SAME algorithm (modulo the FE's own quantization), instead of two independent
(shapely vs. wasm) implementations drifting apart.

ABI (see geo-engine/src/lib.rs module doc): raw exports over linear memory —
`alloc(len)->ptr`, `dealloc(ptr,len)`, `process(req_ptr,req_len)->resp_ptr` where the response
is a `u32`-LE length prefix + UTF-8 JSON. Requests/response JSON is documented there too.

The module/instance/store are loaded ONCE per process (module compilation is the expensive
part) and reused; a lock serializes calls through the single `Store` (wasmtime `Store`/
`Instance` state isn't safe to call concurrently from multiple threads) — cheap enough for the
per-mutation call volume this endpoint sees (single dev server, same budget as the shapely
calls it replaces).
"""

from __future__ import annotations

import json
import struct
import threading
from pathlib import Path

import wasmtime

# geo-engine/geo_engine.wasm, relative to the repo root (this file lives in webapp/).
_WASM_PATH = Path(__file__).resolve().parent.parent / 'geo-engine' / 'geo_engine.wasm'

_lock = threading.Lock()
_state: dict | None = None  # {'store', 'memory', 'alloc', 'dealloc', 'process'}


class GeoEngineError(RuntimeError):
    """The wasm engine returned `{"error": ...}` for a request."""


def _load() -> dict:
    engine = wasmtime.Engine()
    module = wasmtime.Module.from_file(engine, str(_WASM_PATH))
    store = wasmtime.Store(engine)
    instance = wasmtime.Instance(store, module, [])
    exports = instance.exports(store)
    return {
        'store': store,
        'memory': exports['memory'],
        'alloc': exports['alloc'],
        'dealloc': exports['dealloc'],
        'process': exports['process'],
    }


def _call(req: dict) -> dict:
    """Send `req` through the wasm `process` export and return the parsed JSON response."""
    global _state
    with _lock:
        if _state is None:
            _state = _load()
        store = _state['store']
        memory = _state['memory']
        alloc = _state['alloc']
        dealloc = _state['dealloc']
        process = _state['process']

        req_bytes = json.dumps(req).encode('utf-8')
        req_len = len(req_bytes)
        req_ptr = alloc(store, req_len)
        try:
            memory.write(store, req_bytes, req_ptr)
            resp_ptr = process(store, req_ptr, req_len)
        finally:
            dealloc(store, req_ptr, req_len)

        prefix = memory.read(store, resp_ptr, resp_ptr + 4)
        (resp_len,) = struct.unpack('<I', prefix)
        body = memory.read(store, resp_ptr + 4, resp_ptr + 4 + resp_len)
        dealloc(store, resp_ptr, 4 + resp_len)

        return json.loads(body.decode('utf-8'))


def _rings(resp: dict) -> list[list[list[float]]]:
    if 'error' in resp:
        raise GeoEngineError(resp['error'])
    return resp.get('rings', [])


def outline_polyline(points: list, radii: list) -> list[list[list[float]]]:
    """Outline a polyline stroke (round joins/caps, per-vertex radius). `points`/`radii` are
    parallel lists (`[[x,y],...]` / `[r,...]`). Returns a list of rings (`[[x,y],...]`)."""
    return _rings(_call({'op': 'outline', 'kind': 'polyline',
                          'points': [[float(p[0]), float(p[1])] for p in points],
                          'radii': [float(r) for r in radii]}))


def outline_brush(points: list, size: float) -> list[list[list[float]]]:
    """Outline a freehand brush stroke (perfect-freehand-equivalent) of constant `size`
    (diameter). Returns a list of rings."""
    return _rings(_call({'op': 'outline', 'kind': 'brush',
                          'points': [[float(p[0]), float(p[1])] for p in points],
                          'size': float(size)}))


def fuse(polygons: list) -> list[list[list[float]]]:
    """Union `polygons` (each an outer contour `[[x,y],...]`, holes not expected but
    self-intersections repaired), dropping interior holes. Returns a list of rings — one per
    disjoint output piece."""
    return _rings(_call({'op': 'fuse',
                          'polygons': [[[float(p[0]), float(p[1])] for p in poly]
                                       for poly in polygons]}))


def version() -> str:
    """The engine's own version — lets a caller prove which engine it is actually running.

    A copying build step catches a stale artifact at BUILD time; this catches it at RUNTIME,
    which is the case no build step can see (e.g. a stale wasm inside a deployed container).
    The FE binding exposes the same call, and the parity fixture pins both to one answer.
    """
    resp = _call({'op': 'version'})
    if 'error' in resp:
        raise GeoEngineError(resp['error'])
    return resp['version']
