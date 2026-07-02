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
"""
import os
from pathlib import Path

from webapp.app import create_app
from webapp.config import AppConfig, default_data_dir

_cfg = AppConfig(
    data_dir=Path(os.environ['HT_DATA_DIR']) if os.environ.get('HT_DATA_DIR') else default_data_dir(),
    port_policy='strict',
    db_seed='existing',
    backup=True,
    secret_key=os.environ.get('SECRET_KEY'),
    admin_password=os.environ.get('ADMIN_PASSWORD'),
    backup_dir=os.environ.get('BACKUP_DIR'),
    backup_status_url=os.environ.get('BACKUP_STATUS_URL'),
)

app = create_app(_cfg)
