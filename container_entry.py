#!/usr/bin/env python3
"""Container app entrypoint — the Dockerfile CMD invokes this.

Reads the resolved app-service config mounted by Docker Compose as a secret at
`/run/secrets/app-config`, and hands off to `deploy_lib.launch_from_config_file` which
builds the AppConfig and calls webapp.run(cfg).

Deploy-owned (lives at the repo root, alongside deploy.py + deploy_lib.py, NOT under
webapp/) — the webapp package knows nothing about compose, secrets, or /run/secrets.
"""
from __future__ import annotations

import sys
from pathlib import Path

CONFIG_PATH = Path('/run/secrets/app-config')


def main() -> int:
    if not CONFIG_PATH.exists():
        sys.stderr.write(
            f'container_entry: no config file at {CONFIG_PATH}. The prod container is meant '
            f'to be started via `./deploy.py prod`, which writes the resolved app config to '
            f'an ephemeral /tmp file and mounts it as the `app-config` compose secret.\n'
        )
        return 2
    # Import deferred: keep the "no config" failure above cheap and side-effect-free.
    from deploy_lib import launch_from_config_file
    return launch_from_config_file(CONFIG_PATH)


if __name__ == '__main__':
    raise SystemExit(main())
