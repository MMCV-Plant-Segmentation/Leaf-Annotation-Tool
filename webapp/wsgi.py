"""WSGI entry point for production serving, e.g.:
    cd webapp && uv run granian --interface wsgi --host 127.0.0.1 --port 5000 --workers 1 wsgi:app

Use --workers 1: _startup() runs per worker on import, and _migrate_data_to_local() copies
data on first run — multiple cold workers would race on that copy. Single worker is plenty
for the single-machine lab server. Revisit only if throughput becomes a bottleneck.

For development, use `uv run app.py` (Werkzeug dev server with auto-reloader).
"""
from app import app, _startup

_startup()
