#!/usr/bin/env bash
# Agent worktree manager — isolated git worktrees so multiple implementation agents
# (Sonnet now; possibly non-Claude backends later) can run in PARALLEL without their
# gates compiling each other's half-finished changes. Gitignored local tooling
# (like scripts/gate.sh). See docs/plans/Plan — Subagent parallelism (worktrees).md.
#
# Usage (branch is a full conventional ref — task/<n>, feature/<n>, fix/<n>, …):
#   scripts/worktree.sh add <branch>   # e.g. fix/undo-bug → ../worktrees/undo-bug on branch fix/undo-bug
#   scripts/worktree.sh list
#   scripts/worktree.sh rm <branch>    # same branch ref you created with
#
# Isolation model:
#   - FE deps: node_modules is SYMLINKED from the main checkout (packages only; the FE
#     *source* is read from the worktree, so changes are isolated). ~165M not duplicated.
#   - Backend: the worktree gets its OWN .venv via `uv sync`, so the editable install
#     resolves `webapp` to THIS worktree (NOT main) — real backend isolation. uv's global
#     wheel cache makes this quick.
#   - The gate is already concurrency-safe (ephemeral free port + /tmp temp data dir), so
#     N worktrees can each run `bash scripts/gate.sh` at once.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"          # .../code
WT_ROOT="$(dirname "$REPO")/worktrees"            # .../worktrees (sibling, outside the repo)
cmd="${1:-}"; branch="${2:-}"

case "$cmd" in
  add)
    [ -n "$branch" ] || { echo "usage: worktree.sh add <branch>  (e.g. task/foo, feature/bar, fix/baz)" >&2; exit 2; }
    dir="${branch##*/}"                           # worktree dir = last path segment (e.g. fix/foo → foo)
    dest="$WT_ROOT/$dir"
    mkdir -p "$WT_ROOT"
    git -C "$REPO" worktree add "$dest" -b "$branch"
    ln -s "$REPO/webapp/frontend/node_modules" "$dest/webapp/frontend/node_modules"
    # Gate tooling lives under the gitignored /scripts/, so it's absent from a fresh worktree.
    # COPY it (don't symlink: gate.py resolves REPO from its own __file__, and a symlink would
    # resolve back to main → the gate would run against main, not this worktree).
    mkdir -p "$dest/scripts"
    cp "$REPO/scripts/gate.sh" "$REPO/scripts/gate.py" "$dest/scripts/"
    # Put the .venv on LOCAL disk, not the NFS worktree. A venv is thousands of tiny files;
    # materializing it on /deltos (NFS) is slow (>30s each, minutes for several) even though uv's
    # resolution is cached. Deterministic path under $TMPDIR keyed to the worktree dir, symlinked
    # in as `.venv` so plain `uv run` (agents, gate) finds it transparently with no env var needed.
    LVENV_DIR="${TMPDIR:-/tmp}/leaf-anno-wt/$dir"
    rm -rf "$LVENV_DIR"; mkdir -p "$LVENV_DIR"
    echo "[worktree] uv sync (own .venv on local disk → backend isolation, fast)…"
    # UV_PROJECT_ENVIRONMENT makes uv CREATE the venv at the local path (no symlink involved during
    # creation → avoids the dangling-symlink mkdir race); then symlink it in as `.venv` so plain
    # `uv run` (agents, gate) finds it transparently at runtime with no env var needed.
    ( cd "$dest" && UV_PROJECT_ENVIRONMENT="$LVENV_DIR/.venv" uv sync --quiet )
    ln -sfn "$LVENV_DIR/.venv" "$dest/.venv"
    echo "[worktree] ready: $dest   (branch $branch)"
    echo "[worktree] dispatch an agent to work IN $dest; it commits to $branch; Opus reviews + merges to main."
    ;;
  list)
    git -C "$REPO" worktree list ;;
  rm)
    [ -n "$branch" ] || { echo "usage: worktree.sh rm <branch>" >&2; exit 2; }
    dir="${branch##*/}"; dest="$WT_ROOT/$dir"
    rm -f "$dest/webapp/frontend/node_modules"    # drop symlink so remove won't touch main's deps
    rm -rf "${TMPDIR:-/tmp}/leaf-anno-wt/$dir"    # remove the local-disk venv (new-style worktrees)
    # Let git remove the worktree tree wholesale — handles `.venv` whether it's our /tmp symlink
    # or an old-style real dir. (Don't pre-`rm` it: `rm -f` chokes on a real dir under `set -e`.)
    git -C "$REPO" worktree remove --force "$dest"
    git -C "$REPO" branch -D "$branch" 2>/dev/null || true
    echo "[worktree] removed $dest and branch $branch"
    ;;
  *)
    echo "usage: worktree.sh {add <branch>|list|rm <branch>}" >&2; exit 2 ;;
esac
