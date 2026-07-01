"""Alembic environment — resolves the DB URL from the app's own config (webapp/db.py's
_db_path()) instead of a hardcoded alembic.ini URL, so dev/testenv/prod/gate all target
the right app.db automatically (see docs/plans/Plan — Adopt Alembic (baseline + forward
migrations).md).

render_as_batch=True is mandatory: SQLite can't ALTER/DROP columns or add constraints
in place, so Alembic's batch mode rebuilds the table under a temp name instead. Every
future forward migration that touches an existing table depends on this being set here.
"""
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

# Repo root (parent of this alembic/ dir) must be on sys.path so `webapp` is importable
# both when invoked via the bare `alembic` CLI and programmatically from webapp/db.py.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from webapp import db as _db  # noqa: E402  (import after sys.path fixup)

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Hand-written migrations only (no ORM models) — nothing to autogenerate against.
target_metadata = None


def get_url() -> str:
    """DB URL: whatever the active AppConfig resolves to (see db.configure()/_db_path()).

    A caller that pre-configured webapp.db (create_app -> db.configure(cfg)) gets that
    exact db.db; the bare `alembic` CLI falls back to db.py's own env-var/XDG default
    (same fallback every other standalone script in this repo uses).
    """
    override = config.get_main_option('sqlalchemy.url')
    if override:
        return override
    db_path = _db._db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)  # bare `alembic` CLI: dir may not exist yet
    return f'sqlite:///{db_path}'


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL, no DB connection)."""
    context.configure(
        url=get_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={'paramstyle': 'named'},
        render_as_batch=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (real connection)."""
    configuration = config.get_section(config.config_ini_section, {})
    configuration['sqlalchemy.url'] = get_url()
    connectable = engine_from_config(
        configuration,
        prefix='sqlalchemy.',
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
