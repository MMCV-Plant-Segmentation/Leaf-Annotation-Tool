# RUNBOOK — group-owned deployment (run the stack as you + a shared group)

**Goal:** the stack runs as the **invoking user + a shared group** so the DB and backups are written
**group-owned + group-writable**, not root — which lets any group member run the app / restore from the
same backup, and makes `./deploy.py start test` work with no hacks. **No UID is hardcoded anywhere.**

Prod is already running non-root (as `crf37f`) from an earlier partial flip; this runbook finishes it
by moving ownership from *your personal group* to the **shared group**. Do it in its own window; the
one `sudo`/`chown` step is yours.

## Facts (verified 2026-07-02)
- Shared group: **`rss-sys-kazict`**, gid **`100647871`** (lives only in the host `.env` as
  `APP_GROUP=rss-sys-kazict` — never in a committed file).
- Data volume: `leaf-annotation-tool_leaf-data` → `/data`. Currently group `100073760` (crf37f's
  personal group); needs to become `100647871`.
- Host backup tree: `/deltos/e/leaf-annotation-tool/backup/{db,files}`.
- The **image already runs as any non-root uid**: `chmod -R a+rX /app` (repo source is mode 640) +
  granian invoked straight from `/app/.venv/bin/granian` (no `uv run` needing a writable HOME) +
  `umask 002` (files land group-writable). See `Dockerfile` (committed `0485579`, `114c4f3`).
- Deploy identity is injected by **`deploy.py`**: `PUID=$(id -u)` (auto), `PGID`=the `APP_GROUP` gid.
- Compose config: `~/Desktop/annotation-tool-deployment/Leaf-Annotation-Tool/` (pulls from origin;
  currently has these changes as local edits — see "Deployment divergence" at the bottom).

## STEP 1 — Back up prod DB first
```sh
CT=leaf-annotation-tool-app-1; TS=$(date -u +%Y%m%dT%H%M%SZ)
docker exec "$CT" python3 -c "import sqlite3;s=sqlite3.connect('/data/app.db');d=sqlite3.connect('/data/app.db.bak-$TS')
with d: s.backup(d)
d.close();s.close();print('ok')"
docker cp "$CT:/data/app.db.bak-$TS" /deltos/e/leaf-annotation-tool/backup/db/app.db.bak-$TS
```

## STEP 2 — chown data + backup to the shared group, group-writable + setgid (YOUR sudo)
`g+rwX` = group read/write; `g+s` on dirs = new files inherit the group (with `umask 002` → group-writable).
```sh
G=100647871   # rss-sys-kazict
# Data volume (via a throwaway root container — the volume isn't a host path):
docker run --rm -v leaf-annotation-tool_leaf-data:/data alpine sh -c "chown -R :$G /data && chmod -R g+rwX /data && find /data -type d -exec chmod g+s {} +"
# Host backup tree (this is the sudo bit):
sudo chown -R :rss-sys-kazict /deltos/e/leaf-annotation-tool/backup
sudo chmod -R g+rwX /deltos/e/leaf-annotation-tool/backup
sudo find /deltos/e/leaf-annotation-tool/backup -type d -exec chmod g+s {} +
```

## STEP 3 — Build + bring it up as you + the group
```sh
DEP=~/Desktop/annotation-tool-deployment/Leaf-Annotation-Tool; cd "$DEP"
# .env must have APP_GROUP=rss-sys-kazict (already set). deploy.py auto-builds + auto-versions.
./deploy.py start prod                 # app only  (runs as PUID=you, PGID=rss-sys-kazict)
# ./deploy.py start prod --with-backup # + litestream/lsyncd backups (needs BACKUP_DIR)
```

## STEP 4 — Verify
```sh
CT=leaf-annotation-tool-app-1
docker exec "$CT" id                                   # uid=<you>, gid=100647871
docker exec "$CT" stat -c '%g %a %n' /data/app.db      # group 100647871, mode has group-write (66x)
curl -s -o /dev/null -w '%{http_code}\n' localhost:${PORT:-5000}/   # 200
# The real proof — a clean Docker testenv (decoupled from prod; --data-mode is required):
./deploy.py start test --data-mode reset               # auto-picks a free port; ./deploy.py stop test to tear down
```

## Backup exclusivity
Only run backups from ONE host (the one with `BACKUP_DIR` set + `deploy.py start prod --with-backup`).
Two litestream writers against the same `BACKUP_DIR` corrupt the file replica; the honor-flag that used
to "guard" this was removed as confusing + unenforced. Real enforcement (a heartbeat lease) is filed in
`RAINYDAY.md`. Members running `deploy.py start test` never back up (own volume, app-only).

## Rollback
Revert is data-safe: `./deploy.py stop prod`, restore `app.db.bak-$TS` if needed, redeploy the prior
image (`git checkout <sha> && ./deploy.py start prod`). Ownership is reversible (`chown -R :0 /data`,
`sudo chown -R root:root .../backup`) but you won't need to.

## Deployment divergence (until dev main is pushed)
The deployment checkout has `Dockerfile`/`compose.yaml` as **local edits** (+ `deploy.py` untracked,
+ `.env` with `APP_GROUP`), byte-identical to the dev-repo commits. On the next real deploy: push dev
`main`, then in the deployment `git checkout -- Dockerfile compose.yaml` and `git pull` (deploy.py will
then be tracked; keep the gitignored `.env`).
