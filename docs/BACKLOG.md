# Backlog

Nice-to-have / no-deadline tasks. Not a plan — just a parking lot so good ideas don't get
lost. Pull one up when there's slack. (Renamed from RAINYDAY 2026-07-03.)

---

- **Revisit recompute-stroke-geometry-on-read (cache it?).** Christian flagged (2026-07-01) that
  `_lesions_for_image` rebuilds every stroke's shapely polygon from `points_json`/`stroke_width`/
  `outline_json` on *every* read, then unions per label. Two consequences: (a) it's why the BE's returned
  geometry isn't byte-identical to what perfect-freehand drew — for outlined strokes we do
  `ShapelyPolygon(outline).buffer(0)` (repairs self-intersections), drop interior rings (`_poly_rings`),
  and `simplify(0.75)` the union; (b) it's O(strokes) shapely work per image load. **Keep storing raw
  mouse-paths — they're the source of truth and NOT redundant** (different paths can yield the same
  geometry). The *emergent* part (the label-union → connected-component lesions) genuinely must recompute
  when the stroke set changes, so it can't be fully precomputed; but each stroke's own footprint polygon is
  immutable after creation and *could* be cached (materialize alongside `outline_json`), leaving only the
  union to recompute. Investigate whether the round-trip fidelity loss (buffer(0)/simplify) is desired or a
  bug, and whether per-stroke polygon caching is worth it. Logged 2026-07-01.

- **Move plans into a gitignored `plans/` subfolder.** Today all the working plan/task docs
  live loose in `docs/` alongside the one real doc (`SPEC.md`). Convention is that plans are
  throwaway and never committed, but they're currently just untracked-in-place, which is noisy
  (`git status` is a wall of `??`). Move every `Plan — *.md` / `Task — *.md` / `Review — *.md` /
  status/worklog doc into `docs/plans/` and gitignore that folder, leaving `docs/` for real
  committed docs only (`SPEC.md`, and `PROCEDURE.md` if we keep it tracked). Logged 2026-06-30.

- **Unify environments: one parameterized entrypoint; prod = a special test env.** Add `--data-dir` to
  `leaf-annotation` (default `$HT_DATA_DIR` → `~/.local/share/leaf-annotation`) so `testenv.sh` and
  manual runs use a flag, not an env var. Christian's bigger vision (2026-06-30): collapse the **three**
  current entrypoints into one parameterized entry — today there's `main()` (dev,
  `webapp/app.py:1086`, `app.run`), `webapp.wsgi:app` (Granian/prod), and `gate.py`'s inline
  `m.app.run(...)`. The gate, subagents, and manual testing should **all** spin up the *same* kind of
  ephemeral test environment so they strictly can't interfere (auto-resolve port conflicts by grabbing a
  free port). Test environments need a **clean-slate vs restore-from-prod** toggle for the DB. **Prod is
  then just a test env with two differences:** backup actually runs (Litestream), and it **fails hard if
  it can't bind the exact port it asked for** (no auto-fallback). Design note: `DATA_DIR`/`DB_PATH` in
  `db.py` are module-level constants read at import, so a runtime `--data-dir` means threading config in
  rather than relying on env-before-import. Logged 2026-06-30.

- **Subagent parallelism via git worktrees.** ⇒ **Detailed plan + PRIMITIVE BUILT:
  `docs/plans/Plan — Subagent parallelism (worktrees).md`; `scripts/worktree.sh` (gitignored).** Each
  agent gets its own worktree (`../worktrees/<name>` on branch `agent/<name>`): FE deps symlinked, backend
  gets its own `uv sync` venv (backend isolation **verified**), and the gate is already concurrency-safe
  (free port + /tmp DB) so N gates run at once. `add`/`list`/`rm` work. The Agent tool's native
  `isolation:"worktree"` errors here (session cwd isn't the repo) — the DIY script is the primary path and
  is backend-agnostic (works for future non-Claude agents too). **BATTLE-TESTED 2026-07-01:** ran the
  eraser + admin-viewer as two concurrent Sonnet agents in separate worktrees, each committing to its own
  branch (`feature/*`; Christian chose conventional `task|feature|fix/<name>` prefixes), both deliberately
  touching the same 3 canvas files. Result: concurrent gates (shared node_modules) had no cache races;
  backend isolation held; merged by hand (eraser ff'd, admin-viewer merged with real conflicts in
  CanvasScreen/CanvasToolbar) → merged tree gate ALL GREEN (`a75816a`). **Fix applied:** `worktree.sh` now
  auto-copies the gitignored gate tooling into each worktree (agents had to copy it by hand). **Lesson:**
  the 2nd branch was cut from an older base, so verify semantic coherence (dangling refs) after a "clean"
  auto-merge — don't trust textual cleanliness. Next: an auto-dispatch loop is optional; by-hand works well.

- **Version everything, surfaced through the stack.** Add explicit versions to FE, BE (exposed in the
  API, e.g. a `/api/version`), and the **database** (a `schema_version`/`app_version` row in a meta
  table) — plus maybe the **git hash** of the running build. Makes "what's actually deployed?" and
  migration-safety answerable at a glance. Logged 2026-06-30.

- **Migration hygiene: squash one-time migrations / consider Alembic.** We accumulate idempotent one-off
  `migrate_*` functions in `db.py`. Question to revisit: do we need them all forever? At some point
  squash the schema so there are no unsafe historical states to migrate from (a baseline), and decide
  whether to adopt **Alembic** instead of the hand-rolled PRAGMA-guarded `ALTER`s. Ties to the
  versioning item (a recorded `schema_version` makes squashing safe). Logged 2026-06-30.

- **Reusable image-viewer component; consistent controls across all viewers.** The annotator's
  pan/zoom/coordinate handling (getScreenCTM, space-pan, wheel-zoom, brush preview) is the good one —
  make it a **reusable viewer component** with pluggable tools/overlays per use-case, then update every
  other image viewer (upload preview, tiling, train/merge once rewritten) to match. One viewer, many
  toolsets. Logged 2026-06-30.

- ✅ **DONE (`3477c09`, 2026-06-30).** ~~Show the live viewport (x/y/w/h) below the image.~~ Added to the
  Projects annotator (CanvasHints component, live from the `vb` signal). Still TODO for the *other* viewers
  once the reusable-viewer item lands.

- **Non-uniform / non-rectangular tiles instead of the dirty-tile system.** Tiles exist to guide human
  eyes, so there's no real reason every tile must be identical. Instead of the current uniform grid +
  "dirty tile" bookkeeping when an image doesn't divide evenly, allow **differently-sized (and possibly
  non-rectangular) tiles** — create odd-shaped tiles for the leftover regions (can still be built from
  rectangles). Bigger data-model + tiling rethink. Logged 2026-06-30.

- **Annotator data collection: pseudo eye-tracking + time-on-tile.** Two research signals: (1)
  **viewport-tracking heatmap** — log how closely/where the user zooms over each region as a proxy for
  attention (pseudo eye-tracking from pan/zoom state). (2) **Time tracking** — log time spent annotating
  per tile via tool-use events; any gap between tool uses longer than an **admin-configurable inactivity
  threshold** counts as idle and is excluded. Needs an events/telemetry table + analysis. Logged 2026-06-30.
  **↳ Signal (1) recording is BUILT** (2026-07-03, branch `feat/viewport-telemetry`, pending merge): a
  `viewport_event` table + endpoint + fail-quiet FE sampling of the `vb` ViewBox (x/y/w/h) with css px size
  + devicePixelRatio, settle-debounced + 2s heartbeat. The **admin heatmap UI** (product of two vars w/
  min/max) and **signal (2) time-on-tile** are still open; browser-zoom remediation is captured via `dpr`.

- **Admin viewport-attention heatmap + replay (consumes `viewport_event`).** Christian's intent (2026-07-03):
  see *where people spent the most time looking the closest* — two variables (dwell time × zoom-closeness)
  that are awkward to multiply into one number. **Clean unification (recommended):** treat each sample as
  depositing color at a **constant rate per unit time, spread uniformly over the viewport's image-space
  area** — i.e. for a sample covering duration Δt over viewport rect area `A` (image coords), add
  `k·Δt / A` to every image cell inside that rect; sum over all samples (and users), then normalize for
  display. The two variables then combine *naturally* instead of via an arbitrary product: longer dwell →
  more total color; tighter zoom (smaller `A`) → same color rate concentrated into fewer cells → higher
  intensity. So "stared long, zoomed tight" lights up brightest, exactly the target signal. Δt per sample =
  gap to the next sample for that user/image (the settle+heartbeat cadence already bounds it; cap idle gaps,
  cf. the time-on-tile inactivity threshold). Rendered as an overlay that **replaces the background image**
  in the admin panel (min/max per variable → color range).
  **Companion — viewport replay:** replay a user's session by animating a little viewport rectangle over the
  image (independent of the admin's own pan/zoom), **tweening** between recorded samples to smooth the gaps.
  Same data, a temporal view instead of an accumulated one. Depends on the telemetry branch merging + real
  data accruing; UI lives in the admin panel; scale later to per-tile aggregation. Logged 2026-07-03.

- **Stream viewport telemetry instead of periodic batch POSTs (with reconnect).** The shipped
  `viewportTelemetry.ts` already **batches** (buffers, POSTs every 5s / on image-change / on unload) — it is
  NOT one request per event — so this is an optimization, not a correctness fix. A persistent stream
  (WebSocket, or a long-lived streaming upload) would cut per-batch request overhead and lower delivery
  latency, but needs (a) server-side streaming support — Flask isn't natively WebSocket, so `flask-sock`/ASGI
  or an SSE-style control channel + a POST sink — and (b) client **reconnect/backoff with buffer-on-disconnect**
  so samples survive drops. Only worth it if batch-POST volume becomes a problem at real lab scale. Logged 2026-07-03.

- ✅ **DONE (`f6cb6eb`).** Brush eraser (delete strokes on touch) — an invisible brush that soft-deletes
  any stroke it drags over (server-side Shapely intersection + the existing `erase` undo action; one
  Ctrl+Z restores a whole drag). Area-subtract ("erase half a stroke") remains explicitly out of scope.

- **Active guided-testing harness (not just an instruction list).** Christian's vision (2026-07-02) is
  more than "here's a checklist" — the system should hand the tester an ordered script AND **actively
  verify they did each step**: watch the SPA state (current route, which buttons were clicked, DOM/
  annotation changes) and confirm the tester is where they should be, clicking what they should, before
  advancing — asking the right question at the right time when a step's outcome is subjective. Most of it
  is automatable (route + click + DOM assertions, like a Playwright script but driven by a real human);
  the human is only needed for "does this look right" judgments. Start as a simple web app. Possibly a
  good Sonnet job once designed. (Supersedes the thinner note that only described an instruction list.)

- **"Forgot password" link on the login page → admin queue.** Add a link at the bottom of `LoginScreen`
  that files a notification into the admin's queue (admin then issues a fresh invite link — the existing
  recovery path). Needs an admin notification/queue surface (none yet). Pairs with the self-service
  Settings work (username/password self-change). Logged 2026-07-02.

- **A better test-feedback loop than a markdown file.** Right now testing feedback goes in
  `docs/TESTING.md` by hand. Something more structured would be nicer — a lightweight in-app "report
  an issue" widget that files against the current batch/tile/annotation, or a real issue tracker, so
  feedback carries context (screenshot, what was selected, the annotation id) automatically instead of
  prose. Logged 2026-06-30.

- **[HIGH PRIORITY, low urgency] Guarantee a subagent scope file (make guard.py fail-closed) + per-agent scopes.** `guard.py`'s
  Rule B (confine a subagent's writes to `write_allow`, deny denylisted reads) only fires **when
  `.claude/agent_scope.json` exists** — so if the dispatcher forgets to write one, the subagent runs
  totally unscoped (this is why the fix-agents this session could write anywhere). Two upgrades: (1)
  **fail-closed** — when the payload has an `agent_id` but no scope file, DENY all subagent Edit/Write
  (force the dispatcher to declare a scope) instead of silently allowing; (2) **per-agent scopes** — a
  single global `agent_scope.json` can't describe N parallel agents in N worktrees, so key it by
  `agent_id` (`agent_scope.<id>.json`) with the worktree as `repo_root`. Needs care that Opus's own
  (agent_id-less) calls stay unrestricted. Christian: "our subagent setup is a mess; we need something
  that guarantees a scope file." Logged 2026-07-02.

- **Enforce single-writer backups with a lease, not honor-code.** The concurrent-backup guard we're
  shipping is `BACKUP_PRIMARY` — a static env flag only the prod host sets. That's honor-code: two people
  running `--profile backup` at the same `BACKUP_DIR` = two litestream writers = corruption, and nothing
  *detects* it. Upgrade: a **heartbeat lease file** in `BACKUP_DIR` (host+pid+mtime, refreshed ~30s); a
  second backup start sees a fresh lease and refuses. Actively blocks the common mistake instead of
  trusting coordination. Caveats: `BACKUP_DIR` is on NFS so advisory locking is out (a lease file is a
  data check, not a lock), clock skew + a simultaneous-cold-start race remain — so "reliably stops the
  realistic error," not bulletproof. Lower urgency because the Docker-testenv redesign makes members run
  app-only against their own volume (they never back up), so accidental double-backup is already unlikely.
  Christian chose honor-code for now (2026-07-02). Logged 2026-07-02.

- **css-hygiene lint should strip comments before scanning.** `e2e/unit/css-hygiene.spec.ts`'s "no raw
  hex / rgb() in .css.ts" test regexes the WHOLE file (`/#[0-9a-fA-F]{3,8}\b|\brgba?\(/`), so a COMMENT
  containing `rgb()` or a `#28b`-style token (looks like a 3-digit hex colour) trips it even with zero real
  raw colours (hit twice 2026-07-04 by comments like "// no raw hex/rgb()." and "// BUG #28b:"). Strip `//`
  and `/* */` comments (and ideally only scan style-value positions) before the regex. Low urgency, but it
  wastes agent/gate cycles on false positives. Logged 2026-07-04.

- **Compound-label generalizations (domain-dependent — configure carefully for now).** Beyond the initial
  mutually-exclusive-groups model: (a) HIERARCHY *within* an intra-exclusive group (types can be hierarchical);
  (b) some GROUPS mutually exclusive with each other (not just members within a group); (c) only certain types
  carry special ATTRIBUTES. Christian: hold until the domain is clearer; not every domain this app supports looks
  like leaf-disease. Logged 2026-07-04.
- **Share compound labels across annotators (not just across images).** The saved-compound-label store is
  per-annotator-shared-across-images initially; add cross-annotator sharing later ("pretty easily"). Logged 2026-07-04.
- **Tiling page should take MASKS as input, not the luminance hack.** Today tiling derives the leaf region via a
  luminance threshold + largest-connected-component heuristic baked into this app. Instead the tiling page should
  REQUIRE a segmentation mask as input, and the luminance→mask logic should be **completely decoupled** from this
  app (it's a separate concern / external tool, not part of the annotation tool). Logged 2026-07-04.
- **LabelMe export for projects.** Export a project's annotations to LabelMe format. Ties to compound-label
  serialization (export to strings — base64 the serialized value if needed). Logged 2026-07-04.
- **Dedicated production branch (deploy prod from it, not `main`).** Christian (2026-07-04): with the new
  "test from a branch, don't merge-to-test" workflow, `main` is effectively the integration/test line. Add a
  `production` (or `release`) branch that prod actually deploys from, so merging to `main` no longer implies
  "this is live." Prod redeploys track that branch; `main` stays the staging tip. Logged 2026-07-04.
- **Structured BE error/request logging + log backup (with version/sha).** Christian (2026-07-04): today the
  backend logs nothing durable — malformed requests return a `400` JSON but are unrecorded, and uncaught
  exceptions only hit container stdout (ephemeral). Add real logging: capture 4xx/5xx + tracebacks to a
  persistent log (a file in a volume), **stamp every line with the build version/sha** (so we can tie a bug to
  a deploy), and **back the logs up** alongside the DB (litestream/lsyncd sidecars). Goal = catch bugs we don't
  know about. Companion to the harness token/tool-usage audit work. Logged 2026-07-04.
- **Coverage gate step (FE + BE), no threshold yet.** Christian (2026-07-04): add a coverage-measurement stage
  to `scripts/gate.py` for BOTH backends (wrap the standalone test scripts in `coverage run`) and frontend
  (vitest/c8 or Playwright coverage) — **report the percentage but do NOT fail the gate** (no minimum for now).
  A minimum threshold comes later; right now the priority is fixing known bugs, collecting all the data we need,
  and the minimum features to support annotation. Logged 2026-07-04.
- **Let the test env RUN the backup sidecars (not just restore).** Christian (2026-07-04): today `start test
  --data-mode restore` can *consume* a backup (reads `BACKUP_DIR`), but `--with-backup` (litestream/lsyncd
  sidecars) is prod-only — so there's no way to exercise the backup *machinery* in test. Allow `--with-backup`
  on `start test`, pointed at a **throwaway/non-prod backup dir** (never prod's), so the whole backup path can
  be validated before it ships to prod. Logged 2026-07-04.
