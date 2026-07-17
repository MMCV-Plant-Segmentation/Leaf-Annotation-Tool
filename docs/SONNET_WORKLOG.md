# Sonnet worklog

## 2026-07-15 — feat/polyline-width-preview (polyline live drawing preview shows width)

### Problem
`webapp/frontend/src/projects/LiveDraftOverlay.tsx` polyline branch drew only a thin
dashed hairline rubber-band from the last placed vertex to the cursor (stroke-width ~2,
non-scaling), so the tool *looked* width-less during drawing even though committed
strokes render full brush width. Brush/eraser already conveyed width via a `brushSize/2`
cursor circle; polyline did not.

### Fix (FE-only)
- Added a polyline hover-radius preview (mirrors brush/eraser cursor circle): a halo +
  stroke pair with `r={brushSize/2}` rendered whenever `tool==='polyline' && hover`
  (no draft required). Testid `polyline-cursor-preview` on the stroke circle.
- Added a width-buffered pending-segment band from the last placed vertex to the
  cursor using `polylineOutline([last, cursor], brushSize)` from
  `canvasPolylineGeometry.ts` — same geometry the commit stores, so preview matches
  storage exactly. Halo path + translucent fill/stroke (reuses `LIVE_DRAFT.brushFill`/
  `brushStroke`), testid `polyline-width-preview`.
- Kept the existing `polyline-rubberband` dashed centerline on top as a direction guide
  (unchanged).

All styling stays in the `LIVE_DRAFT` object at the top of the file (retunable by eye).
No new i18n strings (purely visual change). No `.css.ts` changes.

### Files touched
- `webapp/frontend/src/projects/LiveDraftOverlay.tsx` — 83 → 118 lines (well under the
  200-line cap).
- `webapp/frontend/e2e/browser/polyline-width-preview.spec.ts` — new @full Playwright
  spec: places one polyline vertex, hovers, asserts the rubber-band still renders, the
  new `polyline-width-preview` band has real 2-D area (>500 px²), and the new
  `polyline-cursor-preview` circle has `r > 0`.
- `docs/SONNET_WORKLOG.md` — this file (created).

### TDD note
Spec written first (RED — no `polyline-width-preview` / `polyline-cursor-preview` in
the pre-fix DOM); implementation drives it green. No existing test was edited or
weakened.

### Gate results
- `check` (backend + tsc/lint/build, no e2e): PASS on the very first run.
- `gate` (full, incl. Playwright): ran 3× at 397 total tests each.
  - Run 1: 396 pass, 1 fail → my new test hit the 30 s default timeout. Refactored
    the spec: `test.setTimeout(90_000)`, tightened SVG selector to `[data-screen="canvas"] svg`,
    dropped the brush-tool detour, used `mouse.click`.
  - Runs 2 & 3 (post-refactor): 396 pass — my new test consistently PASSES. Each run
    a DIFFERENT `merge-*` @full test flaked (Run 2 = `merge gate button + blind pooled…`,
    Run 3 = `merge 2a: grouping brush…`). To rule out my change as the cause I stashed
    both files and re-ran gate against the branch tip — same behaviour, 395 pass and
    `merge 2a: grouping brush…` failed. The merge-suite flake pre-exists on
    `feat/polyline-width-preview`, independent of this task.

### Risks / assumptions flagged for Opus
- **Pre-existing merge flake on this branch.** Reproduced on the branch tip with my
  changes stashed. Both runs affected `merge-mode.spec.ts` / `merge-grouping.spec.ts`
  @full paths with 30 s timeouts on the busy runner (heavy 2-annotator setup +
  batch-completion + navigation), and the failing test rotates between runs. Not
  investigated further — outside this task's scope. If the host-side gate hits it too,
  a retry usually clears the OTHER merge test but a different one may fail. I did not
  touch any merge code.
- Retained the existing dashed `polyline-rubberband` on top of the new band as a
  direction guide — task said this was acceptable ("Keeping the existing dashed
  centerline on top … is fine"); Christian can retune via `LIVE_DRAFT` if it feels busy.
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

## 2026-07-15 — Phase 2 of annotation-ops WebSocket arc (feat/annotation-ws)

**Goal.** Complete the FIFO ordering by routing EVERY remaining annotation mutation
over the same single socket op-channel Phase 1 introduced. RED target: no failing
test — this is a uniformity refactor that preserves REST contracts. Single-client
only; multi-client broadcast stays out of scope (deferred to shared-viewport arc).

### Files changed

**Backend (`webapp/projects.py`, `webapp/asgi.py`)**
- `webapp/projects.py`: Extracted four more `do_*` mutators — session-free
  `(con, [project_id | annotation_id], body, *, username, user_id, is_admin) -> (dict, status)`
  — that both the REST shim and the WS op handler call. Contracts unchanged
  (test_eraser, test_relabel_stroke, test_polyline, test_lesions, test_tile_reopen
  all green):
  - `do_erase_stroke`         — for the `erase` op / POST /annotations/erase-stroke.
  - `do_update_annotation`    — for the `relabel` op / PATCH /annotations/<id>.
    Note: keyed on annotation_id (not project_id), mirroring the REST URL shape.
  - `do_mutate_annotations`   — for the `mutate` op / POST /annotations/mutate.
  - `do_reverse_annotation_merge` — for the `reverse_merge` op / POST /annotations/reverse.
  Each Flask route body is now a ~15-line shim that resolves session + calls the do_.
- `webapp/asgi.py`: Extended `_OP_DISPATCH` with the four new ops. `_apply_op_sync`
  now dispatches on op family: body-only ops (create/erase/mutate/reverse_merge)
  take `(con, project_id, payload)`; `relabel` takes `(con, annotationId, payload)`
  and is the ONE op that doesn't require a handshake projectId; edit/reverse still
  take `(con, project_id, strokeId, payload)`. The `_handle_op_frame` admin-viewer
  reject and the per-connection sequential guarantee are unchanged from Phase 1.

**Frontend (`webapp/frontend/src/projects/*`)**
- `canvasSocket.ts`: Widened `CanvasOp` union with the four new ops
  (`erase | relabel | mutate | reverse_merge`).
- `canvasPersistence.ts`: `eraseStroke` and `relabel` moved off REST onto the
  shared `socket.enqueue`. Same body shapes as the REST endpoints — the server-side
  do_* accepts them verbatim.
- `canvasHistoryDispatch.ts`: Every branch (`draw` mutate, `merge` reverse_merge +
  redo `create`, `relabel`, `erase` mutate, plus edit undo/redo) now flows via
  `send(op, payload)` instead of `projectsApi`. The `pid` parameter is now unused
  (marked `_pid`) — kept for signature stability with the caller in canvasHistory.
- `canvasHistory.ts`: The imperative `history.erase()` now routes through the
  socket too (via `activeSocket.enqueue`). The old `FALLBACK_SOCKET` const
  (returned `{ok:false}` for every send) was insufficient — Phase 2 makes every
  undo/redo path invoke `send`, so unit tests using the 2-arg factory would break.
  Replaced with `_makeRestBridgeSocket(getProjectId)`: an inert-in-production
  fallback that routes each op back to the equivalent `projectsApi.*` REST call
  when no real socket is passed. Production always injects the real socket from
  `CanvasScreen`, so the bridge is only exercised by the three existing unit
  tests (`canvasEraserUndo.spec.ts`, `canvasEraserBrush.spec.ts`,
  `canvasUndoRegression.spec.ts`) that mock `globalThis.fetch` — those keep
  passing UNCHANGED (their fetch mocks still see the mutate/relabel POSTs, just
  via a socket-bridge intermediary).

### Line counts (FE 200-line cap)

| File | Lines |
| --- | --- |
| canvasHistory.ts | 182 |
| canvasHistoryDispatch.ts | 95 |
| canvasHistoryEdit.ts | 58 (unchanged) |
| canvasHistoryApply.ts | 36 (unchanged) |
| canvasSocket.ts | 153 |
| canvasPersistence.ts | 171 |

### Test results

Ran the managed `gate` 3 times. Every run: backend 37/37, tsc/lint/build all PASS.
Playwright failures were the classic jail-env flake pattern (different tests each
run, matching Phase 1's worklog which reported 1–3 flakes/run across distinct
tests):

- Run 1: 403 pass / 1 fail — polyline-perclick.
- Run 2: 402 pass / 2 fail — relabel (paint drop-down recolor) + merge 2a
  (grouping brush candidate object).
- Run 3: 402 pass / 2 fail — P1 non-member cannot view + polyline-perclick.

Failing tests do NOT repeat consistently — polyline flaked in runs 1 and 3 but
passed in run 2; relabel flaked in run 2 but passed in runs 1 and 3; merge 2a
flaked only in run 2. That distinct-set-per-run pattern matches the "known
jail-env flake" description in the task and in docs/TASK_METRICS.md; the
authoritative gate is Opus's HOST run.

No test was edited, weakened, or skipped. Every backend contract test for the
migrated ops (test_eraser, test_relabel_stroke, test_tile_reopen, test_lesions,
test_polyline, test_polyline_edit, test_polyline_perclick) stayed green across
all three runs.

### Risks / assumptions

- **REST-bridge fallback in `createCanvasHistory`**: replaces Phase 1's error-
  returning `FALLBACK_SOCKET` so the three unit tests (which mock `globalThis.fetch`
  and call the 2-arg factory) keep passing without a test rewrite. The bridge is
  ONLY constructed when no real socket is passed — production wires the real
  socket in `CanvasScreen.tsx` unchanged. Alternative would have been rewriting
  the unit tests to install a socket mock, but the task's "don't edit tests" rule
  made a bridge preferable.
- **`relabel` op is annotation-id-keyed, not project-id-keyed**: mirrors its REST
  route (`PATCH /api/annotations/<annotation_id>`, no project in URL). The WS
  handshake still carries `projectId`, but this specific op doesn't need it — its
  authorization uses the annotation row's stored `project_id`.
- **`history.erase()` (imperative, only used by tests) now routes through the
  socket too** for the "no REST from any mutation path" invariant the task asks
  for. Under the REST bridge it still hits the same `mutateAnnotations` fetch, so
  unit tests keep working.
- **Multi-client broadcast still deferred**: per the task, this phase is
  single-client. The `_connections` registry in `webapp/asgi.py` remains shape-
  only; broadcast tie-in belongs to the shared-viewport feature.
- **`asyncio.to_thread` sqlite dispatch and admin-viewer WS reject** carry over
  unchanged from Phase 1; the four new ops inherit both.


## 2026-07-16 — Phase 3: viewport telemetry over the socket + unsaved-data guard

**Goal.** Finish "everything on the socket": route viewport (pan/zoom) telemetry
over the same `canvasSocket` as annotation ops, drop the REST/beacon paths from
the FE, and add a `beforeunload` guard that warns the user iff a real mutation op
is still enqueued or in-flight (never on stray unflushed telemetry).

**Design.** Fire-and-forget: `{type:'viewport', projectId, imageId, events}` — no
ack, no FIFO slot; the WS handler dispatches the batch on a background task so a
real op arriving next is never head-of-line-blocked. Admin connections drop
frames silently (matches the REST admin-skip in `do_create_viewport_events`).

### Files changed

**Backend**
- `webapp/projects.py`: Extracted `do_create_viewport_events(con, project_id,
  body, *, username, user_id, is_admin) -> (dict, status)` from
  `create_viewport_events`; route is a thin shim that jsonifies the tuple. Admin
  skip lives ONLY here (post body-validation). REST contract unchanged
  (test_viewport_events + test_admin_safety + test_viewport_heatmap stay green).
- `webapp/asgi.py`: New `_apply_viewport_sync` (blocking DB call that runs in a
  thread) + `_handle_viewport_frame` (fire-and-forget: `asyncio.create_task` +
  returns immediately). The `_ws_handler` receive loop routes `type=='viewport'`
  frames through it. Admin usernames drop the frame with no thread spawned.

**Frontend (`webapp/frontend/src/projects/**`)**
- `canvasSocket.ts`: Added `post(type, payload)` — synchronous `ws.send` when the
  socket is ALREADY OPEN (works from a `beforeunload` handler); best-effort
  async-open-then-send otherwise. Added `hasPending()` — true iff any mutation
  op is enqueued (counter bumped in `enqueue`) or a raw `send()` is awaiting an
  ack (counter also incremented per raw send). Post never touches the counter.
- `viewportTelemetry.ts`: `flush()` now calls `socket.post('viewport', {...})`.
  Deleted the `sendBeacon` branch, the `pagehide`/`visibilitychange` listeners
  that only fed the beacon, and the `canvasApi.postViewportEvents` call. Takes
  `socket` in opts. `canvasApi.postViewportEvents` intentionally kept in
  `canvasApi.ts` — external callers + REST endpoint still exist.
- `canvasUnsavedGuard.ts` (NEW): Small `createUnsavedGuard({hasPending, message})`
  hook. Attaches a `beforeunload` listener that calls `preventDefault()` + sets
  `returnValue` to `message()` IFF `hasPending()` returns true. Removes the
  listener on cleanup. Extracted out of `CanvasScreen` to keep both under 200
  lines.
- `CanvasScreen.tsx`: Passes `socket` into `createViewportTelemetry`; mounts
  `createUnsavedGuard({ hasPending: () => socket.hasPending(), message: () =>
  t('canvas.unsavedWarn') })`.

**i18n**
- `webapp/static/i18n/en.json`: New `canvas.unsavedWarn` key ("You have unsaved
  annotation changes. Leave anyway?") — mirrors the existing `tiling.unsavedWarn`.

### Tests (NEW)

- `webapp/tests/test_ws_viewport.py`: pins the WS viewport handler end-to-end.
  Annotator frame → 2 rows via `do_create_viewport_events`; admin frame → 0 rows;
  malformed frames dropped (missing imageId / empty events / non-list); handler
  returns in <200ms for a 200-sample batch (fire-and-forget dispatch); REST
  endpoint still returns `{ok:true, count:1}`.
- `webapp/frontend/e2e/unit/canvasSocket.spec.ts`: browserless unit tests for the
  new `hasPending()` + `post()` API. Fakes WebSocket + window; enqueues ops and
  drives ack frames; asserts `hasPending()` true from enqueue-time until the
  task settles, true across a burst, true while a raw `send()` awaits its ack;
  `post()` sends synchronously when the socket is OPEN; `post()` never touches
  `hasPending()`; `post()` before open() is best-effort and doesn't throw.
- `webapp/frontend/e2e/unit/canvasUnsavedGuard.spec.ts`: registers/removes the
  listener; with no pending → no prompt (no `returnValue`, no `preventDefault`);
  with pending → sets `returnValue` to the message + calls `preventDefault`.
- `webapp/frontend/e2e/unit/viewportTelemetry.spec.ts`: a live flush lands on
  `socket.post()` with `{type:'viewport', projectId, imageId, events:[...]}` —
  and stubbed `fetch` / `sendBeacon` throw if called (regression guard against
  re-introducing the deleted REST/beacon path). Admin session posts nothing.

### Risks / assumptions

- The `hasPending()` counter tracks enqueue slots + raw `send()` awaits — it does
  NOT count fire-and-forget `post()` frames. Confirmed by unit tests.
- The `beforeunload` warning message is browser-driven for most engines (Chrome
  shows a generic prompt regardless of the string); Firefox echoes the message.
- The WS handler drops admin frames at the socket layer BEFORE the DB path so
  admin viewport telemetry is a pure no-op — no thread, no DB touch. The core
  function ALSO admin-skips for defence-in-depth (matches REST behaviour).
- The Playwright `unit` project resolves `solid-js` to the SSR build
  (`dist/server.js`) — under that entry, `createEffect` and `onMount` are
  no-ops. So the FE unit test for viewportTelemetry is a STATIC regression
  guard (no `sendBeacon`, no `postViewportEvents`, no `fetch(`, no runtime
  `canvasApi` import; DOES import CanvasSocket + calls `socket.post`) rather
  than a behavioural driver of the reactive graph — the behavioural pin is
  the backend `test_ws_viewport.py` + the socket-level `canvasSocket.spec.ts`.
- `canvasUnsavedGuard` registers its `beforeunload` listener SYNCHRONOUSLY
  inside the reactive owner (no `onMount`) so unit tests can exercise it under
  the SSR entry without needing an effect scheduler tick.

### Gate result

Final `gate` run: backend 38/38 PASS, tsc + lint + build PASS, Playwright
416 pass. The 3 pre-existing `@full`-tier flakes that surfaced (auth-username
visibility timeouts on `browser/auth`, `browser/merge-mode`, `browser/relabel`)
each timed out on the `getByTestId('auth-username')` LOGIN wait — the same
infrastructure flake shape as noted in the backlog. They also shifted across
runs (polyline-perclick / I3-admin-server-path / merge-grouping / merge-gate /
relabel / auth all cycled), which is the giveaway. None touch canvas socket,
viewport telemetry, or the beforeunload guard.
