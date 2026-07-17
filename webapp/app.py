#!/usr/bin/env python3
"""
Backend — registry lives in SQLite (data/app.db); images and per-set
labelme JSONs stay on disk unchanged.

Endpoints:
  GET  /api/images          → list of available annotation sets
  POST /api/upload          → upload a new image/JSON pair
  GET  /api/shapes?pair=ID  → shapes + crop bounds for a pair
  GET  /api/crop/ID/<idx>   → crop image as PNG
  POST /api/iou             → compute IoU between two polygon arrays
  PATCH/PUT/DELETE /api/images/<id>  → manage a set
  GET  /api/image/<hash>    → overview PNG (comparison tool)
  GET  /api/image/<hash>/crop → full-res crop (comparison tool)
  POST /api/compare         → seed a comparison session
"""

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import uuid
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, abort, jsonify, request, send_file, session
from PIL import Image
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.ops import unary_union
from werkzeug.security import generate_password_hash

from . import db as _db
from .auth import admin_required, auth_bp, login_required
from .config import AppConfig, default_data_dir
from .config_file import load_file_config
from .projects import projects_bp
from .seed import resolve_port, seed_data
from .sync_status import fetch_sync_status
from .version import get_version

BASE     = Path(__file__).parent.parent
STATIC   = Path(__file__).parent / 'static'
LEGACY_DATA_DIR = BASE / 'data'    # old on-NFS location; used only for the one-time migration


def _data_dir() -> Path:
    """Active data dir, resolved lazily (NOT at import time) from the AppConfig. Single
    source of truth is db.py's configured AppConfig — see webapp/config.py."""
    return _db.get_config().data_dir


def _img_dir() -> Path:
    return _data_dir() / 'images'


def _json_dir() -> Path:
    return _data_dir() / 'jsons'


def _manifest_path() -> Path:
    return _data_dir() / 'manifest.json'


def _i18n_dir() -> Path:
    return _data_dir() / 'i18n'

# Reserved ID for the auto-migrated legacy hardcoded pair
LEGACY_ID    = 'legacy'
LEGACY_IMAGE = BASE / 'DSC_0018_segment_1_segmented_smoothed.tif'
LEGACY_JSON  = BASE / 'DSC_0018_segment_1_segmented_smoothed.json'

app = Flask(__name__, static_folder=str(STATIC))
app.register_blueprint(auth_bp)
app.register_blueprint(projects_bp)


@app.after_request
def _log_client_error(response):
    """Log every client-visible /api 4xx/5xx with its error message.

    Without this an API error is only an anonymous status code in the werkzeug access line —
    the actual message (returned to the client) never reaches the server log. That's exactly
    why the "annotation must intersect at least one tile" 422 (BUGS #31) stayed invisible: a
    failing test then failed on a downstream symptom instead of the real cause. Bound at import
    on the module-level `app` (like the routes), so it's active on every server path + in tests.
    """
    if response.status_code >= 400 and request.path.startswith('/api/'):
        data = response.get_json(silent=True)
        msg = (data.get('error') or data.get('message') or '') if isinstance(data, dict) else ''
        app.logger.warning('%s %s -> %s%s', request.method, request.path,
                            response.status_code, f': {msg}' if msg else '')
    return response

_img_cache:      dict[str, Image.Image] = {}
_overview_cache: dict[str, bytes]       = {}


# ── DB helpers ────────────────────────────────────────────────────────────────

def _all_sets() -> list[dict]:
    con = _db.get_db()
    try:
        return con.execute(
            'SELECT a.*, u.username AS creator_username'
            ' FROM annotation_set a LEFT JOIN users u ON u.id = a.created_by_user_id'
            ' ORDER BY a.created_at'
        ).fetchall()
    finally:
        _db.close_db(con)


def _get_set(set_id: str) -> dict | None:
    con = _db.get_db()
    try:
        return con.execute(
            'SELECT a.*, u.username AS creator_username'
            ' FROM annotation_set a LEFT JOIN users u ON u.id = a.created_by_user_id'
            ' WHERE a.id = ?',
            (set_id,),
        ).fetchone()
    finally:
        _db.close_db(con)


def _creator(row: dict) -> str | None:
    """Resolve creator name: FK-joined username wins over legacy text."""
    return row.get('creator_username') or row.get('created_by') or None


def _insert_set(row: dict) -> None:
    row.setdefault('created_by_user_id', None)
    con = _db.get_db()
    try:
        con.execute(
            '''INSERT INTO annotation_set
                 (id, display_name, image_hash, image_ext,
                  kind, provenance, created_by, created_at, terminal, created_by_user_id)
               VALUES (:id, :display_name, :image_hash, :image_ext,
                       :kind, :provenance, :created_by, :created_at, :terminal, :created_by_user_id)''',
            row,
        )
        con.commit()
    finally:
        _db.close_db(con)


def _update_set_field(set_id: str, field: str, value) -> None:
    con = _db.get_db()
    try:
        con.execute(
            f'UPDATE annotation_set SET {field} = ? WHERE id = ?',
            (value, set_id),
        )
        con.commit()
    finally:
        _db.close_db(con)


def _delete_set(set_id: str) -> None:
    con = _db.get_db()
    try:
        con.execute('DELETE FROM annotation_set WHERE id = ?', (set_id,))
        con.commit()
    finally:
        _db.close_db(con)


def _hash_in_use(image_hash: str, exclude_id: str | None = None) -> bool:
    con = _db.get_db()
    try:
        if exclude_id:
            row = con.execute(
                'SELECT 1 FROM annotation_set WHERE image_hash = ? AND id != ?',
                (image_hash, exclude_id),
            ).fetchone()
        else:
            row = con.execute(
                'SELECT 1 FROM annotation_set WHERE image_hash = ?',
                (image_hash,),
            ).fetchone()
        return row is not None
    finally:
        _db.close_db(con)


# ── Image / JSON helpers ──────────────────────────────────────────────────────

def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:24]


def _get_image(image_hash: str, image_ext: str) -> Image.Image:
    key = f'{image_hash}.{image_ext}'
    if key not in _img_cache:
        img = Image.open(_img_dir() / key)
        img.load()  # force full pixel decode; avoids lazy-seek issues with TIFF
        _img_cache[key] = img
    return _img_cache[key]


def _load_shapes(pair_id: str) -> list:
    raw = json.loads((_json_dir() / f'{pair_id}.json').read_text())
    return [s for s in raw['shapes']
            if s['label'] != 'fused_exterior' and s.get('shape_type') == 'polygon']


def _get_pair(pair_id: str):
    """Return (meta, shapes, image) or (None, None, None) if not found."""
    meta = _get_set(pair_id)
    if not meta:
        return None, None, None
    try:
        shapes = _load_shapes(pair_id)
        img    = _get_image(meta['image_hash'], meta['image_ext'])
    except Exception:
        return None, None, None
    return meta, shapes, img


def _crop_bounds(pts, img_w: int, img_h: int):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    bw, bh = max(xs) - min(xs), max(ys) - min(ys)
    return (
        max(0,     int(min(xs) - bw * 0.5)),
        max(0,     int(min(ys) - bh * 0.5)),
        min(img_w, int(max(xs) + bw * 0.5)),
        min(img_h, int(max(ys) + bh * 0.5)),
    )


def _iou(a: list, b: list) -> dict:
    try:
        pa = ShapelyPolygon(a).buffer(0)
        pb = ShapelyPolygon(b).buffer(0)
        inter = pa.intersection(pb).area
        union = pa.union(pb).area
        return {'iou': float(inter / union) if union else 0.0,
                'intersection': float(inter), 'union': float(union)}
    except Exception:
        return {'iou': 0.0, 'intersection': 0.0, 'union': 0.0}


# ── Startup ───────────────────────────────────────────────────────────────────

def _warn_if_bundle_stale() -> None:
    """Warn loudly if the committed Solid bundle is older than its source.

    static/dist/app.bundle.* is the runtime artifact — `uv run app.py` serves it
    as-is. If frontend/src was edited without `npm run build`, the app shows stale
    UI while Vitest (which runs against source) stays green. The pre-commit hook
    prevents committing a stale bundle; this catches the gap while iterating.
    """
    try:
        src    = Path(__file__).parent / 'frontend' / 'src'
        bundle = STATIC / 'dist' / 'app.bundle.js'
        if not src.is_dir() or not bundle.exists():
            return
        newest_src = max((p.stat().st_mtime for p in src.rglob('*') if p.is_file()),
                         default=0.0)
        if newest_src > bundle.stat().st_mtime:
            print(
                '\n  \033[33m⚠  webapp/frontend/src is newer than '
                'static/dist/app.bundle.js — serving a STALE bundle.\033[0m'
                '\n     Rebuild it:  cd webapp/frontend && npm run build\n',
                file=sys.stderr,
            )
    except Exception:
        pass  # a dev-convenience check must never break startup


def _load_env() -> None:
    """Load the legacy .env from the project root into os.environ (existing vars take priority).

    DEPRECATED path: only used when app.config.toml is absent. The preferred source is
    app.config.toml, read via webapp/config_file.py and merged explicitly in main()."""
    load_dotenv(BASE / '.env')


def _configure_app(cfg: AppConfig) -> None:
    if not cfg.secret_key:
        raise RuntimeError('AppConfig.secret_key is required — set secret_key in app.config.toml '
                           '(or SECRET_KEY in a legacy .env / the environment)')
    app.secret_key = cfg.secret_key


def _sync_admin(cfg: AppConfig) -> None:
    """Seed or force-update the admin user from cfg.admin_password.

    cfg.admin_password is SEED-only: it creates the admin row on first boot (no admin
    exists yet) but never touches an already-existing admin's password — so an
    env-sourced ADMIN_PASSWORD (e.g. the dev .env's placeholder) can't silently clobber
    an admin restored from a prod snapshot. cfg.admin_password_force opts into
    overwriting an existing admin too — set only by the explicit `--admin-password` CLI
    flag, never by the env fallback (see main()/wsgi.py).
    """
    password = cfg.admin_password
    con = _db.get_db()
    try:
        row = con.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
        if row and password and cfg.admin_password_force:
            phash = generate_password_hash(password)
            con.execute("UPDATE users SET password_hash = ? WHERE username = 'admin'", (phash,))
            con.commit()
        elif not row:
            if not password:
                raise RuntimeError('ADMIN_PASSWORD must be set on first boot (no admin user exists)')
            phash = generate_password_hash(password)
            con.execute("INSERT INTO users (username, password_hash) VALUES ('admin', ?)", (phash,))
            con.commit()
    finally:
        _db.close_db(con)


def create_app(cfg: AppConfig) -> Flask:
    """The single wiring path all three servers (dev main(), wsgi:app, gate) go through:
    configure db from cfg, then run _startup(cfg). Returns the module-level `app` — Flask
    routes are bound to it via decorators at import time (they can't be re-registered onto
    a fresh instance per call), so create_app() configures/initializes that one process-
    lifetime Flask object rather than instantiating a new one. What *is* fully explicit now
    is the config: no import-time env reads anywhere in the data-dir/db path.
    """
    _db.configure(cfg)
    _startup(cfg)
    return app


def _startup(cfg: AppConfig) -> None:
    """Init schema, auth config, and legacy data migrations.

    Restore-from-backup is NOT here — it's an explicit orchestration step
    (`docker compose run --rm restore`, or seed_data(cfg) for the native path).

    Only ever called from create_app(cfg) — all three server entries (main(), wsgi:app,
    scripts/gate.py's run_ephemeral()) build an explicit AppConfig before reaching here.
    """
    _load_env()
    _configure_app(cfg)
    _migrate_data_to_local(cfg)
    _db.auto_create_schema()   # Alembic upgrade/stamp — see webapp/db.py
    _db.migrate_meta()         # app_version bookkeeping only now (not schema-mutating)
    _sync_admin(cfg)
    _db.migrate_manifest(_manifest_path())
    _auto_migrate_legacy()
    _seed_i18n()
    _warn_if_bundle_stale()


def _migrate_data_to_local(cfg: AppConfig) -> None:
    """One-time: copy the data dir from the legacy on-NFS location to the local
    data dir so the live SQLite store lives on local disk (NFS file locking stalls
    concurrent requests — see db.py). COPIES, never moves: the NFS copy is left in
    place as an interim static fallback until the out-of-band backup
    (litestream/lsyncd) is wired up. No-op once the local store exists, or when
    cfg.data_dir explicitly points back at the legacy dir.
    """
    data_dir = cfg.data_dir
    if data_dir == LEGACY_DATA_DIR:
        return
    if (data_dir / 'app.db').exists():
        return
    if not (LEGACY_DATA_DIR / 'app.db').exists():
        return
    data_dir.mkdir(parents=True, exist_ok=True)
    print(f'[migrate] copying data {LEGACY_DATA_DIR} -> {data_dir} (one-time, NFS -> local)')
    for name in ('app.db', 'manifest.json'):
        src = LEGACY_DATA_DIR / name
        if src.exists():
            shutil.copy2(src, data_dir / name)
    for sub in ('images', 'jsons'):
        src = LEGACY_DATA_DIR / sub
        if src.is_dir():
            shutil.copytree(src, data_dir / sub, dirs_exist_ok=True)
    print('[migrate] done')


def _auto_migrate_legacy() -> None:
    """
    Import the old hardcoded files as the 'legacy' pair if they exist on disk
    but have not yet been added to the manifest or the DB.
    This is the original one-time migration kept for backward compat.
    """
    if _get_set(LEGACY_ID):
        return  # already in DB (either via migrate_manifest or a previous run)
    if not LEGACY_IMAGE.exists() or not LEGACY_JSON.exists():
        return
    img_dir, json_dir = _img_dir(), _json_dir()
    img_dir.mkdir(parents=True, exist_ok=True)
    json_dir.mkdir(parents=True, exist_ok=True)
    img_bytes = LEGACY_IMAGE.read_bytes()
    img_hash  = _hash_bytes(img_bytes)
    img_ext   = LEGACY_IMAGE.suffix.lstrip('.')
    dst_img   = img_dir / f'{img_hash}.{img_ext}'
    if not dst_img.exists():
        dst_img.write_bytes(img_bytes)
    dst_json = json_dir / f'{LEGACY_ID}.json'
    if not dst_json.exists():
        dst_json.write_bytes(LEGACY_JSON.read_bytes())
    _insert_set({
        'id':           LEGACY_ID,
        'image_hash':   img_hash,
        'image_ext':    img_ext,
        'display_name': LEGACY_IMAGE.stem,
        'kind':         'raw',
        'provenance':   None,
        'created_by':   'legacy',
        'created_at':   datetime.now(timezone.utc).isoformat(),
        'terminal':     0,
    })
    print(f'[auto-migrate] legacy pair imported (hash {img_hash})')


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get('/')
def index():
    return send_file(STATIC / 'index.html')


@app.get('/<path:path>')
def catch_all(path: str):
    if path.startswith(('api/', 'static/')):
        abort(404)
    return send_file(STATIC / 'index.html')


# ── i18n catalog ──────────────────────────────────────────────────────────────
# The message catalog lives in the data volume (<data_dir>/i18n/<locale>.json) so
# strings can be edited + reloaded with no rebuild. The bundled copy under
# static/i18n/ is the default, seeded into the volume on first boot. Missing
# locale → fall back to the bundled default, then to English. The pseudo-locale
# is synthesized client-side from `en` (see src/i18n), so it is not served here.

BUNDLED_I18N    = STATIC / 'i18n'
I18N_FALLBACK   = 'en'


def _seed_i18n() -> None:
    """First-boot seed + per-boot top-up of the editable data-volume catalogs.

    On first boot a bundled catalog is copied into the volume verbatim. On every
    later boot we *merge* in any keys the bundled default has gained since (e.g.
    after a string-extraction pass) without touching keys already present in the
    volume copy — so operator edits are preserved but new strings never go
    missing. A bundled catalog that gains keys after a deploy has booted is the
    common case and was previously silently lost (seed-once).
    """
    if not BUNDLED_I18N.is_dir():
        return
    i18n_dir = _i18n_dir()
    i18n_dir.mkdir(parents=True, exist_ok=True)
    for src in BUNDLED_I18N.glob('*.json'):
        dst = i18n_dir / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
            continue
        try:
            with open(src, encoding='utf-8') as fh:
                bundled = json.load(fh)
            with open(dst, encoding='utf-8') as fh:
                current = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        missing = {k: v for k, v in bundled.items() if k not in current}
        if missing:
            current.update(missing)
            with open(dst, 'w', encoding='utf-8') as fh:
                json.dump(current, fh, ensure_ascii=False, indent=2)


def _read_catalog(locale: str) -> dict | None:
    """Read a locale catalog: editable volume copy wins, else bundled default."""
    name = f'{locale}.json'
    for base in (_i18n_dir(), BUNDLED_I18N):
        path = base / name
        if path.is_file():
            try:
                with open(path, encoding='utf-8') as fh:
                    return json.load(fh)
            except (OSError, json.JSONDecodeError):
                continue
    return None


@app.get('/api/i18n/<locale>')
def api_i18n(locale: str):
    # Guard against path traversal: locale is a bare identifier.
    if not locale.isidentifier():
        abort(400)
    catalog = _read_catalog(locale)
    if catalog is None and locale != I18N_FALLBACK:
        catalog = _read_catalog(I18N_FALLBACK)
    if catalog is None:
        catalog = {}
    return jsonify(catalog)


@app.get('/api/health')
def api_health():
    """Unauthenticated liveness probe (HTTP 200, {"status": "ok"}).

    No auth, no DB touch — used by load balancers / uptime checks to tell a live
    backend from a dead one without a valid session. Keep it side-effect-free.
    """
    return jsonify({'status': 'ok'})


@app.get('/api/version')
@login_required
def api_version():
    con = _db.get_db()
    try:
        return jsonify(get_version(con))
    finally:
        _db.close_db(con)


@app.get('/api/sync-status')
@admin_required
def api_sync_status():
    return jsonify(fetch_sync_status(_db.get_config().backup_status_url))


@app.get('/api/images')
@login_required
def api_images():
    out = []
    for p in _all_sets():
        pile_count = None
        if p['kind'] == 'merged':
            prov = json.loads(p['provenance'] or '{}') if p['provenance'] else {}
            if 'pile_count' in prov:
                pile_count = prov['pile_count']
            else:
                con2 = _db.get_db()
                try:
                    mrow = con2.execute(
                        'SELECT doc FROM merge WHERE set_id = ?', (p['id'],)
                    ).fetchone()
                    if mrow:
                        pile_count = len(json.loads(mrow['doc']).get('piles', {}))
                finally:
                    _db.close_db(con2)
            shape_count = 0
        else:
            try:
                shape_count = len(_load_shapes(p['id']))
            except Exception:
                shape_count = 0
        out.append({
            'id':           p['id'],
            'display_name': p['display_name'],
            'image_hash':   p['image_hash'],
            'image_ext':    p['image_ext'],
            'uploaded_at':  p['created_at'],
            'created_at':   p['created_at'],
            'kind':         p['kind'],
            'terminal':     bool(p['terminal']),
            'created_by':   _creator(p),
            'shape_count':  shape_count,
            'pile_count':   pile_count,
        })
    return jsonify(out)


@app.post('/api/upload')
@login_required
def api_upload():
    if 'image' not in request.files or 'json' not in request.files:
        return jsonify({'error': 'image and json files required'}), 400
    display_name = (request.form.get('display_name') or '').strip()
    if not display_name:
        return jsonify({'error': 'display_name required'}), 400

    img_file  = request.files['image']
    json_file = request.files['json']
    img_bytes = img_file.read()
    img_hash  = _hash_bytes(img_bytes)
    img_ext   = Path(img_file.filename or 'img.tif').suffix.lstrip('.') or 'tif'

    img_dir, json_dir = _img_dir(), _json_dir()
    img_dir.mkdir(parents=True, exist_ok=True)
    json_dir.mkdir(parents=True, exist_ok=True)

    dst_img = img_dir / f'{img_hash}.{img_ext}'
    if not dst_img.exists():
        dst_img.write_bytes(img_bytes)
    _img_cache.pop(f'{img_hash}.{img_ext}', None)

    pair_id    = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    (json_dir / f'{pair_id}.json').write_bytes(json_file.read())

    _insert_set({
        'id':                pair_id,
        'image_hash':        img_hash,
        'image_ext':         img_ext,
        'display_name':      display_name,
        'kind':              'raw',
        'provenance':        None,
        'created_by':        None,
        'created_at':        created_at,
        'terminal':          0,
        'created_by_user_id': session.get('user_id'),
    })

    entry = {
        'id':           pair_id,
        'display_name': display_name,
        'image_hash':   img_hash,
        'image_ext':    img_ext,
        'uploaded_at':  created_at,
        'created_at':   created_at,
        'kind':         'raw',
        'terminal':     False,
        'created_by':   session.get('username'),
    }
    try:
        entry['shape_count'] = len(_load_shapes(pair_id))
    except Exception:
        entry['shape_count'] = 0
    return jsonify(entry), 201


@app.get('/api/shapes')
@login_required
def api_shapes():
    pair_id = request.args.get('pair')
    if not pair_id:
        return jsonify({'error': 'pair parameter required'}), 400
    meta, shapes, img = _get_pair(pair_id)
    if meta is None:
        return jsonify({'error': 'pair not found'}), 404
    iw, ih = img.size
    out = []
    for i, s in enumerate(shapes):
        cx1, cy1, cx2, cy2 = _crop_bounds(s['points'], iw, ih)
        out.append({
            'idx':    i,
            'label':  s['label'],
            'points': s['points'],
            'crop':   {'x': cx1, 'y': cy1, 'w': cx2 - cx1, 'h': cy2 - cy1},
        })
    return jsonify({
        'shapes':      out,
        'labels':      sorted({s['label'] for s in shapes}),
        'imageName':   meta['display_name'],
        'imageHeight': ih,
        'imageWidth':  iw,
    })


@app.get('/api/crop/<pair_id>/<int:idx>')
@login_required
def api_crop(pair_id: str, idx: int):
    meta, shapes, img = _get_pair(pair_id)
    if meta is None:
        return jsonify({'error': 'pair not found'}), 404
    if idx >= len(shapes):
        return jsonify({'error': 'index out of range'}), 404
    iw, ih = img.size
    cx1, cy1, cx2, cy2 = _crop_bounds(shapes[idx]['points'], iw, ih)
    buf = io.BytesIO()
    img.crop((cx1, cy1, cx2, cy2)).save(buf, 'PNG')
    buf.seek(0)
    return send_file(buf, mimetype='image/png')


@app.patch('/api/images/<pair_id>')
@login_required
def api_update_image(pair_id: str):
    data = request.json or {}
    display_name = (data.get('display_name') or '').strip()
    if not display_name:
        return jsonify({'error': 'display_name required'}), 400
    meta = _get_set(pair_id)
    if not meta:
        return jsonify({'error': 'pair not found'}), 404
    _update_set_field(pair_id, 'display_name', display_name)
    meta = _get_set(pair_id)
    return jsonify({
        'id':           meta['id'],
        'display_name': meta['display_name'],
        'image_hash':   meta['image_hash'],
        'image_ext':    meta['image_ext'],
        'uploaded_at':  meta['created_at'],
        'created_at':   meta['created_at'],
        'kind':         meta['kind'],
        'terminal':     bool(meta['terminal']),
        'created_by':   _creator(meta),
    })


@app.put('/api/images/<pair_id>')
@login_required
def api_replace_pair(pair_id: str):
    meta = _get_set(pair_id)
    if not meta:
        return jsonify({'error': 'pair not found'}), 404
    if meta['kind'] == 'merged':
        return jsonify({'error': 'merged sets cannot have files replaced'}), 400
    if 'image' not in request.files and 'json' not in request.files:
        return jsonify({'error': 'at least one of image or json required'}), 400

    if 'image' in request.files:
        img_file  = request.files['image']
        img_bytes = img_file.read()
        new_hash  = _hash_bytes(img_bytes)
        new_ext   = Path(img_file.filename or 'img.tif').suffix.lstrip('.') or 'tif'
        img_dir = _img_dir()
        img_dir.mkdir(parents=True, exist_ok=True)
        dst = img_dir / f'{new_hash}.{new_ext}'
        if not dst.exists():
            dst.write_bytes(img_bytes)
        _img_cache.pop(f'{new_hash}.{new_ext}', None)
        old_h, old_ext = meta['image_hash'], meta['image_ext']
        if old_h != new_hash and not _hash_in_use(old_h, exclude_id=pair_id):
            old_path = img_dir / f'{old_h}.{old_ext}'
            if old_path.exists():
                old_path.unlink()
            _img_cache.pop(f'{old_h}.{old_ext}', None)
        con = _db.get_db()
        try:
            con.execute(
                'UPDATE annotation_set SET image_hash=?, image_ext=? WHERE id=?',
                (new_hash, new_ext, pair_id),
            )
            con.commit()
        finally:
            _db.close_db(con)

    if 'json' in request.files:
        json_dir = _json_dir()
        json_dir.mkdir(parents=True, exist_ok=True)
        (json_dir / f'{pair_id}.json').write_bytes(request.files['json'].read())

    meta = _get_set(pair_id)
    result = {
        'id':           meta['id'],
        'display_name': meta['display_name'],
        'image_hash':   meta['image_hash'],
        'image_ext':    meta['image_ext'],
        'uploaded_at':  meta['created_at'],
        'created_at':   meta['created_at'],
        'kind':         meta['kind'],
        'terminal':     bool(meta['terminal']),
        'created_by':   _creator(meta),
    }
    try:
        result['shape_count'] = len(_load_shapes(pair_id))
    except Exception:
        result['shape_count'] = 0
    return jsonify(result)


@app.delete('/api/images/<pair_id>')
@login_required
def api_delete_pair(pair_id: str):
    meta = _get_set(pair_id)
    if not meta:
        return jsonify({'error': 'pair not found'}), 404
    json_path = _json_dir() / f'{pair_id}.json'
    if json_path.exists():
        json_path.unlink()
    h, ext = meta['image_hash'], meta['image_ext']
    _delete_set(pair_id)
    if not _hash_in_use(h):
        img_path = _img_dir() / f'{h}.{ext}'
        if img_path.exists():
            img_path.unlink()
        _img_cache.pop(f'{h}.{ext}', None)
    return '', 204


@app.get('/api/image/<image_hash>')
@login_required
def api_image_overview(image_hash: str):
    if image_hash in _overview_cache:
        return send_file(io.BytesIO(_overview_cache[image_hash]), mimetype='image/png')
    # Look up extension from DB
    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT image_ext FROM annotation_set WHERE image_hash = ? LIMIT 1',
            (image_hash,),
        ).fetchone()
    finally:
        _db.close_db(con)
    if not row:
        return jsonify({'error': 'image not found'}), 404
    try:
        img  = _get_image(image_hash, row['image_ext'])
    except FileNotFoundError:
        return jsonify({'error': 'image file not found'}), 404
    w, h = img.size
    if max(w, h) > 2000:
        scale = 2000 / max(w, h)
        img   = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    data = buf.getvalue()
    _overview_cache[image_hash] = data
    return send_file(io.BytesIO(data), mimetype='image/png')


@app.get('/api/image/<image_hash>/crop')
@login_required
def api_image_crop(image_hash: str):
    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT image_ext FROM annotation_set WHERE image_hash = ? LIMIT 1',
            (image_hash,),
        ).fetchone()
    finally:
        _db.close_db(con)
    if not row:
        return jsonify({'error': 'image not found'}), 404
    try:
        img  = _get_image(image_hash, row['image_ext'])
    except FileNotFoundError:
        return jsonify({'error': 'image file not found'}), 404
    iw, ih = img.size
    try:
        x = max(0, int(request.args['x']))
        y = max(0, int(request.args['y']))
        w = int(request.args['w'])
        h = int(request.args['h'])
    except (KeyError, ValueError):
        return jsonify({'error': 'x, y, w, h query params required'}), 400
    buf = io.BytesIO()
    img.crop((x, y, min(iw, x + w), min(ih, y + h))).save(buf, 'PNG')
    buf.seek(0)
    return send_file(buf, mimetype='image/png')


# ── Merge endpoints ───────────────────────────────────────────────────────────

def _get_merge(merge_id: str) -> dict | None:
    con = _db.get_db()
    try:
        return con.execute('SELECT * FROM merge WHERE id = ?', (merge_id,)).fetchone()
    finally:
        _db.close_db(con)


def _get_image_ext(image_hash: str) -> str:
    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT image_ext FROM annotation_set WHERE image_hash = ? LIMIT 1',
            (image_hash,),
        ).fetchone()
        return row['image_ext'] if row else 'tif'
    finally:
        _db.close_db(con)


@app.post('/api/merges')
@login_required
def api_create_merge():
    body       = request.json or {}
    doc        = body.get('doc')
    image_hash = body.get('imageHash') or (doc or {}).get('imageHash')
    if not doc or not image_hash:
        return jsonify({'error': 'doc and imageHash required'}), 400
    merge_id   = str(uuid.uuid4())
    updated_at = datetime.now(timezone.utc).isoformat()
    con = _db.get_db()
    try:
        con.execute(
            'INSERT INTO merge (id, set_id, image_hash, doc, created_by, updated_at)'
            ' VALUES (?, NULL, ?, ?, ?, ?)',
            (merge_id, image_hash, json.dumps(doc), session.get('username'), updated_at),
        )
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'id': merge_id, 'updatedAt': updated_at}), 201


@app.get('/api/merges/<merge_id>')
@login_required
def api_get_merge(merge_id: str):
    row = _get_merge(merge_id)
    if not row:
        return jsonify({'error': 'merge not found'}), 404
    return jsonify({
        'id':        row['id'],
        'setId':     row['set_id'],
        'imageHash': row['image_hash'],
        'doc':       json.loads(row['doc']),
        'createdBy': row['created_by'],
        'updatedAt': row['updated_at'],
    })


@app.patch('/api/merges/<merge_id>')
@login_required
def api_update_merge(merge_id: str):
    if not _get_merge(merge_id):
        return jsonify({'error': 'merge not found'}), 404
    doc = (request.json or {}).get('doc')
    if doc is None:
        return jsonify({'error': 'doc required'}), 400
    updated_at = datetime.now(timezone.utc).isoformat()
    con = _db.get_db()
    try:
        con.execute(
            'UPDATE merge SET doc = ?, updated_at = ? WHERE id = ?',
            (json.dumps(doc), updated_at, merge_id),
        )
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'id': merge_id, 'updatedAt': updated_at})


@app.post('/api/merges/<merge_id>/save')
@login_required
def api_save_merge(merge_id: str):
    row = _get_merge(merge_id)
    if not row:
        return jsonify({'error': 'merge not found'}), 404
    if row['set_id']:
        existing = _get_set(row['set_id'])
        if existing:
            return jsonify({'setId': existing['id'], 'displayName': existing['display_name']})
    doc          = json.loads(row['doc'])
    included_ids = doc.get('includedSetIds', [])
    names        = [s['display_name'] for sid in included_ids if (s := _get_set(sid))]
    display_name = ('Merge: ' + ' + '.join(names)) if names else 'Merged annotations'
    if len(display_name) > 100:
        display_name = display_name[:97] + '…'
    set_id     = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    pile_count = len(doc.get('piles', {}))
    _insert_set({
        'id':           set_id,
        'display_name': display_name,
        'image_hash':   row['image_hash'],
        'image_ext':    _get_image_ext(row['image_hash']),
        'kind':         'merged',
        'provenance':   json.dumps({'source_set_ids': included_ids,
                                    'merge_id': merge_id,
                                    'pile_count': pile_count}),
        'created_by':        None,
        'created_at':        created_at,
        'terminal':          0,
        'created_by_user_id': session.get('user_id'),
    })
    con = _db.get_db()
    try:
        con.execute('UPDATE merge SET set_id = ? WHERE id = ?', (set_id, merge_id))
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'setId': set_id, 'displayName': display_name}), 201


@app.delete('/api/merges/<merge_id>')
@login_required
def api_delete_merge(merge_id: str):
    con = _db.get_db()
    try:
        con.execute('DELETE FROM merge WHERE id = ?', (merge_id,))
        con.commit()
    finally:
        _db.close_db(con)
    return '', 204


@app.post('/api/compare')
@login_required
def api_compare():
    body       = request.json or {}
    image_hash = body.get('imageHash')
    set_ids    = body.get('setIds', [])
    if not image_hash or not set_ids:
        return jsonify({'error': 'imageHash and setIds required'}), 400

    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT image_ext FROM annotation_set WHERE image_hash = ? LIMIT 1',
            (image_hash,),
        ).fetchone()
    finally:
        _db.close_db(con)

    if not row:
        return jsonify({'error': 'image not found'}), 404
    img    = _get_image(image_hash, row['image_ext'])
    iw, ih = img.size

    annotations = []
    n = 0
    for set_id in set_ids:
        try:
            shapes = _load_shapes(set_id)
        except Exception:
            continue
        for s in shapes:
            pts = s['points']
            xs  = [p[0] for p in pts]
            ys  = [p[1] for p in pts]
            annotations.append({
                'id':     f'a{n}',
                'setId':  set_id,
                'points': pts,
                'bbox':   [min(xs), min(ys), max(xs), max(ys)],
            })
            n += 1

    # Union-find for connected components
    parent = {a['id']: a['id'] for a in annotations}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        parent[find(x)] = find(y)

    edges: list[list[str]] = []
    for i in range(len(annotations)):
        ai = annotations[i]
        for j in range(i + 1, len(annotations)):
            aj = annotations[j]
            ax0, ay0, ax1, ay1 = ai['bbox']
            bx0, by0, bx1, by1 = aj['bbox']
            if ax0 >= bx1 or ax1 <= bx0 or ay0 >= by1 or ay1 <= by0:
                continue
            if ShapelyPolygon(ai['points']).buffer(0).intersects(
                    ShapelyPolygon(aj['points']).buffer(0)):
                union(ai['id'], aj['id'])
                edges.append([ai['id'], aj['id']])

    groups: dict[str, list] = {}
    for a in annotations:
        root = find(a['id'])
        groups.setdefault(root, []).append(a['id'])

    return jsonify({
        'imageWidth':  iw,
        'imageHeight': ih,
        'annotations': annotations,
        'piles':       list(groups.values()),
        'edges':       edges,
    })


@app.post('/api/iou')
@login_required
def api_iou():
    body = request.json
    return jsonify(_iou(body['a'], body['b']))


def _geom_to_rings(geom) -> list[list[list[float]]]:
    """Flatten a Shapely geometry to a list of exterior coordinate rings [[x,y],...]."""
    if geom is None or geom.is_empty:
        return []
    geoms = list(geom.geoms) if hasattr(geom, 'geoms') else [geom]
    return [[[c[0], c[1]] for c in g.exterior.coords]
            for g in geoms if hasattr(g, 'exterior')]


@app.get('/api/analyze/<set_id>')
@login_required
def api_analyze_set(set_id: str):
    meta = _get_set(set_id)
    if not meta:
        return jsonify({'error': 'not found'}), 404
    if meta['kind'] not in ('merged', 'reannotated'):
        return jsonify({'error': 'only merged or reannotated sets can be analyzed'}), 400

    if meta['kind'] == 'merged':
        con = _db.get_db()
        try:
            mrow = con.execute(
                'SELECT doc FROM merge WHERE set_id = ?', (set_id,)
            ).fetchone()
        finally:
            _db.close_db(con)
        if not mrow:
            return jsonify({'error': 'merge data not found for this set'}), 404
        doc         = json.loads(mrow['doc'])
        ann_by_id   = {a['id']: a for a in doc.get('annotations', [])}
        piles_doc   = doc.get('piles', {})
        image_hash  = doc.get('imageHash') or meta['image_hash']
    else:
        # reannotated: wired in Phase 6
        return jsonify({'error': 'reannotated analysis not yet implemented'}), 501

    img    = _get_image(image_hash, meta['image_ext'])
    iw, ih = img.size

    piles_out = []
    for pile_id, pile in piles_doc.items():
        ann_ids = pile.get('annotationIds', [])

        # Group polygon points by source set
        by_source: dict[str, list] = {}
        for ann_id in ann_ids:
            ann = ann_by_id.get(ann_id)
            if not ann:
                continue
            by_source.setdefault(ann['setId'], []).append(ann['points'])

        if not by_source:
            continue

        # Build per-source footprints, keeping (sid, fp) pairs together
        fp_pairs: list[tuple[str, object]] = []
        for sid in sorted(by_source.keys()):
            polys = [ShapelyPolygon(pts).buffer(0) for pts in by_source[sid]]
            fp    = unary_union(polys)
            if not fp.is_empty:
                fp_pairs.append((sid, fp))

        if not fp_pairs:
            continue

        source_ids = [sid for sid, _ in fp_pairs]
        footprints = [fp  for _,  fp in fp_pairs]
        m          = len(fp_pairs)

        area_1 = unary_union(footprints).area

        # For each k, compute the region covered by >= k footprints.
        # k=1 is always fraction 1.0 (the union itself) — only k>=2 is meaningful
        # for the IoU filter, so we start from k=2 when m>1.
        agreement_by_k: dict[int, dict] = {}
        for k in range(1, m + 1):
            parts = []
            for combo in combinations(footprints, k):
                isect = combo[0]
                for fp in combo[1:]:
                    isect = isect.intersection(fp)
                if not isect.is_empty:
                    parts.append(isect)
            region   = unary_union(parts) if parts else None
            fraction = (region.area / area_1) if (region and area_1 > 0) else 0.0
            agreement_by_k[k] = {
                'fraction': round(fraction, 4),
                'rings':    _geom_to_rings(region),
            }

        # Per-source footprint rings for frontend density drawing
        source_rings = [
            {'sourceId': sid, 'rings': _geom_to_rings(fp)}
            for sid, fp in fp_pairs
        ]

        # Pile bbox from all annotation points
        all_pts = [pt for ann_id in ann_ids
                   for pt in (ann_by_id.get(ann_id) or {}).get('points', [])]
        if all_pts:
            xs   = [p[0] for p in all_pts]
            ys   = [p[1] for p in all_pts]
            bbox = [min(xs), min(ys), max(xs), max(ys)]
        else:
            bbox = [0, 0, 0, 0]

        piles_out.append({
            'id':           pile_id,
            'bbox':         bbox,
            'm':            m,
            'sourceRings':  source_rings,
            'agreementByK': agreement_by_k,
        })

    all_source_ids = {sr['sourceId'] for p in piles_out for sr in p['sourceRings']}
    return jsonify({
        'setId':       set_id,
        'displayName': meta['display_name'],
        'imageHash':   image_hash,
        'imageWidth':  iw,
        'imageHeight': ih,
        'mTotal':      len(all_source_ids),
        'piles':       piles_out,
    })


def run_ephemeral(cfg: AppConfig) -> None:
    """The ephemeral launcher: write launch ledger → spawn granian-asgi (detached session)
    → wait. Used by scripts/gate.py (and any other harness that wants a concurrency-safe,
    sandbox-safe test instance — pass a per-run temp data_dir).

    CRITICAL — sandbox reaper: granian internally forks a worker, and the harness/host
    sandbox reaps same-session forked children with SIGSTKFLT (exit 144). launch_granian
    solves this by spawning granian in its OWN session via start_new_session=True (and
    tearing it down through killpg on SIGTERM/SIGINT). Do NOT swap in a same-session,
    forking Werkzeug path — that's the old failure mode.
    """
    from .wsgi import launch_granian
    rc = launch_granian(cfg)
    if rc != 0:
        raise SystemExit(rc)


def main() -> None:
    """Dev entry point (`uv run leaf-annotation [flags]`): resolve AppConfig from pure
    flags → hand off to launch_granian → granian-asgi serves webapp.asgi:app.

    This is the SAME serve path prod and the gate use — one process, one SQLite writer,
    HTTP + WebSocket over one composite ASGI app. The launch ledger under
    <data_dir>/launch-log.jsonl carries the resolved config to the granian worker (which
    re-imports the target and can't receive a live AppConfig object).

    Every knob is its own explicit flag (pure flags, no --profile presets — see
    docs/plans/Task — Entrypoint + environment consolidation (build).md, D2). Port/host
    default from $HT_PORT/$HT_HOST, data-dir from $HT_DATA_DIR — same env fallbacks as
    before, so a plain `uv run leaf-annotation` keeps landing on 127.0.0.1:5000 with no
    flags. We deliberately do NOT read the generic $PORT (that's the Docker/.env port).
    Run a second instance for testing with: `uv run leaf-annotation --port 5001`.
    """
    parser = argparse.ArgumentParser(
        prog='leaf-annotation', description='Run the leaf-annotation dev server.')
    # Defaults are None here so we can distinguish "user passed a flag" from "fall back to the
    # config file / env / built-in default", merged post-parse below (CLI > file > env > default).
    parser.add_argument(
        '--data-dir', type=Path, default=None,
        help='Data dir for app.db/images/jsons/i18n (default: app.config.toml data_dir, else '
             '$HT_DATA_DIR, else the NFS-safe XDG default).')
    parser.add_argument('--port', type=int, default=None,
                        help='TCP port to bind (default: app.config.toml port, else $HT_PORT, else 5000).')
    parser.add_argument('--host', default=None,
                        help='Host/interface to bind (default: app.config.toml host, else $HT_HOST, '
                             'else 127.0.0.1).')
    port_policy = parser.add_mutually_exclusive_group()
    port_policy.add_argument('--strict-port', dest='port_policy', action='store_const', const='strict',
                              help='Fail if --port is already taken (default).')
    port_policy.add_argument('--auto-port', dest='port_policy', action='store_const', const='auto',
                              help='Fall back to a free port if --port is taken.')
    parser.set_defaults(port_policy='strict')
    parser.add_argument('--seed', choices=['existing', 'clean', 'restore'], default='existing',
                        help="DB seeding: 'existing' (default; never touch), 'clean' (wipe to "
                             "empty), 'restore' (populate from the host backup).")
    parser.add_argument('--restore-from', type=Path, default=None,
                        help='Litestream replica dir for --seed restore (default: the standard host backup).')
    parser.add_argument(
        '--admin-password', default=None,
        help="Force-set the 'admin' user's password, overwriting an existing admin "
             '(unlike $ADMIN_PASSWORD, which only seeds admin on first boot).')
    args = parser.parse_args()
    file_cfg = load_file_config(BASE)
    if file_cfg.source != 'toml':
        _load_env()   # legacy: populate os.environ from .env (no-op if absent). Skipped when
                      # app.config.toml is present so the TOML file is the single source.

    def pick(cli_val, *env_keys, default=None):
        """CLI flag > config file > env var(s) > built-in default. env_keys tried in order
        against both the file (canonical ENV name) and os.environ."""
        if cli_val is not None:
            return cli_val
        for key in env_keys:
            fv = file_cfg.get(key)
            if fv is not None:
                return fv
        for key in env_keys:
            ev = os.environ.get(key)
            if ev is not None:
                return ev
        return default

    data_dir_val = pick(args.data_dir, 'HT_DATA_DIR')
    data_dir = Path(data_dir_val) if data_dir_val is not None else default_data_dir()
    host = pick(args.host, 'HT_HOST', default='127.0.0.1')
    port = int(pick(args.port, 'PORT', 'HT_PORT', default=5000))
    admin_password = args.admin_password or pick(None, 'ADMIN_PASSWORD')
    cfg = AppConfig(
        data_dir=data_dir,
        host=host,
        port=port,
        port_policy=args.port_policy,
        db_seed=args.seed,
        restore_source=args.restore_from,
        secret_key=pick(None, 'SECRET_KEY'),
        admin_password=admin_password,
        admin_password_force=bool(args.admin_password),
        backup_dir=pick(None, 'BACKUP_DIR'),
        backup_status_url=pick(None, 'BACKUP_STATUS_URL'),
    )
    from .wsgi import launch_granian
    try:
        rc = launch_granian(cfg)
    except RuntimeError as exc:
        print(f'\n\033[31mERROR: {exc}\033[0m\n', file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(rc)


if __name__ == '__main__':
    main()
