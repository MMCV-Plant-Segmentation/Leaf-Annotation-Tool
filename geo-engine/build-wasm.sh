#!/usr/bin/env bash
# t137 — the ONE way to build geo_engine.wasm, so the artifact is byte-identical no matter
# who builds it or where.
#
# The problem this fixes: rustc embeds absolute source paths for panic/debug metadata. The
# dependency sources live under $CARGO_HOME, which differs between the host
# (/home/<user>/.cargo) and the jail — so a jail rebuild produced different bytes than the
# committed host build, and the gate's rust:wasm-diff failed for no real reason. (The
# /rustc/<hash>/ standard-library paths are already remapped by rustc and are fine.)
#
# Remapping $CARGO_HOME and the crate dir to fixed tokens makes the embedded paths
# environment-independent, so host == jail == CI.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "$0")" && pwd)"
CARGO_HOME_RESOLVED="${CARGO_HOME:-$HOME/.cargo}"

# Order matters only in that each mapping must be exact; these two are disjoint prefixes.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${CARGO_HOME_RESOLVED}=/cargo --remap-path-prefix=${CRATE_DIR}=/geo-engine"

exec cargo build --release --target wasm32-unknown-unknown --manifest-path "$CRATE_DIR/Cargo.toml" "$@"
