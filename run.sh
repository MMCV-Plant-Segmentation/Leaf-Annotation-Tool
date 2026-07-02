#!/usr/bin/env bash
# Run the stack as the INVOKING user + a SHARED GROUP, so nobody has to know or hardcode a UID and
# every group member can read/write the same data + backups. PUID = your uid (auto-detected); PGID =
# the gid of the group named by APP_GROUP in .env. Forwards all args straight to `docker compose`.
#
#   ./run.sh up -d                     # app only
#   ./run.sh --profile backup up -d    # + backup sidecars (primary host only; see BACKUP_PRIMARY)
#   ./run.sh down                      # stop
#
# Building the image is a separate step (the app image is a buildx-bake target with a frontend-build
# context, which `docker compose build` can't do):
#   GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) docker buildx bake app
set -euo pipefail
cd "$(dirname "$0")"

# Pull APP_GROUP (and the rest) from the host .env — the shared group name lives ONLY here, never in
# a committed file.
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${APP_GROUP:?set APP_GROUP=<shared group name> in .env (the group that co-owns the data + backups)}"

gid="$(getent group "$APP_GROUP" | cut -d: -f3 || true)"
[ -n "$gid" ] || { echo "run.sh: group '$APP_GROUP' not found on this host (getent group)" >&2; exit 1; }

export PUID="$(id -u)"   # you, auto — never typed, never committed
export PGID="$gid"       # the shared group

exec docker compose "$@"
