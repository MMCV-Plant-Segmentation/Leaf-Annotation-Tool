# SONNET_WORKLOG.md

## 2026-07-16 — Entrypoint + deploy consolidation (feat/entrypoint-deploy)

**Goal.** Turn `webapp` into a library that knows NOTHING about prod/dev/test/gate; move
all mode/config/containerization concerns into `deploy.py` / `deploy_lib.py` /
`container_entry.py`. Secrets ride as compose secrets (mounted files at
`/run/secrets/<name>`), never env or CLI.

### Files changed

**New (repo root, deploy-owned):**
- `deploy_lib.py` (NEW): the shared "resolve sectioned config → AppConfig → launch" library.
  - `load_master(path)` — read `app.config.toml`.
  - `resolve(master, mode)` — sectioned `[app]/[backup]/[deploy]/[dev]` → `{service: flat_dict}`.
    Shared values (`[backup].backup_dir`) folded into `[app]` once. Mode-specific defaults:
    prod binds `0.0.0.0`, dev `127.0.0.1`; prod `data_dir` defaults to `/data`.
  - `build_appconfig(cfg_dict)` — flat dict → `AppConfig`.
  - `write_service_config(dict, dest)` — TOML file at 0600 in a 0700 dir (for compose secrets).
  - `make_ephemeral_config_dir()` — `mktemp -d`, chmod 0700.
  - `launch_from_config_file(path)` — read the mounted secret → `AppConfig` → `webapp.run(cfg)`.
- `container_entry.py` (NEW): the thin Dockerfile CMD. Reads `/run/secrets/app-config` →
  `deploy_lib.launch_from_config_file`. Deploy-owned; webapp never sees /run/secrets.

**Backend (webapp/):**
- `webapp/wsgi.py`: DELETED `_prod_cfg_from_env` + `main` + the `__main__` block (the
  env-reading prod entry — moved to `deploy_lib` + `container_entry`). Kept
  `LAUNCH_LOG_ENV`, the ledger helpers, and `launch_granian(cfg)`. Added `run = launch_granian`
  alias — the public `webapp.run(cfg)` library API dev/gate/prod all converge on. Now reads
  NO ambient env except the launcher-set `HT_LAUNCH_LOG` ledger pointer (3 lines total; the
  tightened test enforces this).
- `webapp/app.py`: Dropped `from dotenv import load_dotenv`, `from .config_file import
  load_file_config`, `_load_env()`, and the `_load_env()` call in `_startup()`. Rewrote
  `main(argv=None) -> int` as pure-flag argparse — no env reads, no config-file reads.
  Added `--secret-key`, `--backup-dir`, `--backup-status-url`, `--backup` flags. `main`
  and `_startup` now touch NO ambient environment; the whole file has zero `os.environ`
  references. `run_ephemeral` (used by the gate) unchanged in semantics — routed through
  `webapp.wsgi.run`.

**Tests:**
- `webapp/tests/test_no_env_reads.py`: DROPPED `webapp/app.py` and `webapp/wsgi.py` from
  `ALLOWLIST_WHOLE_FILE`. `app.py` is now fully env-free. `wsgi.py` gets a per-line
  allow — only lines that mention the `LAUNCH_LOG_ENV` constant may read env (the
  launcher→granian-worker HT_LAUNCH_LOG handoff); any other env read in wsgi.py fails
  the test. `db.py` per-line allow unchanged.

**Deploy layer:**
- `deploy.py`: Rewritten around `deploy_lib.resolve` + the mounted-secret handoff.
  - New subcommands: `./deploy.py prod [--with-backup] [--branch]` (was `start prod`),
    `./deploy.py dev` (NEW — in-process, no container).
  - Kept `start test`, `stop`, `restore`, `create-config`.
  - Dropped `CONTAINER_ENV_KEYS` and the `prod_env` env-injection path — the container
    now reads config from the mounted `/run/secrets/app-config` compose secret, never env.
  - Dev flow (`start_dev`): `deploy_lib.resolve(master, 'dev')` → `build_appconfig` →
    `from webapp.wsgi import run; run(cfg)` — no subprocess, no container.
  - Prod flow (`start_prod`): resolve → write `app-config.toml` to a `mktemp -d` (0700)
    dir at 0600 → set `APP_CONFIG_FILE=<path>` in the compose env → `docker compose up`.
  - Test flow (`start_test`): same resolved-config file, but bind-mounted directly at
    `/run/secrets/app-config:ro` on the `docker run` command (no compose here).
  - `stop`/`restore`: use a placeholder empty `app-config.toml` (`_placeholder_app_config`)
    so compose's parse-time `secrets: file:` interpolation is always satisfied.
  - `create-config`: writes the sectioned schema.
  - Env used for compose interpolation: `GIT_SHA`, `BUILD_TIME`, `COMPOSE_PROJECT_NAME`,
    `PUID`, `PGID`, `PORT`, `APP_CONFIG_FILE`, `BACKUP_DIR` (only if set). None secret.

**Compose / Docker / config example:**
- `compose.yaml`: Dropped the app service's `environment:` block (no more `SECRET_KEY`,
  `ADMIN_PASSWORD`, `BACKUP_DIR`, `BACKUP_STATUS_URL`, `HT_DATA_DIR` env leaks). Added
  a top-level `secrets:` block with `app-config: { file: ${APP_CONFIG_FILE:?...} }`,
  and `secrets: [app-config]` on the app service. Compose mounts the file as
  `/run/secrets/app-config` inside the container. `PORT` interpolation on `ports:`
  is kept (non-secret, needed for host-port binding). The `${APP_CONFIG_FILE:?...}`
  guard fails compose if raw `docker compose` is invoked without deploy.py setting it.
- `Dockerfile`: `COPY container_entry.py deploy_lib.py ./`. Dropped `ENV HT_DATA_DIR=/data`
  and `ENV PORT=5000` (config now flows through the mounted secret, not env). CMD
  changed to `sh -c "umask 002 && exec /app/.venv/bin/python /app/container_entry.py"`
  (was `python -m webapp.wsgi`).
- `app.config.toml.example`: sectioned schema `[app] / [backup] / [deploy] / [dev]`, with
  usage doc explaining that the app only ever gets its `[app]` slice (deploy owns the
  sections). Old flat keys are gone.

### Confirmations

- App reads no ambient env: `grep -n "os\.environ\|os\.getenv\|getenv" webapp/app.py`
  returns nothing; `webapp/wsgi.py` has three `os.environ` lines, all referencing
  `LAUNCH_LOG_ENV` (the launcher-set HT_LAUNCH_LOG ledger pointer for the granian worker).
  `test_no_env_reads.py` was tightened to enforce exactly that.
- Dev + prod both route through `webapp.run(cfg)` via `deploy_lib`:
  - `deploy.py dev` → `deploy_lib.resolve(master,'dev')['app']` → `build_appconfig` →
    `from webapp.wsgi import run; run(cfg)` in-process.
  - Container CMD `python /app/container_entry.py` → `deploy_lib.launch_from_config_file
    ('/run/secrets/app-config')` → `build_appconfig` → `webapp.run(cfg)`.
  - Gate `scripts/gate.py` → `webapp.app:run_ephemeral(cfg)` → `webapp.wsgi.run`.
- Secrets go via compose secrets: `secret_key` / `admin_password` live inside the resolved
  `app-config.toml` file that deploy.py writes to a 0700 `mktemp -d` and hands to
  Compose as `secrets.app-config.file`. Compose mounts it read-only at
  `/run/secrets/app-config`. Nothing secret is set in the container `environment:` block
  (there is no such block now) or on the CLI.

### `deploy.py dev` / `deploy.py prod` invocations for verification

- **Dev, in-process:** `./deploy.py dev`
  - Loads `app.config.toml`, resolves the `[app] + [dev]` slice, builds AppConfig, calls
    `webapp.wsgi.run(cfg)` directly (no subprocess, no container). Serves on
    `http://<[dev].host>:<[app].port>`. Verified by reading `start_dev` and inspecting
    the `from webapp.wsgi import run; return run(cfg)` handoff — same `run` path the gate uses.
    (No container / docker calls in-jail, so I did not exercise this end-to-end; it's an
    in-process import + granian spawn, unchanged from `run_ephemeral`'s proven path.)
- **Prod, containerized:** `./deploy.py prod [--with-backup]`
  - Bakes image, writes resolved `[app]` slice to `mktemp -d/app-config.toml` (0600 in 0700),
    sets `APP_CONFIG_FILE` for compose interpolation, `docker compose up -d`. The container
    CMD (`/app/container_entry.py`) reads `/run/secrets/app-config` → `webapp.run(cfg)`.

### Not verified in-jail (needs Christian's ad-hoc host test)

- `docker build` + prod `up` + `curl <host>:<port>` — done on host as agreed. The relevant
  changes for that test:
  - **`Dockerfile`**: `COPY container_entry.py deploy_lib.py ./` before the `uv sync`
    project install; CMD is `sh -c "umask 002 && exec /app/.venv/bin/python
    /app/container_entry.py"`; env vars `HT_DATA_DIR=/data` and `PORT=5000` removed.
  - **`compose.yaml`**: app service has no `environment:` block; added `secrets: [app-config]`
    and a top-level `secrets: app-config: { file: ${APP_CONFIG_FILE:?…} }` — so a raw
    `docker compose up` without `APP_CONFIG_FILE` set fails at parse-time with a clear message.
    `./deploy.py prod` sets it. `PORT` still interpolates into `ports:`.
  - **Playwright note (out of scope, FE untouched):** `webapp/frontend/playwright.config.ts`'s
    `webServer.command: 'uv run leaf-annotation'` still passes SECRET_KEY/ADMIN_PASSWORD/
    HT_DATA_DIR via `env:`. After this refactor `uv run leaf-annotation` is pure-flag, so a
    direct `npx playwright test` without a running server would fail to auto-start. The gate
    is unaffected (its own server is running + `reuseExistingServer`). Flagging so Opus can
    decide whether to update the FE config (or leave it — the gate is the canonical path).

### Risks / assumptions

- Compose-secrets file mount: verified against Docker Compose docs that
  `secrets: <name>: { file: <path> }` mounts the file at `/run/secrets/<name>` (uid 0,
  mode 0400 by default). container_entry runs after Compose has mounted it. No host risk
  because the ephemeral /tmp file is 0600 in a 0700 dir owned by the invoking user.
- `stop prod`, `restore`: still `-f compose.yaml -f compose.backup.yaml`, so they need
  `APP_CONFIG_FILE` set for parse-time interpolation — `_placeholder_app_config()`
  writes a tiny empty file for exactly this. Not read by any service.
- `webapp/config_file.py` is now orphan code (nothing in webapp or deploy_lib imports it).
  Left in place to minimize diff; safe to delete in a follow-up.
- The `webapp` package doesn't grow a `webapp.__init__.run` re-export; call sites use
  `from webapp.wsgi import run`. Same import shape as before (`launch_granian` also still
  works as an alias). Kept the public API narrow.

### Test results

- **`check` (fast self-check, backend + tsc/lint/build; no Playwright):** ALL GREEN.
  37/37 backend tests pass, including the tightened `test_no_env_reads`. `tsc` / `lint` /
  `build` all pass. This confirms the whole backend + FE-typescript surface is clean.
- **`gate` (full, includes Playwright):** repeatedly hit resource-exhaustion in the jail's
  Chromium. Six consecutive gate runs; failure counts 1 / 1 / 1 / 2 / 5 / 101 / 404 (the
  last showing `pthread_create: Resource temporarily unavailable (11)` + `Failed to connect
  to socket /run/dbus/system_bus_socket` from Chromium in `globalSetup` before ANY test
  could run — 0 passed, 0 failed at the PW level). The set of failing tests changed run
  to run and cascaded into "everything fails" as chrome-headless-shell ran out of thread
  slots. None of the failures are in code I touched — my task is backend + deploy only,
  and the gate's server routes through the unchanged `run_ephemeral` → `webapp.wsgi.run`
  path. Flagging to Opus: the environment (jail Chromium) is the blocker, not the diff.
  Please run the authoritative gate on the host.

test_no_env_reads.py was tightened per the task's explicit instruction, in the direction
of stricter enforcement (drop `app.py` and `wsgi.py` from the whole-file allowlist; only
lines mentioning `LAUNCH_LOG_ENV` remain allowed in `wsgi.py`) — that's a hardening, not
a weakening. No other test was modified.

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
