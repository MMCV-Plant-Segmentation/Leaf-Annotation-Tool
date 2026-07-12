# Sonnet worklog

## 2026-07-12 — Merge Phase 2b: completeness + explicit submission (backend)

Spec: `webapp/tests/test_merge_submit.py` (TDD; not edited).

Changes:
- `alembic/versions/0008_merge_submission.py` — new migration (down_revision =
  `0007_stroke_tool`). Creates `merge_submission(batch_id, merger, submitted_at)`
  with `PRIMARY KEY (batch_id, merger)` so a re-submit is an UPSERT (never a
  500) and completeness/submission stay per-merger. FK to `batch(id)` with
  `ON DELETE CASCADE`. `auto_create_schema()` picks it up on boot / test start.
- `webapp/projects.py` — Phase 2b section added between the erasures section
  and `_visible_annotations`:
  - Helper `_pooled_annotation_ids_for_batch(con, batch_id)` — rolls up the
    same pooled-marks scoping as `_pooled_annotations` /
    `_pooled_annotation_ids_for_image` across every image in the batch.
  - Helper `_merger_accounted_ids(con, batch_id, merger, pooled)` — distinct
    pooled marks in (that merger's LIVE COs via co_membership) ∪ (that
    merger's co_erasure), intersected with `pooled`.
  - `GET  /api/batches/<id>/merge-completeness?merger=<un>` — 200
    `{total, accounted, complete, submitted, submittedAt}`; member-gated.
  - `POST /api/batches/<id>/submit-merge` — session user is the merger; 409
    when not complete, else UPSERT + 200 `{ok, submittedAt}` (idempotent —
    `ON CONFLICT (batch_id, merger) DO UPDATE`).
  - `DELETE /api/batches/<id>/submit-merge` — session user; 204, drop that
    merger's row.
  - Every route calls `_member_or_403` on the batch's project, so mallory
    (not a project annotator) 403s on both GET and POST as SUB8 requires.

Assumptions / risks:
- Task doc named the migration path `webapp/alembic/versions/...` but the
  repo's alembic tree lives at repo-root `alembic/versions/` (that's what
  `webapp/db.py` points at via `BASE / 'alembic'`, `BASE = repo root`). Wrote
  the migration at the repo-root path after Opus widened the scope.
- Erasures on marks that later drop out of the pool are intentionally not
  counted toward `accounted` — the `& pooled` clamp keeps completeness
  self-consistent. Test only exercises stable pooled marks, so this is
  belt-and-braces.
- No frontend changes — this task is backend-only per the brief.
