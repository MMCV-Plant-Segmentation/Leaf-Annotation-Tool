# Setup

> What this app *is* and how it works lives in [`docs/SPEC.md`](docs/SPEC.md). This file is
> just how to stand it up. All commands run from this directory (`code/` — the one with
> `compose.yaml` and `pyproject.toml`).

There are two ways to run it: **Docker** (production / collaborators) and **native** (local dev).

---

## Production (Docker)

**Prerequisites:** Docker with `buildx` and `compose`. The backup services (litestream + lsyncd)
mirror to `BACKUP_DIR`, so that path must exist on the host — or skip them (see note below).

1. **Create `.env`** from the template and fill in real values:

   ```sh
   cp .env.example .env
   ```

   Set, at minimum:
   - `SECRET_KEY` — a random 32+ char string. Generate one with:
     `uv run python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
   - `ADMIN_PASSWORD` — the password for the built-in `admin` account (required on first boot).
   - `BACKUP_DIR` — where backups are mirrored (defaults to the `/deltos` path in `.env.example`).
   - `PORT` — host port (defaults to `5000`).

2. **Build the images:**

   ```sh
   docker buildx bake
   ```

3. **(Restoring a wiped/fresh deployment only)** lay down the DB + files from backup *before* starting:

   ```sh
   docker compose run --rm restore
   ```

4. **Start it:**

   ```sh
   docker compose up -d
   ```

5. Open `http://<host>:<PORT>`, log in as **`admin`** with `ADMIN_PASSWORD`, then go to the
   **Admin** panel to create invite codes for collaborators.

> **Just trying it / no backup target yet?** `docker compose up -d app` runs only the web app
> (skips litestream + lsyncd, so `BACKUP_DIR` need not exist). Data persists in the `leaf-data`
> Docker volume regardless.

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
