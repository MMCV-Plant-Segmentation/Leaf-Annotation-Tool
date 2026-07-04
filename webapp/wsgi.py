"""WSGI entry point for production serving, e.g. (run from the code/ repo root):
    uv run granian --interface wsgi --host 127.0.0.1 --port 5000 --workers 1 webapp.wsgi:app

Use --workers 1: create_app() runs _startup() per worker on import, and _migrate_data_to_local()
copies data on first run — multiple cold workers would race on that copy. Single worker is
plenty for the single-machine lab server. Revisit only if throughput becomes a bottleneck.

For development, use `uv run leaf-annotation` (Werkzeug dev server with auto-reloader).

Builds a prod AppConfig from env (Granian owns the socket — port_policy is conceptual here,
just documenting the prod invariant) and goes through the same create_app(cfg) path dev/gate
use. db_seed='existing' means this never wipes/seeds data; restore is the explicit
`docker compose run --rm restore` step run before the app boots.

Config source: environment variables win (in Docker, deploy.py injects them into the container
from app.config.toml / .env via compose). For a bare-metal `granian webapp.wsgi:app` run from
the repo root — where nothing exported those vars — we fall back to app.config.toml (or a legacy
.env) read from the repo root, so the one config file works for that entrypoint too.
"""
import os
from pathlib import Path

from webapp.app import create_app
from webapp.config import AppConfig, default_data_dir
from webapp.config_file import load_file_config

_ROOT = Path(__file__).resolve().parent.parent
_file = load_file_config(_ROOT)


def _cfg_get(env_name):
    """Env var (authoritative — container injection) first, then the config file fallback."""
    return os.environ.get(env_name) or _file.get(env_name)


_data_dir = _cfg_get('HT_DATA_DIR')
_cfg = AppConfig(
    data_dir=Path(_data_dir) if _data_dir else default_data_dir(),
    port_policy='strict',
    db_seed='existing',
    backup=True,
    secret_key=_cfg_get('SECRET_KEY'),
    admin_password=_cfg_get('ADMIN_PASSWORD'),
    backup_dir=_cfg_get('BACKUP_DIR'),
    backup_status_url=_cfg_get('BACKUP_STATUS_URL'),
)

app = create_app(_cfg)
