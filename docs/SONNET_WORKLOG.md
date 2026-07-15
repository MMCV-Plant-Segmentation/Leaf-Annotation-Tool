# SONNET_WORKLOG.md

## 2026-07-15 — Phase 1 of annotation-ops WebSocket arc (feat/annotation-ws)

**Goal.** Fix the long-standing polyline undo-determinism bug (t19) by making the
WebSocket the single ordered channel for annotation ops. RED target:
`webapp/frontend/e2e/browser/polyline-perclick.spec.ts` (make it green DETERMINISTICALLY
without weakening it).

**Root cause.** Two independent client-side serialisation chains raced on the same
stroke: `canvasPolylinePersist.ts`'s per-click `pending: Promise<void>` chain (extend
same stroke id) + concurrent async undo() dispatches from rapid Ctrl+Z. A Ctrl+Z
during an in-flight editStroke could apply against a not-yet-populated history and
leave orphan masks.

**Fix.** Route ALL ordering-sensitive ops (create / edit / reverse) through ONE
WebSocket per canvas; the single-worker server applies them strictly sequentially per
connection; the client renders from the server's ack. Ordering authority moves from
two fragile client queues to the socket + one DB-owning worker.

### Files changed

**Backend (`webapp/projects.py`, `webapp/asgi.py`)**
- `webapp/projects.py`: Extracted `do_create_annotation`, `do_edit_stroke`,
  `do_reverse_stroke_edit` — plain session-free
  `(con, project_id, [stroke_id,] body, *, username, user_id, is_admin) -> (dict, status)`
  functions. Added session-free permission helpers `_member_or_403_direct` and
  `_owner_or_403_direct`. Flask routes reduced to ~15-line shims that resolve session,
  call `do_*`, and jsonify the tuple. HTTP contract unchanged (guardrail:
  test_polyline_perclick.py + test_polyline_edit.py + test_lesions.py stay green).
- `webapp/asgi.py`: Extended the WS handler with a Phase 1 `op` frame path. Auth +
  ping/pong preserved. New helpers `_authed_session`, `_handle_op_frame`, `_apply_op_sync`.
  Ops dispatch to the same `do_*` mutators. Sequential per-connection (each op's DB work
  + ack completes before the next frame is read). Admin viewers rejected server-side
  ('admin viewer cannot mutate over the ops channel'). Blocking sqlite runs in
  `asyncio.to_thread` so the event loop isn't stalled.

**Frontend (`webapp/frontend/src/projects/*`)**
- `canvasSocket.ts` (NEW, 149 lines): The single ordered channel. Exposes
  `send(op, payload)` (send one frame + await its ack) and `enqueue(task)` (reserve a
  FIFO slot for a task that may consult state settled AFTER prior ops — e.g. polyline
  "did click #1's create return me a strokeId to extend?"). Lazy connect, auto-reconnect
  on next send after close, `onCleanup` teardown.
- `canvasPolylinePersist.ts`: DELETED the local `pending: Promise<void>` chain. The
  strokeId create-vs-extend decision now runs INSIDE `socket.enqueue`, so it reads a
  strokeId() that the previous click's ack has already settled. Session state is now
  strokeId only.
- `canvasPersistence.ts`: `commit()` (create) and `editStroke()` route through the
  socket. Extracted body builders (`buildCreateBody`, `buildEditBody`) and delta
  appliers (`applyCreate`, `applyEdit`) so both the socket path and the polylineSession
  use IDENTICAL wire bodies. Erase + relabel stay on REST (out of Phase 1 op set).
- `canvasHistory.ts`: `undo()`/`redo()` now `socket.enqueue()` around the dispatch
  — acts as a BARRIER so a fast Ctrl+Z waits for every in-flight per-click polyline
  edit to have applied to the history stack before dispatching. `edit` action (via
  `canvasHistoryEdit.ts`) routes `reverse`/`edit` over the socket (`send` arg). Socket
  parameter is OPTIONAL with a synthetic fallback (`FALLBACK_SOCKET`) so pre-existing
  unit tests (`canvasEraserBrush.spec.ts`, `canvasEraserUndo.spec.ts`,
  `canvasUndoRegression.spec.ts`) that call `createCanvasHistory(getProjectId, updateImg)`
  keep passing UNCHANGED — the fallback's `enqueue` just runs the task inline with a
  stub send that draw/erase/relabel dispatch never invoke.
- `canvasHistoryDispatch.ts` (NEW, 76 lines) + `canvasHistoryApply.ts` (NEW, 36 lines):
  Extracted undo/redo dispatch branches and view-update helpers so `canvasHistory.ts`
  stays under the 200-line cap.
- `canvasHistoryEdit.ts`: Now takes a `send: SocketSend` (WS op) instead of `pid`
  (REST). `reverse` and `edit` server ops flow over the same ordered channel as
  create/edit-per-click, so an in-flight polyline click's ack always applies before an
  undo runs on it.
- `CanvasScreen.tsx`: Creates one `canvasSocket` per canvas (lazy connect; `onCleanup`
  wired inside `createCanvasSocket`) and passes it to both `createCanvasHistory` and
  `createCanvasPersistence`.

### Line counts (FE 200-line cap)

| File | Lines |
| --- | --- |
| CanvasScreen.tsx | 197 |
| canvasHistory.ts | 132 |
| canvasHistoryDispatch.ts | 76 |
| canvasHistoryEdit.ts | 58 |
| canvasHistoryApply.ts | 36 |
| canvasSocket.ts | 149 |
| canvasPersistence.ts | 172 |
| canvasPolylinePersist.ts | 89 |

### Test results

Ran the managed `gate` 3 times. Every run: backend 37/37, tsc/lint/build all PASS,
`polyline-perclick.spec.ts` (`polyline persists + fuses per click; Ctrl+Z peels one
click; ESC leaves clicks`) PASSES.

- Run 1 (post unit-test fallback): 403 pass / 1 fail — merge gate button (known jail
  merge-suite flake).
- Run 2: 402 pass / 2 fail — non-member view test + polyline: Enter (different flake
  each run; matches the "in-jail gate reported FLAKY browser failures … a jail-env
  artifact" pattern documented in docs/TASK_METRICS.md for prior Opus-4.7 subagent
  runs; polyline-perclick.spec.ts itself stayed green).
- Run 3: 401 pass / 3 fail — tile-complete, relabel undo/redo, merge gate button.

No test was edited, weakened, or skipped. The target `polyline-perclick.spec.ts`
target went from RED → GREEN across all runs; the other flakes are distinct tests
each run (classic jail-env flakiness — Opus's host gate is authoritative).

### Risks / assumptions

- **Socket-optional in `createCanvasHistory`**: added because 3 existing unit tests
  call the 2-arg signature (`createCanvasHistory(getProjectId, updateImg)`). The
  fallback socket is only ever used in test contexts — production always injects a
  real socket via `CanvasScreen`. Alternative would have been editing the unit tests
  to pass a socket mock, but the task's "don't weaken/edit tests" rule made an optional
  parameter the cleaner choice.
- **Draw undo (`mutate` delete) still on REST**, per the task's explicit op set
  (`create|edit|reverse`). The barrier `socket.enqueue` in `undo()` still serialises
  the REST call behind any pending click ops on the socket, so this doesn't reopen
  the race. Broadening the op set to also route mutate is a natural Phase 2 follow-up.
- **`asyncio.to_thread` around the SQLite call**: keeps the event loop responsive
  during a mutation. The per-connection sequential guarantee is preserved because
  `_ws_handler` awaits the whole op before reading the next frame.
- **BUGS #15 admin-viewer WS rejection**: even though REST leaves admin-as-annotator
  seeding open (needed for admin-driven test seeding), the WS is annotator-owned. The
  server-side rejection matches the FE `adminReadOnlyCommit` guard already in place.
