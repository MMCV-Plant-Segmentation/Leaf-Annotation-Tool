"""deploy_lib — the ONE shared "resolve sectioned config → AppConfig → launch" path.

Deploy-side library (NOT inside `webapp`): imported by both `deploy.py` (host, drives compose
+ dev) and `container_entry.py` (in-container, thin Dockerfile CMD). Sharing this module is
what keeps the host and the container's launch semantics from drifting.

Two responsibilities:

  resolve(master_cfg, mode) → {service_name: flat_config_dict}
      Read the sectioned master (app.config.toml sections [app] / [backup] / [deploy] / [dev]),
      expand shared values ONCE, and return a flat per-service slice ready to hand to
      build_appconfig() or to write out as a compose-secret file. `mode` is 'prod' or 'dev' —
      the ONLY situational knob the deploy layer owns. The app never sees the sections.

  launch_from_config_file(path) → int
      Read a resolved (flat) service config file → build_appconfig() → webapp.run(cfg). Called
      by container_entry.py; the mounted compose secret at /run/secrets/app-config is that file.

Secrets never touch env or the CLI (both leak via `docker inspect`/`ps`) — they ride inside the
resolved config file, mounted as a compose secret. deploy.py's prod path writes each service's
resolved slice into an ephemeral /tmp dir (mktemp -d, chmod 0700), points the compose
`secrets: file:` at it, and lets Compose mount it read-only at /run/secrets/<name>.
"""
from __future__ import annotations

import os
import tempfile
import tomllib
from pathlib import Path
from typing import Any


# ── Master config loading ─────────────────────────────────────────────────────

def load_master(path: Path) -> dict[str, Any]:
    """Load the sectioned master config file (app.config.toml)."""
    path = Path(path)
    if not path.exists():
        return {}
    with path.open('rb') as fh:
        return tomllib.load(fh)


# ── Resolve ───────────────────────────────────────────────────────────────────

def resolve(master: dict[str, Any], mode: str) -> dict[str, dict[str, Any]]:
    """Read the sectioned master, apply mode overrides, expand shared values ONCE, and return
    {service_name: flat_config_dict}. Fully mode-agnostic downstream — dev and prod both
    flatten the same [app] slice (plus [dev] overrides for dev). Deploy owns the situational
    mode knob; the app just gets a flat dict.

    Sectioned master schema:
        [app]      data_dir, host, port, secret_key, admin_password, backup_status_url
        [backup]   backup_dir                 (shared: also folded into [app].backup_dir for
                                               the admin panel's display)
        [deploy]   app_group, compose_project_name
        [dev]      dev-only overrides for the app slice (typically host = "127.0.0.1")

    Shared values live in ONE place — deploy_lib.resolve folds them into the per-service
    slices, so app.config.toml never duplicates.
    """
    if mode not in ('prod', 'dev'):
        raise ValueError(f'unknown mode: {mode!r} (expected prod|dev)')

    app_section    = dict(master.get('app') or {})
    backup_section = dict(master.get('backup') or {})
    dev_section    = dict(master.get('dev') or {})

    # Shared value: [backup].backup_dir is the single source of truth for the host backup
    # location; the app slice inherits it (for the admin panel display + AppConfig.backup_dir)
    # unless [app] explicitly overrode it.
    if backup_section.get('backup_dir') and 'backup_dir' not in app_section:
        app_section['backup_dir'] = backup_section['backup_dir']

    # Mode overrides: [dev] wins on the app slice for dev; prod uses the app slice verbatim
    # (there is no [prod] section — prod IS the canonical config).
    if mode == 'dev':
        for key, value in dev_section.items():
            app_section[key] = value

    # Mode-specific bind default: prod binds 0.0.0.0 (Docker); dev binds 127.0.0.1 (local).
    # Only applies when neither [app] nor [dev] said otherwise.
    if 'host' not in app_section:
        app_section['host'] = '0.0.0.0' if mode == 'prod' else '127.0.0.1'
    app_section.setdefault('port', 5000)

    # Mode-specific data_dir default: prod runs in-container against the mounted Docker
    # volume at /data; dev falls through to default_data_dir()'s local XDG path (handled
    # by build_appconfig when data_dir stays unset).
    if mode == 'prod':
        app_section.setdefault('data_dir', '/data')

    return {'app': app_section}


# ── AppConfig builder ─────────────────────────────────────────────────────────

def build_appconfig(cfg_dict: dict[str, Any]):
    """Flat resolved dict → AppConfig. Mirrors what the old webapp/wsgi.py:_prod_cfg_from_env
    did, minus any environment sniffing (everything comes from `cfg_dict`)."""
    from webapp.config import AppConfig, default_data_dir

    data_dir_val = cfg_dict.get('data_dir')
    port_val = cfg_dict.get('port', 5000)
    return AppConfig(
        data_dir=Path(data_dir_val) if data_dir_val else default_data_dir(),
        host=cfg_dict.get('host', '127.0.0.1'),
        port=int(port_val),
        port_policy='strict',
        db_seed='existing',
        backup=bool(cfg_dict.get('backup', False)),
        secret_key=cfg_dict.get('secret_key'),
        admin_password=cfg_dict.get('admin_password'),
        backup_dir=cfg_dict.get('backup_dir'),
        backup_status_url=cfg_dict.get('backup_status_url'),
    )


# ── Compose-secret file emission ──────────────────────────────────────────────

def _toml_literal(value: Any) -> str:
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    escaped = str(value).replace('\\', '\\\\').replace('"', '\\"')
    return '"' + escaped + '"'


def write_service_config(config_dict: dict[str, Any], dest: Path) -> None:
    """Write a flat resolved service slice as TOML at `dest`, mode 0600. Compose mounts it
    as a secret (read-only) at /run/secrets/<name> inside the container; container_entry
    reads it back via launch_from_config_file."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        '# Resolved app-service config — written by deploy.py, mounted as the `app-config`',
        '# compose secret. Contains secrets inline; NEVER commit or copy off the host.',
    ]
    for key in sorted(config_dict):
        value = config_dict[key]
        if value is None:
            continue
        lines.append(f'{key} = {_toml_literal(value)}')
    dest.write_text('\n'.join(lines) + '\n')
    os.chmod(dest, 0o600)


def make_ephemeral_config_dir() -> Path:
    """mktemp -d, chmod 0700 — the ephemeral dir into which deploy.py writes resolved
    per-service config files that compose mounts as secrets."""
    tmpdir = Path(tempfile.mkdtemp(prefix='leaf-deploy-config-'))
    os.chmod(tmpdir, 0o700)
    return tmpdir


# ── Container-side entry (thin wrapper around webapp.run) ─────────────────────

def launch_from_config_file(path: Path) -> int:
    """Read the flat resolved config file at `path` → AppConfig → webapp.run(cfg).

    Called by container_entry.py (Dockerfile CMD). The file at `path` is the compose secret
    mounted at /run/secrets/app-config; it contains no sections and no env — just the flat
    per-service slice `resolve()` produced host-side. This is the ONE place the container
    reads its config from."""
    path = Path(path)
    with path.open('rb') as fh:
        cfg_dict = tomllib.load(fh)
    cfg = build_appconfig(cfg_dict)
    from webapp.wsgi import run
    return run(cfg)
