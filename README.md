# Setup

> What this app *is* and how it works lives in [`docs/SPEC.md`](docs/SPEC.md). This file is
> just how to stand it up. All commands run from this directory (`code/` — the one with
> `compose.yaml` and `pyproject.toml`).

There are two ways to run it: **Docker** (production / collaborators) and **native** (local dev).

---

## Production (Docker)

**Prerequisites:** Docker with `buildx` + `compose`, and membership in a shared Unix group that will
co-own the data + backups. Everything goes through **`./deploy.py`** — it runs the stack as *you* +
that group (never root, no sudo, no UID hardcoded), auto-computes the build version, and builds when
needed. (Raw `docker compose` still works but defaults to running as **root**, which makes the data +
backups root-owned — use `deploy.py`.)

1. **Create `.env`** interactively — generates `SECRET_KEY` for you and prompts for the rest
   (`PORT`, `APP_GROUP` = the shared group, `BACKUP_DIR` = optional backup path, `ADMIN_PASSWORD` =
   the first-boot `admin` login):

   ```sh
   ./deploy.py create-dot-env
   ```

2. **Starting from an existing backup** (only when seeding a fresh/wiped host) — lay the DB + files
   down first:

   ```sh
   ./deploy.py restore
   ```

3. **Start it** (builds the image if needed, then runs as you + `APP_GROUP`):

   ```sh
   ./deploy.py start prod                 # app only
   ./deploy.py start prod --with-backup   # + litestream/lsyncd backups (needs BACKUP_DIR)
   ```

   Stop with `./deploy.py stop prod`.

4. Open `http://<host>:<PORT>`, log in as **`admin`** with `ADMIN_PASSWORD`, then use the **Admin**
   panel to create invite codes for collaborators.

> Backup is **opt-in** (`--with-backup`, needs `BACKUP_DIR`); without it the app runs alone. Data
> persists in the `leaf-data` Docker volume regardless. Only **one** host should back up to a given
> `BACKUP_DIR`.

### Testing against real data

`./deploy.py start test` runs the **real image** against a **throwaway copy** of prod's data on
`:5001` (prod is never touched) — so container-only issues (permissions, entrypoint) surface before
you deploy. `./deploy.py stop test` tears it down.

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
