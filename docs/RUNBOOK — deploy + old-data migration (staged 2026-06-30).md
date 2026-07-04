# RUNBOOK — deploy current code + old-data stroke_width migration (STAGED — do not run unattended)

Prepared 2026-06-30 PM while Christian was away. **Prep only — nothing here has been run against prod.**
Run the deploy first, then the migration, with Christian present.

## CORRECTION to earlier belief: prod is NOT on `a3c9a01`
Verified by inspecting the running container `leaf-annotation-tool-app-1` (image `leaf-annotation:latest`,
started **2026-06-30 19:19 UTC**). Code markers present inside the container:
`--port` argparse (`59b9621`) ✅, `outline_json` (`b477048`) ✅, `annotations/mutate` (`850849a`) ✅,
`_isLegacyRoute` quarantine (`40151e6`) ❌. **So prod is running ~`b477048`** — it was redeployed today.
The lab already has the self-intersection fix, the brush/coordinate fixes, the invite fix, etc.

**Undeployed delta (as of 2026-06-30 PM):** `40151e6` (legacy quarantine), `d05d0d0` (tile-reopen #16),
`eefa9e5` (round-3 FE #17/#19/#20/#21), `5927b9a` (app-factory/entrypoint consolidation), `3477c09`
(viewport readout), `f6cb6eb` (brush eraser), `151bbe3`+`a75816a` (admin read-only viewer #15). All
backend/FE, gate-green (merged tree: 12/12 backend, 327 Playwright). NOTE: `5927b9a` changes how the app boots (create_app + AppConfig) and `wsgi.py`, so after
deploy, smoke-test that Granian still imports `webapp.wsgi:app` cleanly and the admin/secret env still
resolve (SECRET_KEY is now required). The Docker `restore` service path (`litestream restore` + file copy)
should be unaffected — restore.py mirrors it.

## Prod facts
- Compose project `leaf-annotation-tool`, config at
  `/home/crf37f/Desktop/annotation-tool-deployment/Leaf-Annotation-Tool/compose.yaml`
  (a **separate deployment checkout** from the dev repo at `/deltos/e/leaf-annotation-tool/code`).
- DB: named volume `leaf-annotation-tool_leaf-data` → mounted `/data`; DB at `/data/app.db`
  (Litestream sidecar replicates it; `.app.db-litestream/` present). **NOT under your home dir.**
- A backup tree also exists at `/deltos/e/leaf-annotation-tool/backup/{db,files}`.

## RESOLVED: deploy pulls from GitHub `origin`
Christian confirmed (2026-06-30) the deployment checkout pulls from **GitHub `origin`**. So a deploy
requires **`git push origin main` from the dev repo FIRST** (origin is intentionally behind local).
**Still gated on Christian saying "deploy now" and being present** — do not push/deploy unattended.

## STEP 1 — Back up prod DB (always, before anything)
```sh
CT=leaf-annotation-tool-app-1
TS=$(date -u +%Y%m%dT%H%M%SZ)
# Consistent online backup via sqlite .backup (safe while the app runs):
docker exec "$CT" sh -c "sqlite3 /data/app.db \".backup /data/app.db.bak-$TS\""
# Copy it out of the volume to the host backup tree:
docker cp "$CT:/data/app.db.bak-$TS" /deltos/e/leaf-annotation-tool/backup/db/app.db.bak-$TS
ls -la /deltos/e/leaf-annotation-tool/backup/db/
```

## STEP 2 — Deploy (after the OPEN QUESTION is answered)
```sh
# FIRST, from the dev repo, push (origin is behind; deployment pulls from origin).
# NOTE: the sandbox has no SSH key, so Claude cannot push — a human runs this line:
cd /deltos/e/leaf-annotation-tool/code && git push origin main
# Then on the deployment checkout:
DEP=/home/crf37f/Desktop/annotation-tool-deployment/Leaf-Annotation-Tool
cd "$DEP"
git fetch origin && git rev-parse --short origin/main   # confirm it matches the pushed sha
git pull --ff-only origin main
# BUILD via buildx bake — NOT `compose up --build`. The `app` service has no build: key;
# the image is a bake target that pulls a `frontend-build` context (Dockerfile.frontend) to
# produce the JS bundle in-image. `compose --build` fails ("frontend-build not found").
# GIT_SHA/BUILD_TIME bake the version identity (webapp/version.py; absent → "unknown"/"dev"):
GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) docker buildx bake app
# Recreate the container against the new :latest image (leaf-data volume persists → in-place migrate):
docker compose up -d
# Verify the baked version is live:
docker exec leaf-annotation-tool-app-1 sh -c 'echo "GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME"'
```
Smoke-check after: `curl -s localhost:${PORT:-5000}/` returns the "Annotation Tool" page (HTTP 200);
load `/invite/<a-real-token>` logged-out (stays on invite), `/train` still works, the annotator opens.

## STEP 3 — Old-data migration (now AUTOMATIC on boot via Alembic)
There is **no manual migration step anymore.** When the new image boots in STEP 2,
`auto_create_schema()` runs Alembic: an existing (pre-Alembic) prod DB is **stamped** at
`0001_baseline` (data-preserving, no rebuild), then **upgraded to `0002_annotation_stroke_model`**,
which renames the old per-stroke `annotation` table → `stroke`, builds the new fused-mask `annotation`
objects for **all** existing data, and defaults Burcu's `stroke_width IS NULL` rows to 4.0 for footprint
geometry (so her old strokes render as thin masks). `scripts/migrate_stroke_width.py` is **retired**.

**This makes STEP 1's backup non-negotiable.** The upgrade is a whole-schema+data transform; it fails
loudly and won't serve a half-migrated DB, but a fresh pre-deploy backup is the real safety net. It was
validated end-to-end against a prod snapshot in testenv (316 strokes → 298 masks, 0 orphans, idempotent,
downgrade tested) — do the same testenv boot (`docs/TESTING.md`) BEFORE touching prod.

Verify the migration ran (after STEP 2's `docker compose up`):
```sh
CT=leaf-annotation-tool-app-1
docker exec "$CT" python3 -c "import sqlite3;c=sqlite3.connect('/data/app.db');print('alembic:',c.execute('SELECT version_num FROM alembic_version').fetchone());print('annotations:',c.execute('SELECT COUNT(*) FROM annotation').fetchone());print('strokes:',c.execute('SELECT COUNT(*) FROM stroke').fetchone())"
# expect: alembic ('0002_annotation_stroke_model',) and BOTH annotation + stroke tables populated
```

## STEP 4 — Verify + rollback
- Verify: open one of Burcu's old tiles in the annotator; the old strokes should now render as thin
  filled masks instead of hairlines, and touching same-label strokes appear fused.
- Rollback (DB): stop app, restore `app.db.bak-$TS` over `/data/app.db`, restart. Because `0002` is a
  whole-schema change (annotation→stroke split), **backup restore is the ONLY safe undo** — there is no
  simple SQL reversal. (An Alembic `downgrade 0001_baseline` exists and was smoke-tested, but restoring
  the pre-deploy backup is safer and preserves exact per-row `deleted_at` timestamps the downgrade can't.)
- Rollback (code): `git checkout <prev-sha> && docker compose up -d --build` in the deployment checkout.
