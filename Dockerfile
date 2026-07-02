# syntax=docker/dockerfile:1

ARG UV_VERSION=0.11.15

# ── Tool image ────────────────────────────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-bin

# ── App image ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Pinned uv binary. The app is fully DECOUPLED from the backup layer — no litestream
# here; restore is an explicit orchestration step (see compose `restore` service).
COPY --from=uv-bin /uv /uvx /usr/local/bin/

# Deps layer (cache-stable: only lock files; project itself excluded so this
# layer is reused unless deps actually change)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Project source (Python package + static assets)
COPY webapp/*.py webapp/
COPY webapp/static/ webapp/static/

# Alembic migrations — read from disk by path at boot (webapp/db.py's auto_create_schema()),
# NOT part of the installed Python package, so they need an explicit copy here too.
COPY alembic.ini ./
COPY alembic/ alembic/

# Bundle from frontend build (populated via bake context; overrides any static/dist
# that might have slipped through)
COPY --from=frontend-build /app/webapp/static/dist ./webapp/static/dist

# Install the project itself
RUN uv sync --frozen --no-dev

# Make the whole app tree world-readable/searchable so the container can run as ANY
# (non-root) uid — repo source files are mode 640 and COPY preserves that, which would
# otherwise 'Permission denied' for a non-root user (see the ownership-flip runbook).
RUN chmod -R a+rX /app

ENV HT_DATA_DIR=/data
ENV PORT=5000

# Build-time version identity (docs/plans/Plan — Version everything (stack-wide).md).
# The prod image has no `.git`, so the SHA/timestamp are baked in at `docker build` time;
# absent build args fall back to "unknown"/"dev" (see webapp/version.py) — never breaks a
# plain `docker build` with no --build-arg.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

EXPOSE 5000

# Run granian straight from the venv (not `uv run`): as a non-root uid, `uv run` would try to
# touch its cache/venv and needs a writable HOME; the venv is already built, so invoke it directly.
CMD ["sh", "-c", "exec /app/.venv/bin/granian --interface wsgi --host 0.0.0.0 --port ${PORT} --workers 1 webapp.wsgi:app"]
