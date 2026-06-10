#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["flask", "pillow", "numpy", "shapely"]
# ///
"""
Stateless backend — all session logic lives in the browser.
Endpoints:
  GET  /api/images          → list of available image/JSON pairs
  POST /api/upload          → upload a new image/JSON pair
  GET  /api/shapes?pair=ID  → shapes + crop bounds for a pair
  GET  /api/crop/ID/<idx>   → crop image as PNG
  POST /api/iou             → compute IoU between two polygon arrays
"""

import hashlib
import io
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from PIL import Image
from shapely.geometry import Polygon as ShapelyPolygon

BASE     = Path(__file__).parent.parent
DATA_DIR = BASE / 'data'
IMG_DIR  = DATA_DIR / 'images'
JSON_DIR = DATA_DIR / 'jsons'
MANIFEST = DATA_DIR / 'manifest.json'
STATIC   = Path(__file__).parent / 'static'

# Reserved ID for the auto-migrated legacy hardcoded pair
LEGACY_ID    = 'legacy'
LEGACY_IMAGE = BASE / 'DSC_0018_segment_1_segmented_smoothed.tif'
LEGACY_JSON  = BASE / 'DSC_0018_segment_1_segmented_smoothed.json'

app = Flask(__name__, static_folder=str(STATIC))

_img_cache: dict[str, Image.Image] = {}


def _load_manifest() -> list:
    if not MANIFEST.exists():
        return []
    return json.loads(MANIFEST.read_text())


def _save_manifest(pairs: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(pairs, indent=2))


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:24]


def _get_image(image_hash: str, image_ext: str) -> Image.Image:
    key = f'{image_hash}.{image_ext}'
    if key not in _img_cache:
        _img_cache[key] = Image.open(IMG_DIR / key)
    return _img_cache[key]


def _load_shapes(pair_id: str) -> list:
    raw = json.loads((JSON_DIR / f'{pair_id}.json').read_text())
    return [s for s in raw['shapes']
            if s['label'] != 'fused_exterior' and s.get('shape_type') == 'polygon']


def _get_pair(pair_id: str):
    """Return (meta, shapes, image) or (None, None, None) if not found."""
    meta = next((p for p in _load_manifest() if p['id'] == pair_id), None)
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


def _auto_migrate() -> None:
    """Import the old hardcoded files as the 'legacy' pair on first run."""
    pairs = _load_manifest()
    if any(p['id'] == LEGACY_ID for p in pairs):
        return
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
    pairs.append({
        'id':           LEGACY_ID,
        'image_hash':   img_hash,
        'image_ext':    img_ext,
        'display_name': LEGACY_IMAGE.stem,
        'uploaded_at':  datetime.now(timezone.utc).isoformat(),
    })
    _save_manifest(pairs)
    print(f'[auto-migrate] legacy pair imported (hash {img_hash})')


@app.get('/')
def index():
    return send_file(STATIC / 'index.html')


@app.get('/api/images')
def api_images():
    out = []
    for p in _load_manifest():
        try:
            n = len(_load_shapes(p['id']))
        except Exception:
            n = 0
        out.append({**p, 'shape_count': n})
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

    pair_id = str(uuid.uuid4())
    (JSON_DIR / f'{pair_id}.json').write_bytes(json_file.read())

    entry = {
        'id':           pair_id,
        'image_hash':   img_hash,
        'image_ext':    img_ext,
        'display_name': display_name,
        'uploaded_at':  datetime.now(timezone.utc).isoformat(),
    }
    pairs = _load_manifest()
    pairs.append(entry)
    _save_manifest(pairs)

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
    pairs = _load_manifest()
    pair  = next((p for p in pairs if p['id'] == pair_id), None)
    if not pair:
        return jsonify({'error': 'pair not found'}), 404
    pair['display_name'] = display_name
    _save_manifest(pairs)
    return jsonify(pair)


@app.put('/api/images/<pair_id>')
def api_replace_pair(pair_id: str):
    pairs = _load_manifest()
    pair  = next((p for p in pairs if p['id'] == pair_id), None)
    if not pair:
        return jsonify({'error': 'pair not found'}), 404
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
        old_h, old_ext = pair['image_hash'], pair['image_ext']
        if old_h != new_hash and not any(p['image_hash'] == old_h for p in pairs if p['id'] != pair_id):
            old_path = IMG_DIR / f'{old_h}.{old_ext}'
            if old_path.exists():
                old_path.unlink()
            _img_cache.pop(f'{old_h}.{old_ext}', None)
        pair['image_hash'] = new_hash
        pair['image_ext']  = new_ext

    if 'json' in request.files:
        JSON_DIR.mkdir(parents=True, exist_ok=True)
        (JSON_DIR / f'{pair_id}.json').write_bytes(request.files['json'].read())

    _save_manifest(pairs)
    try:
        pair['shape_count'] = len(_load_shapes(pair_id))
    except Exception:
        pair['shape_count'] = 0
    return jsonify(pair)


@app.delete('/api/images/<pair_id>')
def api_delete_pair(pair_id: str):
    pairs = _load_manifest()
    pair  = next((p for p in pairs if p['id'] == pair_id), None)
    if not pair:
        return jsonify({'error': 'pair not found'}), 404
    remaining = [p for p in pairs if p['id'] != pair_id]
    json_path = JSON_DIR / f'{pair_id}.json'
    if json_path.exists():
        json_path.unlink()
    h, ext = pair['image_hash'], pair['image_ext']
    if not any(p['image_hash'] == h for p in remaining):
        img_path = IMG_DIR / f'{h}.{ext}'
        if img_path.exists():
            img_path.unlink()
        _img_cache.pop(f'{h}.{ext}', None)
    _save_manifest(remaining)
    return '', 204


@app.post('/api/iou')
def api_iou():
    body = request.json
    return jsonify(_iou(body['a'], body['b']))


if __name__ == '__main__':
    _auto_migrate()
    app.run(debug=True, port=5000)
