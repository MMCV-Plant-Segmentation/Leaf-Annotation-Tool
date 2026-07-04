#!/usr/bin/env bash
# Shim → scripts/gate.py (the gate is now a Python program). Kept so the documented
# command `bash scripts/gate.sh` (docs/PROCEDURE.md) and the harness --gate-mode
# entrypoint keep working unchanged; all gate logic lives in gate.py.
exec uv run python "$(dirname "$0")/gate.py" "$@"
