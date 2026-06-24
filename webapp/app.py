#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["flask", "pillow", "numpy", "shapely"]
# ///
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

from flask import Flask, abort, jsonify, request, send_file
from PIL import Image
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.ops import unary_union

import db as _db

BASE     = Path(__file__).parent.parent
DATA_DIR = _db.DATA_DIR            # single source of truth (db.py); LOCAL XDG dir by default
IMG_DIR  = DATA_DIR / 'images'
JSON_DIR = DATA_DIR / 'jsons'
MANIFEST = DATA_DIR / 'manifest.json'
STATIC   = Path(__file__).parent / 'static'
LEGACY_DATA_DIR = BASE / 'data'    # old on-NFS location; used only for the one-time migration

# Reserved ID for the auto-migrated legacy hardcoded pair
LEGACY_ID    = 'legacy'
LEGACY_IMAGE = BASE / 'DSC_0018_segment_1_segmented_smoothed.tif'
LEGACY_JSON  = BASE / 'DSC_0018_segment_1_segmented_smoothed.json'

app = Flask(__name__, static_folder=str(STATIC))

_img_cache:      dict[str, Image.Image] = {}
_overview_cache: dict[str, bytes]       = {}


# ── DB helpers ────────────────────────────────────────────────────────────────

def _all_sets() -> list[dict]:
    """Return all annotation_set rows as a list of dicts."""
    con = _db.get_db()
    try:
        return con.execute(
            'SELECT * FROM annotation_set ORDER BY created_at'
        ).fetchall()
    finally:
        _db.close_db(con)


def _get_set(set_id: str) -> dict | None:
    con = _db.get_db()
    try:
        return con.execute(
            'SELECT * FROM annotation_set WHERE id = ?', (set_id,)
        ).fetchone()
    finally:
        _db.close_db(con)


def _insert_set(row: dict) -> None:
    con = _db.get_db()
    try:
        con.execute(
            '''INSERT INTO annotation_set
                 (id, display_name, image_hash, image_ext,
                  kind, provenance, created_by, created_at, terminal)
               VALUES (:id, :display_name, :image_hash, :image_ext,
                       :kind, :provenance, :created_by, :created_at, :terminal)''',
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
        img = Image.open(IMG_DIR / key)
        img.load()  # force full pixel decode; avoids lazy-seek issues with TIFF
        _img_cache[key] = img
    return _img_cache[key]


def _load_shapes(pair_id: str) -> list:
    raw = json.loads((JSON_DIR / f'{pair_id}.json').read_text())
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


def _xuser() -> str | None:
    """Return the byline sent in the X-User header, or None."""
    v = (request.headers.get('X-User') or '').strip()
    return v or None


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


def _startup() -> None:
    """Create schema, run manifest migration, and handle legacy file migration."""
    _migrate_data_to_local()
    _db.auto_create_schema()
    _db.migrate_manifest(MANIFEST)
    _auto_migrate_legacy()
    _warn_if_bundle_stale()


def _migrate_data_to_local() -> None:
    """One-time: copy the data dir from the legacy on-NFS location to the local
    DATA_DIR so the live SQLite store lives on local disk (NFS file locking stalls
    concurrent requests — see db.py). COPIES, never moves: the NFS copy is left in
    place as an interim static fallback until the out-of-band backup
    (litestream/lsyncd) is wired up. No-op once the local store exists, or when
    HT_DATA_DIR explicitly points back at the legacy dir.
    """
    if DATA_DIR == LEGACY_DATA_DIR:
        return
    if (DATA_DIR / 'app.db').exists():
        return
    if not (LEGACY_DATA_DIR / 'app.db').exists():
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f'[migrate] copying data {LEGACY_DATA_DIR} -> {DATA_DIR} (one-time, NFS -> local)')
    for name in ('app.db', 'manifest.json'):
        src = LEGACY_DATA_DIR / name
        if src.exists():
            shutil.copy2(src, DATA_DIR / name)
    for sub in ('images', 'jsons'):
        src = LEGACY_DATA_DIR / sub
        if src.is_dir():
            shutil.copytree(src, DATA_DIR / sub, dirs_exist_ok=True)
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
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    JSON_DIR.mkdir(parents=True, exist_ok=True)
    img_bytes = LEGACY_IMAGE.read_bytes()
    img_hash  = _hash_bytes(img_bytes)
    img_ext   = LEGACY_IMAGE.suffix.lstrip('.')
    dst_img   = IMG_DIR / f'{img_hash}.{img_ext}'
    if not dst_img.exists():
        dst_img.write_bytes(img_bytes)
    dst_json = JSON_DIR / f'{LEGACY_ID}.json'
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


@app.get('/api/images')
def api_images():
    out = []
    for p in _all_sets():
        pile_count = None
        if p['kind'] == 'merged':
            prov = json.loads(p['provenance'] or '{}') if p['provenance'] else {}
            if 'pile_count' in prov:
                pile_count = prov['pile_count']
            else:
                # Fallback for records saved before pile_count was stored
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
        # Backward-compatible response shape: keep uploaded_at alias
        out.append({
            'id':           p['id'],
            'display_name': p['display_name'],
            'image_hash':   p['image_hash'],
            'image_ext':    p['image_ext'],
            'uploaded_at':  p['created_at'],   # alias for existing JS
            'created_at':   p['created_at'],
            'kind':         p['kind'],
            'terminal':     bool(p['terminal']),
            'created_by':   p['created_by'],
            'shape_count':  shape_count,
            'pile_count':   pile_count,
        })
    return jsonify(out)


@app.post('/api/upload')
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

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    JSON_DIR.mkdir(parents=True, exist_ok=True)

    dst_img = IMG_DIR / f'{img_hash}.{img_ext}'
    if not dst_img.exists():
        dst_img.write_bytes(img_bytes)
    _img_cache.pop(f'{img_hash}.{img_ext}', None)

    pair_id    = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    (JSON_DIR / f'{pair_id}.json').write_bytes(json_file.read())

    _insert_set({
        'id':           pair_id,
        'image_hash':   img_hash,
        'image_ext':    img_ext,
        'display_name': display_name,
        'kind':         'raw',
        'provenance':   None,
        'created_by':   _xuser(),
        'created_at':   created_at,
        'terminal':     0,
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
        'created_by':   _xuser(),
    }
    try:
        entry['shape_count'] = len(_load_shapes(pair_id))
    except Exception:
        entry['shape_count'] = 0
    return jsonify(entry), 201


@app.get('/api/shapes')
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
        'created_by':   meta['created_by'],
    })


@app.put('/api/images/<pair_id>')
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
        IMG_DIR.mkdir(parents=True, exist_ok=True)
        dst = IMG_DIR / f'{new_hash}.{new_ext}'
        if not dst.exists():
            dst.write_bytes(img_bytes)
        _img_cache.pop(f'{new_hash}.{new_ext}', None)
        old_h, old_ext = meta['image_hash'], meta['image_ext']
        if old_h != new_hash and not _hash_in_use(old_h, exclude_id=pair_id):
            old_path = IMG_DIR / f'{old_h}.{old_ext}'
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
        JSON_DIR.mkdir(parents=True, exist_ok=True)
        (JSON_DIR / f'{pair_id}.json').write_bytes(request.files['json'].read())

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
        'created_by':   meta['created_by'],
    }
    try:
        result['shape_count'] = len(_load_shapes(pair_id))
    except Exception:
        result['shape_count'] = 0
    return jsonify(result)


@app.delete('/api/images/<pair_id>')
def api_delete_pair(pair_id: str):
    meta = _get_set(pair_id)
    if not meta:
        return jsonify({'error': 'pair not found'}), 404
    json_path = JSON_DIR / f'{pair_id}.json'
    if json_path.exists():
        json_path.unlink()
    h, ext = meta['image_hash'], meta['image_ext']
    _delete_set(pair_id)
    if not _hash_in_use(h):
        img_path = IMG_DIR / f'{h}.{ext}'
        if img_path.exists():
            img_path.unlink()
        _img_cache.pop(f'{h}.{ext}', None)
    return '', 204


@app.get('/api/image/<image_hash>')
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
    img  = _get_image(image_hash, row['image_ext'])
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
    img  = _get_image(image_hash, row['image_ext'])
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
            (merge_id, image_hash, json.dumps(doc), _xuser(), updated_at),
        )
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'id': merge_id, 'updatedAt': updated_at}), 201


@app.get('/api/merges/<merge_id>')
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
        'created_by':   _xuser(),
        'created_at':   created_at,
        'terminal':     0,
    })
    con = _db.get_db()
    try:
        con.execute('UPDATE merge SET set_id = ? WHERE id = ?', (set_id, merge_id))
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'setId': set_id, 'displayName': display_name}), 201


@app.delete('/api/merges/<merge_id>')
def api_delete_merge(merge_id: str):
    con = _db.get_db()
    try:
        con.execute('DELETE FROM merge WHERE id = ?', (merge_id,))
        con.commit()
    finally:
        _db.close_db(con)
    return '', 204


@app.post('/api/compare')
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


if __name__ == '__main__':
    _startup()
    app.run(debug=True, port=5000)
