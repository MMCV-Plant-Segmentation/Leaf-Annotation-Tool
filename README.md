# Setup

> What this app *is* and how it works lives in [`docs/SPEC.md`](docs/SPEC.md). This file is
> just how to stand it up. All commands run from this directory (`code/` — the one with
> `compose.yaml`, `pyproject.toml`, and `deploy.py`).

Everything situational — build, containerization, config source, dev/test/prod — goes through
**`./deploy.py`**. The `webapp` package itself knows nothing about modes or environments: it's a
library that takes an explicit config and runs. `deploy.py` reads one file (`app.config.toml`),
hands each service just its slice, and never runs anything as root.

```
./deploy.py create-config      # write app.config.toml interactively
./deploy.py dev                # in-process dev server (no container)
./deploy.py start test --data-mode <mode>   # throwaway test container (see below)
./deploy.py prod [--with-backup]            # build + run prod containers
./deploy.py stop test | prod
./deploy.py restore            # seed a fresh prod host from a backup
```

---

## 1. Configure (`app.config.toml`) — do this once

All three modes read a **sectioned** `app.config.toml` in this directory. It's **gitignored** and
may hold secrets (`secret_key`, `admin_password`); only [`app.config.toml.example`](app.config.toml.example)
(the annotated template) is committed. Create it either way:

```sh
./deploy.py create-config                    # interactive — generates secret_key, prompts for the rest
# ...or:
cp app.config.toml.example app.config.toml   # then edit it by hand
```

The sections: **`[app]`** (the values the app actually gets — `port`, `secret_key`, `admin_password`),
**`[backup]`** (`backup_dir`, the one source of truth for the backup path), **`[deploy]`**
(`app_group` = the shared Unix group prod runs as; not used by dev/test), **`[dev]`** (dev-only
overrides, e.g. bind to `127.0.0.1`). Per-run intent (`--data-mode`, `--branch`, `--port`) is
**CLI-only**, never in the file.

> Upgrading from the old flat `app.config.toml` (or a legacy `.env`)? The app no longer reads ambient
> env at all — reformat into the sections above (or just re-run `create-config`). A flat file will
> not resolve.

---

## 2. Deploy the test environment

`./deploy.py start test` runs the **real production image** in a throwaway container (`leaf-testenv`)
on its own volume (`leaf-test-data`) and an **auto-assigned free port** — so container-only issues
(permissions, entrypoint, the compose-secret config path) surface exactly as prod would hit them.
It runs as **you** (personal uid/gid), does **not** require prod to be running, and never reads
prod's live volume.

`--data-mode` is **required** (no default — it's a wipe-guard, since every mode but `keep` replaces
the test volume):

| mode | what it does |
|------|--------------|
| `fixture` | the committed **synthetic dataset** (`webapp/tests/fixtures/subagent_dataset/`) — seeded `admin` / `subagent` logins + a demo project. Disjoint from prod by construction. **Quickest way to a usable env.** |
| `reset` | fresh, empty volume — schema auto-creates on boot; log in as `admin` with `[app].admin_password`. |
| `restore` | populate from `[backup].backup_dir` (the same backup source prod restore uses). Real data. |
| `keep` | reuse whatever's already in the test volume from a previous run. |

**To test the current branch** (e.g. `test/integration`), just run it from that checkout:

```sh
./deploy.py start test --data-mode fixture      # seeded logins, fastest
# or, for real data:  ./deploy.py start test --data-mode restore
```

It prints the URL (`http://localhost:<port>`), the `docker logs -f leaf-testenv` command, and the
stop command. Tear it down with **`./deploy.py stop test`**.

Add `--branch <ref>` to build+test a branch you're *not* checked out on (built via a throwaway
worktree, nothing merged). Add `--port <N>` to pin the port instead of auto-assigning.

> The `fixture` dataset is committed and ready. If you ever need to rebuild/extend it:
> `uv run python webapp/tests/build_subagent_fixture.py`.

---

## 3. Production (Docker)

**Prerequisites:** Docker with `buildx` + `compose`, and membership in the `[deploy].app_group`
shared group that co-owns the data + backups. `deploy.py` runs the stack as *you* + that group
(never root, no sudo), computes the build version, and builds when needed.

```sh
./deploy.py restore                 # ONLY when seeding a fresh/wiped host from a backup — lay data down first
./deploy.py prod                    # build (if needed) + run the app
./deploy.py prod --with-backup      # + the litestream/lsyncd backup sidecars (needs [backup].backup_dir)
./deploy.py stop prod
```

Config rides into the container as a **compose secret** (mounted at `/run/secrets/app-config`) — no
env block, no secrets on the command line. Open `http://<host>:<port>`, log in as **`admin`** with
`[app].admin_password`, then use the **Admin** panel to invite collaborators.

> Backup is opt-in (`--with-backup`); without it the app runs alone and data still persists in the
> `leaf-data` Docker volume. Only **one** host should back up to a given `backup_dir`.

---

## 4. Native dev (no container)

For fast local iteration, `./deploy.py dev` runs the app **in-process** (resolves `[app]` + `[dev]`
→ an `AppConfig` → the same `webapp.run()` prod uses in-container). First-time setup:

1. **Python deps:** `uv sync`
2. **Frontend bundle** (gitignored — build it at least once; rebuild after FE changes, or run
   `npm run build:watch` in a second terminal):
   ```sh
   cd webapp/frontend && npm install && npm run build && cd ../..
   ```
3. **Run it:**
   ```sh
   ./deploy.py dev            # serves on [app].port (default 5000), bound to [dev].host (127.0.0.1)
   ```
   Data lives in the `[dev].data_dir` if set, else the NFS-safe local XDG dir
   (`~/.local/share/leaf-annotation`).

> `uv run leaf-annotation` still works but is now **flag-driven with no env fallback** (e.g.
> `--secret-key … --admin-password …`); `./deploy.py dev` is the easy path.
