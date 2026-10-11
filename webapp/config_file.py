"""Load stack config from app.config.toml (preferred) with a DEPRECATED .env fallback.

app.config.toml (repo root, GITIGNORED, MAY contain secrets — same posture as the .env it
replaces) is the single config file for the whole stack: every AppConfig value that used to
come from the environment, plus deploy.py's orchestration settings (APP_GROUP, ports, backup
dir, secrets). It REPLACES .env.

Precedence is enforced by each ENTRYPOINT, not here: CLI flag > this file > built-in default.
Required-ness is likewise validated by the entrypoint AFTER merging file + CLI (argparse can't
express "required unless the file supplies it"), e.g. create_app() raising when no secret_key
resolves, and deploy.py's --data-mode wipe-guard.

Resolution:
  - app.config.toml present            → use it (source='toml').
  - only a legacy .env present         → HARD FAIL with a migration hint. The .env fallback
                                         was deprecated and is now removed; silently reading a
                                         stale .env hid config drift, so we refuse instead.
  - both present                       → app.config.toml wins (the .env is ignored, not an error).
  - neither                            → empty (source=None); the entrypoint falls back to
                                         its own env/defaults exactly as before.

Values are returned keyed by their canonical ENV-style names (PORT, SECRET_KEY, APP_GROUP, …) —
the same names the legacy .env used — so deploy.py and the webapp entrypoints (wsgi.py, app.py)
consume them uniformly, and migrating a .env is a 1:1 key rename into TOML syntax.

NOTE (deliberate, see docs): the per-invocation MODE knobs — AppConfig.port_policy, db_seed,
restore_source, admin_password_force, backup — are intentionally NOT file-settable. They express
run intent (and db_seed in particular is the thing the deploy --data-mode wipe-guard protects);
a config file silently carrying db_seed='clean' would be a footgun. They stay CLI/entrypoint-only.
"""
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

CONFIG_FILENAME = 'app.config.toml'
LEGACY_ENV_FILENAME = '.env'

# app.config.toml uses lowercase, idiomatic TOML keys; internally we normalize to the canonical
# ENV-style names the stack already uses. Anything not in this map is upper-cased as-is, so a
# forward-compatible key added to the file still round-trips to a sensible ENV name.
_TOML_TO_ENV = {
    'port':                 'PORT',
    'host':                 'HT_HOST',
    'data_dir':             'HT_DATA_DIR',
    'secret_key':           'SECRET_KEY',
    'admin_password':       'ADMIN_PASSWORD',
    'backup_dir':           'BACKUP_DIR',
    'backup_status_url':    'BACKUP_STATUS_URL',
    'app_group':            'APP_GROUP',
    'compose_project_name': 'COMPOSE_PROJECT_NAME',
}

class FileConfig:
    """A resolved config file (or the absence of one). `.get(ENV_NAME)` returns the value or
    None; `.as_env()` returns the whole mapping for feeding a subprocess/compose environment."""

    def __init__(self, values: dict[str, str], source: str | None, path: Path | None):
        self._values = values
        self.source = source          # 'toml' | 'env' | None
        self.path = path

    def get(self, env_name: str, default: str | None = None) -> str | None:
        val = self._values.get(env_name)
        return val if val is not None else default

    def as_env(self) -> dict[str, str]:
        return dict(self._values)


def _parse_toml(path: Path) -> dict[str, str]:
    with path.open('rb') as fh:
        data = tomllib.load(fh)
    out: dict[str, str] = {}
    for key, val in data.items():
        if isinstance(val, (dict, list)):
            # No nested tables today — the schema is a single flat table. Skip (don't crash) so
            # an unexpected structure degrades gracefully rather than taking down every entrypoint.
            continue
        env_name = _TOML_TO_ENV.get(key, key.upper())
        # bool → 'true'/'false' would be surprising for env consumers; the current schema has no
        # bool keys, so plain str() (ints → '5000') is correct for everything we accept.
        out[env_name] = str(val)
    return out


def load_file_config(root: Path) -> FileConfig:
    """Resolve the stack config file under `root` (the repo/deploy dir). See module docstring."""
    toml_path = root / CONFIG_FILENAME
    env_path = root / LEGACY_ENV_FILENAME
    if toml_path.exists():
        return FileConfig(_parse_toml(toml_path), 'toml', toml_path)
    if env_path.exists():
        # Legacy .env is no longer read — fail loudly with a migration hint instead of silently
        # honouring a deprecated file (a stale .env quietly overriding intent was the footgun).
        sys.exit(
            f'[config] ERROR: found a legacy {LEGACY_ENV_FILENAME} but no {CONFIG_FILENAME}. '
            f'The {LEGACY_ENV_FILENAME} fallback has been removed — migrate to {CONFIG_FILENAME}: '
            f'copy {CONFIG_FILENAME}.example and fill it in (a 1:1 key rename — lowercase the keys, '
            f'quote strings), or run  ./deploy.py create-config  to generate one.')
    return FileConfig({}, None, None)
