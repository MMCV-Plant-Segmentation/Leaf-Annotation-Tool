"""Guards for the versioned/sectioned config layer (deploy_lib) — the F3/F5 hardening:

  - config_version validation: an old/unversioned config is rejected LOUDLY (never parsed on a
    best-effort guess), so a new deploy.py can't silently mis-read a stale config.
  - migrate_master: legacy flat (and unversioned-sectioned) → current sectioned schema,
    losslessly except admin_password, which is intentionally DROPPED (CLI-only now).
  - resolve: admin_password is NEVER sourced from the config file, even if someone leaves one in.
  - dumps_master round-trips and omits admin_password.

Run: uv run python webapp/tests/test_deploy_config.py
"""
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, for `import deploy_lib`
import deploy_lib as d

V = d.CURRENT_CONFIG_VERSION
FLAT = {
    'port': 5000, 'secret_key': 'sk', 'admin_password': 'pw',
    'backup_dir': '/b', 'app_group': 'g', 'compose_project_name': 'leaf-annotation-tool',
}


def test_migrate_flat_regroups_and_drops_admin():
    m, dropped = d.migrate_master(FLAT)
    assert dropped is True, 'flat admin_password must be reported dropped'
    assert m['app'] == {'port': 5000, 'secret_key': 'sk'}, m['app']
    assert 'admin_password' not in m['app'], 'admin_password must not survive migration'
    assert m['backup'] == {'backup_dir': '/b'}, m['backup']
    assert m['deploy'] == {'app_group': 'g', 'compose_project_name': 'leaf-annotation-tool'}, m['deploy']
    assert m['dev'] == {'host': '127.0.0.1'}, m['dev']
    assert m['config_version'] == V


def test_migrate_is_lossless_for_kept_values():
    # every non-admin flat value reappears somewhere in the migrated sections
    m, _ = d.migrate_master(FLAT)
    flat_back = {}
    for sec in ('app', 'backup', 'deploy', 'dev'):
        flat_back.update(m.get(sec, {}))
    for k, v in FLAT.items():
        if k == 'admin_password':
            assert k not in flat_back
        else:
            assert flat_back.get(k) == v, f'{k} lost/changed in migration'


def test_migrate_unknown_key_lands_in_app():
    m, _ = d.migrate_master({'port': 8080, 'secret_key': 's', 'backup_status_url': 'http://x'})
    assert m['app']['backup_status_url'] == 'http://x'


def test_migrate_sectioned_but_unversioned():
    raw = {'app': {'port': 5000, 'secret_key': 's', 'admin_password': 'pw'},
           'deploy': {'app_group': 'g'}}
    m, dropped = d.migrate_master(raw)
    assert dropped is True
    assert 'admin_password' not in m['app']
    assert m['config_version'] == V
    assert m['deploy']['app_group'] == 'g'


def test_version_validation():
    # unversioned (flat) -> loud error
    try:
        d.validate_master_version(FLAT, 'x'); raise AssertionError('expected ConfigVersionError')
    except d.ConfigVersionError as e:
        assert 'migrate-config' in str(e)
    # wrong version -> loud error
    try:
        d.validate_master_version({'config_version': V + 99, 'app': {}}, 'x')
        raise AssertionError('expected ConfigVersionError')
    except d.ConfigVersionError:
        pass
    # current version -> OK; empty (no file) -> OK
    d.validate_master_version({'config_version': V, 'app': {'secret_key': 's'}}, 'x')
    d.validate_master_version({}, 'x')


def test_resolve_never_sources_admin_password():
    r = d.resolve({'config_version': V, 'app': {'secret_key': 's', 'admin_password': 'leak'}}, 'prod')
    assert 'admin_password' not in r['app'], 'resolve must never carry admin_password from the file'
    # normal resolve still works
    assert r['app']['secret_key'] == 's'
    assert r['app']['host'] == '0.0.0.0'          # prod bind default
    assert r['app']['data_dir'] == '/data'        # prod data default
    dev = d.resolve({'app': {'secret_key': 's'}, 'dev': {'host': '127.0.0.1'}}, 'dev')
    assert dev['app']['host'] == '127.0.0.1'


def test_dumps_roundtrips_without_admin():
    m, _ = d.migrate_master(FLAT)
    text = d.dumps_master(m)
    back = tomllib.loads(text)
    assert back['config_version'] == V
    assert back['app']['secret_key'] == 'sk'
    assert 'admin_password' not in back['app']
    assert back['backup']['backup_dir'] == '/b'
    # and the round-tripped config passes validation
    d.validate_master_version(back, 'roundtrip')


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
        print(f'  ✓  {t.__name__}')
    print(f'\n\nALL DEPLOY-CONFIG TESTS PASSED ✓  ({len(tests)} checks)')
