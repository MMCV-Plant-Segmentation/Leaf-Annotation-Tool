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
