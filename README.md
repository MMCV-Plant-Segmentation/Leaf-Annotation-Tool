# Setup

> What this app *is* and how it works lives in [`docs/SPEC.md`](docs/SPEC.md). This file is
> just how to stand it up. All commands run from this directory (`code/` — the one with
> `compose.yaml` and `pyproject.toml`).

There are two ways to run it: **Docker** (production / collaborators) and **native** (local dev).

---

## Production (Docker)

**Prerequisites:** Docker with `buildx` and `compose`. Backup is **opt-in**: the litestream + lsyncd
sidecars run only under the `backup` compose profile (see step 4). Plain `docker compose up` runs the
web app alone, with no backup.

1. **Create `.env`** from the template and fill in real values:

   ```sh
   cp .env.example .env
   ```

   Set, at minimum:
   - `SECRET_KEY` — a random 32+ char string. Generate one with:
     `uv run python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
   - `ADMIN_PASSWORD` — the password for the built-in `admin` account (required on first boot).
   - `BACKUP_DIR` — absolute host path where backups are mirrored. Optional; required only if you
     run the `backup` profile (step 4). No default — leave unset to run without backup.
   - `PORT` — host port (defaults to `5000`).
   - `APP_GROUP` — a shared Unix group that co-owns the data + backups, so any member can run the app
     and share the same backup. `./run.sh` (step 4) reads it and runs the stack as *you* + this group;
     your UID is auto-detected, never typed or hardcoded.

2. **Build the images.** Set `GIT_SHA`/`BUILD_TIME` so the running build's identity shows up
   in the app footer + admin Settings panel (`GET /api/version`); omitting them is safe (falls
   back to `unknown`/`dev`):

   ```sh
   GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) docker buildx bake
   ```

3. **(Restoring a wiped/fresh deployment only)** lay down the DB + files from backup *before* starting:

   ```sh
   ./run.sh run --rm restore
   ```

4. **Start it** with `./run.sh` — it runs the stack as *you* + the shared `APP_GROUP` (so the DB and
   backups stay group-owned, shareable by any group member) and forwards all args to `docker compose`.
   With backup (the primary host only — needs `BACKUP_DIR` + `BACKUP_PRIMARY=1`):

   ```sh
   ./run.sh --profile backup up -d
   ```

   Or app-only, no backup:

   ```sh
   ./run.sh up -d
   ```

5. Open `http://<host>:<PORT>`, log in as **`admin`** with `ADMIN_PASSWORD`, then go to the
   **Admin** panel to create invite codes for collaborators.

> Data persists in the `leaf-data` Docker volume either way. The `backup` profile only adds the
> litestream + lsyncd mirrors to `BACKUP_DIR`.

---

## Native (local dev)

**Prerequisites:** [`uv`](https://docs.astral.sh/uv/) and Node 24 (with `npm`).

1. **Install Python deps:**

   ```sh
   uv sync
   ```

2. **Build the frontend bundle** (it's gitignored, so it must be built at least once; rebuild
   after frontend changes — or use `npm run build:watch` in a second terminal):

   ```sh
   cd webapp/frontend && npm install && npm run build && cd ../..
   ```

3. **Create `.env`** with at least `SECRET_KEY` and `ADMIN_PASSWORD` (see the prod section for
   how to generate `SECRET_KEY`).

4. **Run it:**

   ```sh
   uv run leaf-annotation
   ```

   Serves on `http://localhost:5000`. Data lives in a local XDG dir
   (`~/.local/share/leaf-annotation` by default; override with `HT_DATA_DIR`).
