# BUGS / feedback backlog

Captured 2026-06-29. Bugs + UX feedback for upcoming annotator passes. Several are regressions/gaps in
recently-shipped work (commits `4034a32`, `a3c9a01`). Pairs with `Plan — Annotator next passes.md`.

> **STATUS 2026-06-29 — original six items + Tier-0 de-flake DONE.** Commits: `f4795f4` (#5),
> `3668fd2` (#1–#4 + I4 de-flake), `4e99f66` (#6). Gate all green (9/9 backend, 261 Playwright).
> **UPDATE 2026-06-30 — round-1 #7–#9 FIXED** (`837dacb`). **Round-2 testing + #10 FIXED** (`315eda0`):
> committed strokes now render as fused union polygons (fixes #10 self-intersection fill + opacity
> stacking + adds outline), tile-intersection tests the buffered AREA (fixes the false "must intersect a
> tile" 422), space-pan on getScreenCTM, multiplicative brush resize, ~0.35 opacity, ✓ on completed
> tiles. Gate green (10/10, 292). **NEW open items below: labmate bugs #11–#14 (auth/tiling/batch/404)
> + an old-data→stroke migration — being worked next.**

## Annotator canvas
1. **Brush AND delete-lesion still reset the zoom.** The `a3c9a01` fix (key auto-fit to image identity)
   did NOT fully solve it — committing a brush stroke and deleting a lesion still snap back to default
   zoom. Another path re-fits/resets `vb` on annotation mutation. Investigate the commit/delete flow in
   `CanvasScreen.tsx` / `canvasInteraction.ts` — likely the annotations resource refetching after a
   commit re-triggers a fit, or `setVb`/`fitImage` is called on the wrong signal.
2. **Invisible boundary crops the image.** In annotation mode an inner boundary crops the image; only the
   toolbar + screen edges should bound it. Likely a leftover stage max-width / SVG `viewBox` clip /
   `overflow` from before the full-width change (related to `a3c9a01`).
3. **"Open as" makes no sense — annotate as YOURSELF.** The canvas takes an `annotator` param; default it
   to the logged-in user and drop the "open as" chooser.
4. **Tile "mark complete" button is a dead no-op + wrong position.** Each tile has a complete button, but
   clicking does nothing (the `set_tile_state` wiring isn't connected in the UI). Backend
   (`annotator_tile.state='completed'` + `set_tile_state`) already exists — this is UI wiring only.
   *(2026-06-29: position is now acceptable per Christian — scope reduced to wiring the click.)*

## Round-1 hands-on testing feedback (Christian, 2026-06-30)

First real use of the Tier-1 canvas. Positives: the invisible border is **gone** and the brush
**looks way better**. Bugs found (ranked; most are likely ONE root cause):

7. **Pointer↔image coordinate mapping is wrong on the Y axis** (HIGH — blocks usable annotation).
   Symptoms: the **brush stroke isn't centered on the cursor**, error is **Y-only**, **zero at the
   vertical center and grows toward top/bottom**; **panning has the same Y error**. Classic
   `preserveAspectRatio="xMidYMid meet"` letterboxing bug: the SVG element's aspect ratio ≠ the
   `viewBox` aspect ratio, so the image is letterboxed (bars top/bottom) and centered — but `toImage()`
   in `canvasInteraction.ts` maps client→image with a naive `((clientY-rect.top)/rect.height)*v.h`,
   ignoring the meet scale+offset. **Robust fix:** map points through the SVG's own CTM —
   `pt.matrixTransform(svg.getScreenCTM().inverse())` — instead of the hand-rolled rect math; do the
   same for `panBy` and the pinch math (difference two CTM-mapped points for deltas). This one fix
   should resolve brush-centering AND pan-Y, and may also fix #10 (warped points → loops don't close).
8. **Vertical scroll-pan is inverted.** Scroll down should pan the view down. `onWheel`'s
   `panBy(0, e.deltaY)` moves `v.y` the wrong way for the wheel convention (drag-pan's "grab" sign is
   correct and should stay). Flip the sign for the **wheel** path only.
9. **No brush preview circle.** When the brush tool is selected, show a cursor-following circle sized to
   the current brush size (in image space) so the user sees where/how big the stroke lands. (Depends on
   #7's correct cursor mapping.)
10. ✅ **FIXED (`b477048`).** Self-intersecting loop rendered as a 2D donut. Round-2 (`315eda0`) didn't
    resolve it (still a hole). Real fix: lesion `rings` are now **exterior-only** (`_poly_rings` drops
    interiors → no holes ever), and lesion geometry is the union of the FE's **perfect-freehand outline**
    (`outline_json`, `ShapelyPolygon(outline).buffer(0)`) instead of the centerline buffer, so rendered
    shape == geometry. Raw mouse path kept in `points_json`. Tests L10–L13. **Awaiting Christian's
    re-test of the loop fill.**

> These are the next implementation pass (a focused "canvas coordinate correctness + brush preview"
> task). #7 is the keystone — fix and re-test before touching #10. Raw notes also in
> `docs/TESTING.md` feedback.

## Labmate-surfaced (2026-06-30, round-2 testing)

11. ✅ **FIXED (`956e391`), hardened (`40151e6`).** Invite links bounced to /login. Root cause (found
    via Christian's HAR): the **legacy `webapp/static/app.js`** (loaded on every page) installs a global
    401 fetch interceptor that hard-redirects to /login AND eagerly fetches the protected legacy
    `/api/images`. On the logged-out `/invite` page that autoload **401s → `window.location='/login'`**,
    killing the SPA invite flow. Regressed when `/api/images` became auth-gated (`4034a32`). First fix
    (`956e391`) blacklisted public SPA routes. **Hardened (`40151e6`): inverted to a legacy-route
    *whitelist*** — app.js now does nothing on any non-`/train`/`/merge` route (interceptor + init +
    autoload all gated behind `_isLegacyRoute()`/`__bootLegacy()`). Legacy is now quarantined to the two
    vanilla routes as Christian asked. +regression test (`__bootLegacy` exists but no autoload on /login).
12. ✅ **FIXED (`df80424`).** Tiling save button now uses the accent token (distinct from background) +
    dirty-state guarded by `useBeforeLeave`/`beforeunload`.
13. ✅ **FIXED (`df80424`).** Batch size label now "Tiles per batch".
14. ✅ **FIXED (`df80424`).** Deleted/missing project showed "loading" forever → by-id project screens
    now wrap an `ErrorBoundary` → `ProjectNotFound` (loading vs errored resource separated).
- **Old-data → stroke migration (prod data, NOW ACTIONABLE).** Prod has **no** old polygon/line/point
  data — all annotations are already `kind='stroke'`, just drawn with the old placeholder brush (prod
  runs `a3c9a01`, pre-Phase-1) so they lack `stroke_width`. Christian (2026-06-30 PM): simulate the old
  strokes as **brushes of low/default width** — which is exactly what the server-side centerline-buffer
  fallback does when `outline_json` is absent, so the fix is just to **backfill `stroke_width` = the
  default brush size** for the old rows (no perfect-freehand outline needed; the fallback renders the
  path at that width). **Distinguishing old from new:** the labmate kept practicing via the still-extant
  "annotate as" feature, so her recent *new* annotations are under **her own account** too — filter by
  **`created_at < 2026-06-30 14:39 CDT`** to hit only the old ones (don't touch newer rows). Migration =
  a one-off `UPDATE annotation SET stroke_width=<default> WHERE created_at < <cutoff> AND stroke_width
  IS NULL`. Still gated on: **deploy current code to prod first** (prod is `a3c9a01`) + **prod DB
  backup**. Confirm the exact default brush size and the cutoff in UTC before running.

## Round-3 hands-on testing feedback (Christian, 2026-06-30 PM)

Invites confirmed working; the annotator is "a million times better." Near-term items (lab is actively
annotating, so these affect them).

> **STATUS 2026-06-30 PM — #16/#17/#19/#20/#21 FIXED** (`d05d0d0` backend tile-reopen; `eefa9e5` FE
> batch). **#18 was already done** (`3668fd2`, verified). Gate green (11/11 backend, 313 Playwright).
> **#15 admin viewer FIXED** (`151bbe3`, merged `a75816a` — built in parallel with the eraser via
> worktrees). **Still open: #22 (tile nav — design/Tier-2), #23 (per-batch progress — Tier-2), #24 (upload
> polish — needs a resume/dedup decision first).**

15. ✅ **FIXED (`151bbe3`, merged `a75816a`).** Admin canvas is now read-only with a top annotator-picker
    dropdown (roster; default = first annotator with work on the image); tools hidden for admin, tile state
    visible but not togglable. FE-only (read paths already blind per-annotator). Original ask:
    **Admin view should be read-only + an annotator switcher (HIGH, design).** Christian discovered the
    "mark complete" checkbox does nothing *because he was logged in as admin* — admin is blocked from
    completing tiles **yet can still add annotations**, which is backwards. Rethink the admin canvas
    experience: **view-only** (no painting, no complete toggle), with a control to **switch which
    annotator's copy you're viewing**. Supersedes/absorbs BUGS #3 ("annotate as yourself") for the admin
    case. Needs a small design pass before building.
16. **Editing a completed tile in any way should mark it incomplete.** Any mutation (add/delete/merge a
    stroke) inside a tile whose `annotator_tile.state='completed'` should flip it back to incomplete.
    Backend wiring on the mutate/create/delete paths.
17. **Remove the stroke selection + delete button feature entirely.** The click-to-select-a-stroke +
    delete-button UI is going away (the eraser/merge model replaces it). Remove the UI + any wiring; keep
    lesion-level delete only as already specced.
18. **Drop the "as &lt;annotator&gt;" chooser from the annotator page.** The user can already see who
    they're logged in as — annotate as yourself, no chooser. (The admin case is #15; this is the normal
    annotator page.) Pairs with the long-standing BUGS #3.
19. **Undo (Ctrl+Z) can make a stroke vanish when it merged with a since-deleted lesion.** Christian
    watched a stroke that had merged with another, then was deleted, disappear on undo. Likely the
    undo/redo stack restores into a lesion grouping that no longer exists, or restore-then-regroup drops
    it. Repro + fix the undo/merge/delete interaction.
20. **Annotations render slightly before the image (load desync).** The SVG overlay paints before the
    `<image>` finishes loading, so lesions briefly float over a blank/late image. Gate the overlay on the
    image `load` event (or fade both in together).
21. **Rename "trainer" → "annotation tool" everywhere; clicking the app name navigates home.** User-facing
    copy/nav rename (the legacy /train tool keeps its internal name for now). The app-name/logo in the
    header should be a link to `/`.
22. **Tiles should guide the eye — jump to a tile and let the user navigate between them.** When marking a
    tile complete (and generally), the viewport should jump/center on the relevant tile, with
    prev/next-tile navigation. Tier-2-adjacent but lab-relevant; design with #15 and the progress redesign.
23. **Progress stats (bottom of the projects page) should aggregate across all OPEN batches.** Multiple
    batches can be ongoing at once, so a single global bar is wrong — the stats should sum over every
    *open* batch. Christian calls this "a big win." **BLOCKED on defining the batch state machine** (what
    "open" means) — that's the Tier-2 design gate. Folds into the Tier-2b progress redesign in
    `docs/plans/Plan — Annotator next passes.md`.
24. ✅ **Part A DONE (`7dede02`).** Upload drop-zone now shows a scrollable, capped list of selected
    filenames (`SelectedFilesList`, cap 100 + "+N more") instead of a bare count.
    **Part B answered (investigation, no change):** there is **no resume** — no chunked/resumable protocol;
    a refresh mid-upload loses progress (state is in-memory). Client sends **one POST per file, ≤4
    concurrent** (mirrors the backend `_upload_sema`); NDJSON per-file progress; **no per-file retry**.
    **Dedup is necessarily post-upload**: the server reads full bytes → SHA-256 of content (not filename)
    → checks `project_image` **per-project** → skips dupes; per-file commit means re-submitting the whole
    selection after a crash is cheap (dupes skip). **Future options (Christian to decide):** (a) a
    client-side pre-flight hash probe ("do you have this hash?") to skip re-sending bytes; (b) a real
    resumable/retry protocol. Neither exists today.

## Project membership — revise recently-shipped `4034a32`
5. ✅ **DONE (commit `f4795f4`).** Don't auto-add admin to the annotator roster. Excluded admin from
   the `create_project` auto-add **and** the backfill migration; normal creators still auto-add.
   Backend roster-count assertions adjusted (3→2). Admin still sees everything via the bypass.

## Upload progress — refine recently-shipped parallel uploads
6. **Upload progress indicator is off — full send (per Christian 2026-06-29).** (a) Client-side, count
   **bytes** uploaded (switch per-file POST to XHR for `upload.onprogress`), aggregated across the 4
   concurrent workers, driving a real progress **bar**. (b) The text label should count **completed**
   uploads ("N of M done"), not the in-progress one. → `docs/Task — Upload progress (BUGS 6).md`.

## Answered
- **"What happened to the progress bar in lesion-spotting mode?"** Not built yet — it's the Tier-2b
  progress redesign (tiles-completed + lesions-spotted) in `Plan — Annotator next passes.md`. Deferred,
  not dropped.

## Opus notes
- **(5) Agreed.** Skip admin in auto-add + backfill; admin's view access comes from the bypass, so the
  roster stays clean and "real annotators only." Small change to `create_project` + the backfill migration
  + tests.
- **(1)** is the priority — it's a recurring regression making the annotator hard to use; the identity-key
  fix was necessary but insufficient, so the real culprit is the post-commit refetch path.

## Eraser semantics — DECISION NEEDED (Christian, 2026-07-01)
The shipped eraser (`f6cb6eb`, `POST /annotations/erase-stroke`) is a **brush-sweep that deletes each
individual stroke whose footprint the eraser touches** — its docstring: *"erasing over part of a fused
lesion removes only the member strokes the eraser actually touched, so the lesion re-forms from the
survivors."* This can therefore **split a lesion** (remove a bridging stroke → survivors re-form as two).

**Christian's stated intent (2026-07-01):** erase should delete the **entire connected component / whole
lesion**, not individual strokes ("click a stroke → the whole lesion it belongs to is removed" — which is
also what `TESTING.md` line 50 promises). Under that model erase never splits.

→ **DECIDED (Christian, 2026-07-01): whole-object erasure**, and — bigger — the whole model becomes
persisted **fused-mask annotations** (strokes = bridged record-keeping). The quick eraser patch is
superseded by [`docs/plans/Plan — Annotation-stroke model (fused masks).md`] (+ Alembic adoption + rebaked
data migration). Under that model erase deletes the whole annotation and splits are impossible by
construction. Do NOT ship the interim per-stroke→component patch; do it right via the refactor.

## Round-4 hands-on testing feedback (Christian, 2026-07-03)

> Positives confirmed: **Escape → deselect/pan works** ✓; **editing a completed tile reopens it** (#16) ✓;
> admin canvas read-only landed (`3cd7358`, GLM-in-jail).

25. **Self-service Settings: gap between the input fields and the Confirm button.** Layout/CSS on the user
    settings page — an unexpected vertical gap above the confirm button.
26. **Pre-flight dedup is PER-PROJECT → re-uploads bytes across projects.** The check is
    `WHERE project_id=? AND image_hash IN(...)`, so an image already stored (content-addressed globally)
    but not in THIS project re-transfers over the network. Extend pre-flight to consult the global content
    store so a cross-project upload skips the byte transfer and just writes the `project_image` row.
    (Advances #24's future-option-(a) from per-project to global.) — DECISION: is global cross-project
    reference desired? (privacy: images become visible-by-reference across projects.)
27. **Perfect-freehand raw points still sent FE→BE; a tiny brush click → a (right) triangle.** A near-point
    stroke round-trips into a right-triangle artifact — FE still ships raw perfect-freehand points and the
    BE geometry mangles the degenerate case. Ties to the fused-mask model + the recompute/round-trip
    fidelity backlog. Repro: single click, smallest brush size.
28. **Admin annotator-picker polish:** (a) relabel **"viewing" → "viewing as"**; (b) the select's caret
    overlaps the selected annotator name — pad the control so the arrow doesn't sit on the text. (polish on #15.)
29. **Image/SVG load still slightly desynced — RE-CONFIRMS #20.** Overlay paints before `<image>` finishes;
    "the top of the image loads at the same time." The decode-gate fix (`6128af5`) reduced but didn't
    eliminate it. Revisit paint ordering / decode gate.
30. **Controls UX: replace the bottom tooltip bar with a "show controls" popup.** Instead of covering the
    page bottom with tooltips, a small "click here to see controls" affordance opening a closable, more
    vertical popup with the same content. UX proposal.

## Test flakiness (2026-07-09)
31. **Freehand-paint Playwright tests flake under load.** A jailed Sonnet running the full gate 3× saw
    `370/371` each time but a *different* single test failing each run — always in the mouse-drag-
    freehand-paint family (`relabel.spec.ts`'s paint/relabel, `relabel-undo.spec.ts`'s undo/redo). Did
    NOT reproduce on the host (clean `371/0`), so it's simulated-pointer-event timing under a loaded
    box, not a product regression. Revisit: stabilize the paint gesture in these specs (settle/wait on
    the committed stroke rather than a fixed drag), or add a retry only for the paint-gesture step.
    Surfaced during the shared-canvas-viewer refactor (`b904fa5`); merge-mode's own spec was stable.
