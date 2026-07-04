#!/usr/bin/env bash
# Snapshot the LIVE prod Docker volume into a local, READABLE test data dir owned by YOU,
# sidestepping the root-owned host backup (litestream/lsyncd write it as root, so an
# unprivileged `testenv.sh --seed restore` can't read it — see the ownership note in the
# session notes). `docker cp` writes to the host as the invoking user, so the copy is
# readable. Reads prod read-only (consistent DB via sqlite .backup INSIDE the container);
# NEVER writes to prod.
#
# Tomorrow's flow:
#   bash scripts/snapshot_prod.sh          # readable prod copy -> ~/.local/share/leaf-annotation-test
#   bash scripts/testenv.sh --keep         # serve that copy on :5001 (no re-restore)
#   uv run python3 scripts/migrate_stroke_width.py --db ~/.local/share/leaf-annotation-test/app.db
#   uv run python3 scripts/migrate_stroke_width.py --db ~/.local/share/leaf-annotation-test/app.db --apply
set -euo pipefail

CT="${PROD_CONTAINER:-leaf-annotation-tool-app-1}"
DEST="${TEST_DATA_DIR:-$HOME/.local/share/leaf-annotation-test}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

echo "[snapshot] prod container: $CT  ->  $DEST"
rm -rf "$DEST"; mkdir -p "$DEST"

# Consistent DB snapshot inside the container (app.db is root:600; docker exec runs as root).
docker exec "$CT" python3 -c "
import sqlite3
s = sqlite3.connect('/data/app.db'); d = sqlite3.connect('/data/app.db.snap-$TS')
with d: s.backup(d)
d.close(); s.close()
"
docker cp "$CT:/data/app.db.snap-$TS" "$DEST/app.db"      # docker cp -> host, owned by YOU (readable)
docker exec "$CT" rm -f "/data/app.db.snap-$TS"

# Content dirs (content-addressed / append-only) — copy wholesale.
for d in images jsons i18n; do
  if docker exec "$CT" sh -c "[ -d /data/$d ]" 2>/dev/null; then
    docker cp "$CT:/data/$d/." "$DEST/$d/" 2>/dev/null || { mkdir -p "$DEST/$d"; docker cp "$CT:/data/$d/." "$DEST/$d/"; }
  fi
done
docker exec "$CT" sh -c '[ -f /data/manifest.json ]' 2>/dev/null && docker cp "$CT:/data/manifest.json" "$DEST/manifest.json" || true

echo "[snapshot] done — readable copy at $DEST"
ls -la "$DEST" | head
echo "[snapshot] next: bash scripts/testenv.sh --keep"
