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

Each checkout has its **own** `app.config.toml` in its directory (it's **gitignored** and may
hold `secret_key`). Configs are **per-clone** — a separate prod clone and testing clone have
independent configs that never touch each other. The wizard writes only the current directory's
file, prompts before overwriting, and generates the `secret_key` for you:

```sh
./deploy.py create-config
```

It's **sectioned + versioned**:

```toml
config_version = 1

[app]                       # the values the app itself gets
port = 5000
secret_key = "…"            # required; generated for you

[backup]                    # optional
backup_dir = "/path/to/backup"   # one source of truth for the backup path

[deploy]                    # never seen by the app
app_group = "your-group"    # shared Unix group prod runs as (not used by dev/test)
compose_project_name = "leaf-annotation-tool"

[dev]                       # dev-only overrides for [app]
host = "127.0.0.1"
```

- **`admin_password` is NOT in the config** — it's **CLI-only** (`--admin-password`), used once to
  seed the admin on a fresh DB and never persisted. See §2/§3.
- **Per-run intent** (`--data-mode`, `--branch`, `--port`, `--admin-password`) is CLI-only, never
  in the file.
- **Upgrading an old config?** If `deploy.py` says your config is out of date (missing/old
  `config_version` — e.g. a pre-sectioned flat file), run **`./deploy.py migrate-config`**: it
  regroups it losslessly into the schema above, drops `admin_password` (now CLI-only), and backs up
  the original first. No more obscure parse failures on a stale config.

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
| `reset` | fresh, empty volume — schema auto-creates on boot. Pass `--admin-password '…'` to seed the `admin` login (there's no data otherwise). |
| `restore` | populate from `[backup].backup_dir` (the same backup source prod restore uses). Real data. |
| `keep` | reuse whatever's already in the test volume from a previous run. |

**To test the current branch** (e.g. `test/integration`), just run it from that checkout:

```sh
./deploy.py start test --data-mode fixture                       # seeded logins, fastest
# real data (admin comes with it):   ./deploy.py start test --data-mode restore
# fresh empty DB, seed your own admin: ./deploy.py start test --data-mode reset --admin-password '…'
```

It prints the URL (`http://localhost:<port>`), the `docker logs -f leaf-testenv` command, and the
stop command. Tear it down with **`./deploy.py stop test`**. (`create-config` can also do this
end-to-end — it offers to stand up the test env right after writing the config.)

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
env block, no secrets on the command line. On a **fresh** prod DB, seed the admin with
`./deploy.py prod --admin-password '…'` (first boot only — it never overwrites an existing admin).
Open `http://<host>:<port>`, log in as **`admin`**, then use the **Admin** panel to invite
collaborators.

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
