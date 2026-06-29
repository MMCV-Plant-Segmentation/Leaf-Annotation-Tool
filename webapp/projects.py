"""
Annotator pipeline blueprint: projects → images → tiles → batches → annotations.

Scope (per Chris, 2026-06-26): "project management and painting" — the settled foundation.
Consensus / merge is deliberately OUT of scope here; the seams for it are noted inline and
in docs/ANNOTATOR_STATUS.md. `annotation.kind` is free text and the tile/dirty plumbing is
isolated in helpers, so mistaken assumptions are cheap to revise.

All geometry lives in webapp/tiling.py (pure, unit-tested). All image I/O lives in
webapp/imaging.py. This module is DB + HTTP glue only.
"""

from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, send_file, session, stream_with_context
from shapely.geometry import LineString, Point
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.geometry import box as shapely_box

from . import db as _db
from . import imaging, tiling
from .auth import login_required

projects_bp = Blueprint('projects', __name__)

IMAGE_EXTS = {'.tif', '.tiff', '.png', '.jpg', '.jpeg'}


# ── small helpers ─────────────────────────────────────────────────────────────

def _uid() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _byline() -> str:
    return session.get('username') or 'unknown'


def _project(con, project_id: str) -> dict | None:
    return con.execute('SELECT * FROM project WHERE id = ?', (project_id,)).fetchone()


def _project_out(row: dict) -> dict:
    """Shape a project row for JSON (parse classes_json, normalise tiling_confirmed)."""
    out = dict(row)
    try:
        out['classes'] = json.loads(row.get('classes_json') or '[]')
    except (ValueError, TypeError):
        out['classes'] = []
    out.pop('classes_json', None)
    out['tiling_confirmed'] = bool(out.get('tiling_confirmed', 0))
    return out


# ── annotation ⇄ tile geometry (the dirty-propagation seam) ───────────────────

def _shape_geom(kind: str, points: list):
    """Build a shapely geometry for intersection tests. Tolerant of degenerate input."""
    pts = [(float(p[0]), float(p[1])) for p in points if len(p) >= 2]
    if not pts:
        return None
    if kind == 'point':
        return Point(pts[0])
    if kind == 'line':
        return LineString(pts) if len(pts) >= 2 else Point(pts[0])
    # polygon / stroke / anything area-like: close it into a polygon, fall back to line
    if len(pts) >= 3:
        try:
            poly = ShapelyPolygon(pts)
            return poly if poly.is_valid else poly.buffer(0)
        except Exception:
            return LineString(pts)
    return LineString(pts) if len(pts) >= 2 else Point(pts[0])


def _tiles_intersecting(con, project_image_id: str, kind: str, points: list) -> list[str]:
    """Return ids of existing tiles (on this image) that the shape intersects."""
    geom = _shape_geom(kind, points)
    if geom is None:
        return []
    rows = con.execute(
        'SELECT id, x, y, w, h FROM tile WHERE project_image_id = ?', (project_image_id,)
    ).fetchall()
    hit = []
    for t in rows:
        if geom.intersects(shapely_box(t['x'], t['y'], t['x'] + t['w'], t['y'] + t['h'])):
            hit.append(t['id'])
    return hit


def _mark_tiles_dirty(con, tile_ids: list[str], annotator: str) -> None:
    """Completed annotator_tiles for these tiles flip to 'dirty' (re-annotation needed).

    SEAM: the plan says a dirty tile is *pulled into the current batch*. v1 marks it dirty
    in place; cross-batch pull-forward is a follow-up (see ANNOTATOR_STATUS.md).
    """
    if not tile_ids:
        return
    qmarks = ','.join('?' * len(tile_ids))
    con.execute(
        f'''UPDATE annotator_tile SET state = 'dirty', updated_at = ?
            WHERE annotator = ? AND state = 'completed' AND batch_tile_id IN (
              SELECT bt.id FROM batch_tile bt WHERE bt.tile_id IN ({qmarks})
            )''',
        (_now(), annotator, *tile_ids),
    )


# ── projects CRUD ─────────────────────────────────────────────────────────────

@projects_bp.get('/api/projects')
@login_required
def list_projects():
    con = _db.get_db()
    try:
        rows = con.execute('SELECT * FROM project ORDER BY created_at DESC').fetchall()
        out = []
        for r in rows:
            p = _project_out(r)
            p['imageCount'] = con.execute(
                'SELECT COUNT(*) c FROM project_image WHERE project_id = ?', (r['id'],)
            ).fetchone()['c']
            p['batchCount'] = con.execute(
                'SELECT COUNT(*) c FROM batch WHERE project_id = ?', (r['id'],)
            ).fetchone()['c']
            p['annotatorCount'] = con.execute(
                'SELECT COUNT(*) c FROM project_annotator WHERE project_id = ?', (r['id'],)
            ).fetchone()['c']
            out.append(p)
        return jsonify(out)
    finally:
        _db.close_db(con)


@projects_bp.post('/api/projects')
@login_required
def create_project():
    body = request.json or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    tile_size = int(body.get('tile_size_px') or 128)
    # Default Minimum Luminance Threshold = 0 for new projects: the largest-connected-
    # component rule defines the leaf regardless, so 0 is a safe, no-surprise default.
    raw_threshold = body.get('black_threshold')
    threshold = int(raw_threshold) if raw_threshold is not None else 0
    classes = body.get('classes') or []
    if tile_size < 8:
        return jsonify({'error': 'tile_size_px too small'}), 400
    pid = _uid()
    con = _db.get_db()
    try:
        con.execute(
            '''INSERT INTO project
                 (id, name, tile_size_px, black_threshold, classes_json,
                  created_by, created_by_user_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
            (pid, name, tile_size, threshold, json.dumps(classes),
             _byline(), session.get('user_id'), _now()),
        )
        con.commit()
        return jsonify(_project_out(_project(con, pid))), 201
    finally:
        _db.close_db(con)


@projects_bp.patch('/api/projects/<project_id>')
@login_required
def update_project(project_id: str):
    body = request.json or {}
    con = _db.get_db()
    try:
        if not _project(con, project_id):
            return jsonify({'error': 'not found'}), 404
        sets, vals = [], []
        if 'name' in body:
            sets.append('name = ?'); vals.append((body['name'] or '').strip())
        if 'black_threshold' in body:
            sets.append('black_threshold = ?'); vals.append(int(body['black_threshold']))
            sets.append('tiling_confirmed = ?'); vals.append(1)
        if 'classes' in body:
            sets.append('classes_json = ?'); vals.append(json.dumps(body['classes'] or []))
        if 'tiling_confirmed' in body:
            sets.append('tiling_confirmed = ?'); vals.append(1 if body['tiling_confirmed'] else 0)
        if 'tile_size_px' in body:
            # tile_size_px locked once any batch exists
            batch_count = con.execute(
                'SELECT COUNT(*) c FROM batch WHERE project_id = ?', (project_id,)
            ).fetchone()['c']
            if batch_count > 0:
                return jsonify({'error': 'tile_size_px locked: batch already exists'}), 422
            tile_size = int(body['tile_size_px'])
            if tile_size < 8:
                return jsonify({'error': 'tile_size_px too small'}), 400
            sets.append('tile_size_px = ?'); vals.append(tile_size)
            sets.append('tiling_confirmed = ?'); vals.append(1)
        if sets:
            con.execute(f'UPDATE project SET {", ".join(sets)} WHERE id = ?', (*vals, project_id))
            con.commit()
        return jsonify(_project_out(_project(con, project_id)))
    finally:
        _db.close_db(con)


@projects_bp.delete('/api/projects/<project_id>')
@login_required
def delete_project(project_id: str):
    con = _db.get_db()
    try:
        con.execute('DELETE FROM project WHERE id = ?', (project_id,))  # cascades
        con.commit()
        return jsonify({'ok': True})
    finally:
        _db.close_db(con)


@projects_bp.get('/api/projects/<project_id>')
@login_required
def get_project(project_id: str):
    con = _db.get_db()
    try:
        row = _project(con, project_id)
        if not row:
            return jsonify({'error': 'not found'}), 404
        out = _project_out(row)
        out['annotators'] = con.execute(
            'SELECT id, user_id, byline FROM project_annotator WHERE project_id = ? ORDER BY byline',
            (project_id,),
        ).fetchall()
        out['images'] = con.execute(
            '''SELECT id, image_hash, image_ext, source_name, source_path, width, height,
                      origin_y, leaf_x, leaf_y, leaf_w, leaf_h
               FROM project_image WHERE project_id = ? ORDER BY created_at''',
            (project_id,),
        ).fetchall()
        batches = con.execute(
            'SELECT * FROM batch WHERE project_id = ? ORDER BY seq', (project_id,)
        ).fetchall()
        for b in batches:
            b['tileCount'] = con.execute(
                'SELECT COUNT(*) c FROM batch_tile WHERE batch_id = ?', (b['id'],)
            ).fetchone()['c']
        out['batches'] = batches
        out['progress'] = _progress(con, project_id, batches)
        return jsonify(out)
    finally:
        _db.close_db(con)


def _progress(con, project_id: str, batches: list) -> list:
    """Per-annotator progress for the latest batch (tiles done/total, lesions, vertices)."""
    current = batches[-1] if batches else None
    roster = con.execute(
        'SELECT byline FROM project_annotator WHERE project_id = ?', (project_id,)
    ).fetchall()
    tiles_total = current['tileCount'] if current else 0
    out = []
    for a in roster:
        byline = a['byline']
        done = 0
        if current:
            done = con.execute(
                '''SELECT COUNT(*) c FROM annotator_tile at
                   JOIN batch_tile bt ON bt.id = at.batch_tile_id
                   WHERE bt.batch_id = ? AND at.annotator = ? AND at.state = 'completed' ''',
                (current['id'], byline),
            ).fetchone()['c']
        anns = con.execute(
            '''SELECT kind, points_json FROM annotation
               WHERE project_id = ? AND annotator = ? AND deleted_at IS NULL''',
            (project_id, byline),
        ).fetchall()
        lesion_count = sum(1 for x in anns if x['kind'] == 'polygon')
        vertex_count = 0
        for x in anns:
            try:
                vertex_count += len(json.loads(x['points_json']))
            except (ValueError, TypeError):
                pass
        out.append({
            'annotator': byline,
            'tilesCompleted': done,
            'tilesTotal': tiles_total,
            'lesionCount': lesion_count,
            'vertexCount': vertex_count,
        })
    return out


# ── roster ────────────────────────────────────────────────────────────────────

@projects_bp.post('/api/projects/<project_id>/annotators')
@login_required
def add_annotator(project_id: str):
    body = request.json or {}
    user_id = body.get('user_id')
    if not user_id:
        return jsonify({'error': 'user_id required'}), 400
    con = _db.get_db()
    try:
        if not _project(con, project_id):
            return jsonify({'error': 'not found'}), 404
        user = con.execute(
            'SELECT id, username FROM users WHERE id = ?', (user_id,)
        ).fetchone()
        if not user:
            return jsonify({'error': 'user not found'}), 404
        byline = user['username']
        try:
            con.execute(
                'INSERT INTO project_annotator (id, project_id, user_id, byline) VALUES (?, ?, ?, ?)',
                (_uid(), project_id, user_id, byline),
            )
            con.commit()
        except _db.sqlite3.IntegrityError:
            return jsonify({'error': 'already on roster'}), 409
        return jsonify({'ok': True, 'byline': byline, 'user_id': user_id}), 201
    finally:
        _db.close_db(con)


@projects_bp.delete('/api/projects/<project_id>/annotators/<annotator_id>')
@login_required
def remove_annotator(project_id: str, annotator_id: str):
    con = _db.get_db()
    try:
        con.execute(
            'DELETE FROM project_annotator WHERE id = ? AND project_id = ?',
            (annotator_id, project_id),
        )
        con.commit()
        return jsonify({'ok': True})
    finally:
        _db.close_db(con)


# ── image import (bulk, from a server-side path) ──────────────────────────────

def _collect_image_files(src: Path) -> list[Path]:
    """A single file, or a recursive scan of a directory for image files (sorted)."""
    if src.is_file():
        return [src]
    return sorted(
        p for p in src.rglob('*')
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    )


def _resolve_import_path(raw_path: str):
    """Return (files, error_tuple). error_tuple is (json, status) or None."""
    if not raw_path:
        return None, ({'error': 'path required'}, 400)
    src = Path(raw_path)
    if not src.exists():
        return None, ({'error': f'path not found: {raw_path}'}, 400)
    files = _collect_image_files(src)
    if not files:
        return None, ({'error': 'no image files found at path'}, 400)
    return files, None


def _import_one_file(
    con, project_id: str,
    filename: str, data: bytes, provenance: str | None,
    threshold: int, tile_size: int,
) -> dict:
    """Import a single image. Returns a per-file result dict.

    Shared by path-scan and upload endpoints — dedup/store/leaf-bbox/insert live here.
    filename: basename used for source_name.
    provenance: stored as source_path — the real server path for disk imports, or NULL
    (None) for uploads, which have no server-side original location.
    Does NOT commit — the caller controls the transaction.
    """
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    h = imaging.store_image(data, ext)
    exists = con.execute(
        'SELECT 1 FROM project_image WHERE project_id = ? AND image_hash = ?',
        (project_id, h),
    ).fetchone()
    if exists:
        return {'imported': False, 'skipped': True}
    img = imaging.get_image(h, ext)
    w, hgt = img.size
    bb = tiling.compute_leaf_bbox(img, threshold)
    if bb is None:
        bb = tiling.Rect(0, 0, w, hgt)  # whole image if nothing above threshold
    # Deterministic image-midpoint centring (no RNG). Target (deferred, needs a mask):
    # centre on the leaf centroid; bb is already computed and could give a cheap upgrade.
    origin_y = tiling.centered_origin_y(hgt, tile_size)
    con.execute(
        '''INSERT INTO project_image
             (id, project_id, image_hash, image_ext, source_name, source_path,
              width, height, origin_y, leaf_x, leaf_y, leaf_w, leaf_h, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (_uid(), project_id, h, ext, filename, provenance, w, hgt,
         origin_y, bb.x, bb.y, bb.w, bb.h, _now()),
    )
    return {'imported': True, 'skipped': False}


@projects_bp.post('/api/projects/<project_id>/images/import')
@login_required
def import_images(project_id: str):
    """Import images from a server-side file or directory path (buffered summary).

    No browser upload — files already live on the server (e.g. /deltos/c/maize/...).
    For each image: store content-addressed, compute leaf_bbox + centred origin_y, insert.
    """
    raw_path = ((request.json or {}).get('path') or '').strip()
    files, err = _resolve_import_path(raw_path)
    if err:
        return jsonify(err[0]), err[1]

    con = _db.get_db()
    try:
        proj = _project(con, project_id)
        if not proj:
            return jsonify({'error': 'not found'}), 404
        threshold, tile_size = proj['black_threshold'], proj['tile_size_px']
        imported, skipped, errors = 0, 0, []
        for f in files:
            try:
                res = _import_one_file(con, project_id, f.name, f.read_bytes(), str(f),
                                       threshold, tile_size)
                if res['imported']:
                    imported += 1
                elif res['skipped']:
                    skipped += 1
            except Exception as exc:  # noqa: BLE001 — report per-file, keep importing
                errors.append({'file': f.name, 'error': str(exc)})
        con.commit()
        return jsonify({'imported': imported, 'skipped': skipped, 'errors': errors})
    finally:
        _db.close_db(con)


@projects_bp.post('/api/projects/<project_id>/images/import/stream')
@login_required
def import_images_stream(project_id: str):
    """Streaming import: NDJSON, one event per line, flushed as each file completes.

    Events: {"type":"start","total":N} → {"type":"file","name","path","ok","imported"|"error"}
    per file → {"type":"done","imported","skipped","errors":[...]}. Per-file errors are
    reported inline and never abort the batch.
    """
    raw_path = ((request.json or {}).get('path') or '').strip()
    files, err = _resolve_import_path(raw_path)
    if err:
        return jsonify(err[0]), err[1]

    con = _db.get_db()
    proj = _project(con, project_id)
    if not proj:
        _db.close_db(con)
        return jsonify({'error': 'not found'}), 404
    threshold, tile_size = proj['black_threshold'], proj['tile_size_px']

    def generate():
        imported, skipped, errors = 0, 0, []
        try:
            yield json.dumps({'type': 'start', 'total': len(files)}) + '\n'
            for f in files:
                ev = {'type': 'file', 'name': f.name, 'path': str(f)}
                try:
                    res = _import_one_file(con, project_id, f.name, f.read_bytes(), str(f),
                                           threshold, tile_size)
                    con.commit()  # commit per-file so a later failure can't lose earlier work
                    if res['imported']:
                        imported += 1
                        ev.update(ok=True, imported=True, skipped=False)
                    else:
                        skipped += 1
                        ev.update(ok=True, imported=False, skipped=True)
                except Exception as exc:  # noqa: BLE001 — report per-file, keep importing
                    errors.append({'file': f.name, 'error': str(exc)})
                    ev.update(ok=False, error=str(exc))
                yield json.dumps(ev) + '\n'
            yield json.dumps({'type': 'done', 'imported': imported,
                              'skipped': skipped, 'errors': errors}) + '\n'
        finally:
            _db.close_db(con)

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


@projects_bp.post('/api/projects/<project_id>/images/upload')
@login_required
def upload_images(project_id: str):
    """Browser multipart upload. Streams the same NDJSON events as import_images_stream.

    Files are posted as `files` fields in a multipart/form-data body (many files OK).
    source_path = the original filename (no server path); source_name = same.
    Events: {"type":"start","total":N} → per-file {"type":"file",...} → {"type":"done",...}
    """
    uploaded = request.files.getlist('files')
    if not uploaded:
        return jsonify({'error': 'no files provided'}), 400
    # Pre-read bytes now (FileStorage streams close once the generator yields control
    # back to Flask's response machinery; read while the request context is hot).
    file_data = [
        ((uf.filename or 'unknown').rsplit('/', 1)[-1].rsplit('\\', 1)[-1], uf.read())
        for uf in uploaded
    ]
    con = _db.get_db()
    proj = _project(con, project_id)
    if not proj:
        _db.close_db(con)
        return jsonify({'error': 'not found'}), 404
    threshold, tile_size = proj['black_threshold'], proj['tile_size_px']

    def generate():
        imported, skipped, errors = 0, 0, []
        try:
            yield json.dumps({'type': 'start', 'total': len(file_data)}) + '\n'
            for fname, data in file_data:
                ev = {'type': 'file', 'name': fname, 'path': fname}
                try:
                    # Uploads have no server-side original location → store NULL source_path.
                    res = _import_one_file(con, project_id, fname, data, None,
                                          threshold, tile_size)
                    con.commit()
                    if res['imported']:
                        imported += 1
                        ev.update(ok=True, imported=True, skipped=False)
                    else:
                        skipped += 1
                        ev.update(ok=True, imported=False, skipped=True)
                except Exception as exc:  # noqa: BLE001
                    errors.append({'file': fname, 'error': str(exc)})
                    ev.update(ok=False, error=str(exc))
                yield json.dumps(ev) + '\n'
            yield json.dumps({'type': 'done', 'imported': imported,
                              'skipped': skipped, 'errors': errors}) + '\n'
        finally:
            _db.close_db(con)

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


@projects_bp.delete('/api/projects/<project_id>/images/<image_id>')
@login_required
def delete_image(project_id: str, image_id: str):
    con = _db.get_db()
    try:
        con.execute(
            'DELETE FROM project_image WHERE id = ? AND project_id = ?', (image_id, project_id)
        )
        con.commit()
        return jsonify({'ok': True})
    finally:
        _db.close_db(con)


# ── tiling preview (drives the threshold/size slider) ─────────────────────────

@projects_bp.get('/api/projects/<project_id>/images/<image_id>/tiles/preview')
@login_required
def preview_tiles(project_id: str, image_id: str):
    con = _db.get_db()
    try:
        proj = _project(con, project_id)
        img_row = con.execute(
            'SELECT * FROM project_image WHERE id = ? AND project_id = ?', (image_id, project_id)
        ).fetchone()
        if not proj or not img_row:
            return jsonify({'error': 'not found'}), 404
        tile_size = int(request.args.get('tile_size', proj['tile_size_px']))
        threshold = int(request.args.get('black_threshold', proj['black_threshold']))
        origin_y = int(request.args.get('origin_y', img_row['origin_y']))
        img = imaging.get_image(img_row['image_hash'], img_row['image_ext'])
        bb = tiling.Rect(img_row['leaf_x'], img_row['leaf_y'], img_row['leaf_w'], img_row['leaf_h'])
        surv = tiling.surviving_tiles(img, bb, tile_size, origin_y, threshold)
        return jsonify({
            'imageWidth': img_row['width'],
            'imageHeight': img_row['height'],
            'leafBbox': bb.as_dict(),
            'originY': origin_y,
            'tileSize': tile_size,
            'tiles': [t.as_dict() for t in surv],
        })
    finally:
        _db.close_db(con)


# ── batch creation ────────────────────────────────────────────────────────────

@projects_bp.post('/api/projects/<project_id>/batches')
@login_required
def create_batch(project_id: str):
    size = int((request.json or {}).get('size') or 5)
    con = _db.get_db()
    try:
        proj = _project(con, project_id)
        if not proj:
            return jsonify({'error': 'not found'}), 404
        roster = [r['byline'] for r in con.execute(
            'SELECT byline FROM project_annotator WHERE project_id = ?', (project_id,)
        ).fetchall()]

        images = con.execute(
            'SELECT * FROM project_image WHERE project_id = ?', (project_id,)
        ).fetchall()
        if not images:
            return jsonify({'error': 'project has no images'}), 400

        # Build candidate pool across all images; exclude positions already tiled (= used by
        # a previous batch, since tiles are only created at batch time).
        pool: dict[tuple, tuple] = {}   # (image_id, x, y) -> (image_row, Rect)
        for im in images:
            bb = tiling.Rect(im['leaf_x'], im['leaf_y'], im['leaf_w'], im['leaf_h'])
            img = imaging.get_image(im['image_hash'], im['image_ext'])
            for t in tiling.surviving_tiles(
                img, bb, proj['tile_size_px'], im['origin_y'], proj['black_threshold']
            ):
                pool[(im['id'], t.x, t.y)] = (im, t)
        used = {
            (r['project_image_id'], r['x'], r['y'])
            for r in con.execute(
                '''SELECT t.project_image_id, t.x, t.y FROM tile t
                   JOIN project_image pi ON pi.id = t.project_image_id
                   WHERE pi.project_id = ?''', (project_id,)
            ).fetchall()
        }
        picked = tiling.sample_positions(list(pool.keys()), used, size)
        if not picked:
            return jsonify({'error': 'no unused tiles left to sample'}), 409

        seq = (con.execute(
            'SELECT COALESCE(MAX(seq), 0) m FROM batch WHERE project_id = ?', (project_id,)
        ).fetchone()['m']) + 1
        batch_id = _uid()
        con.execute(
            'INSERT INTO batch (id, project_id, seq, size, status, created_at)'
            " VALUES (?, ?, ?, ?, 'annotation_in_progress', ?)",
            (batch_id, project_id, seq, size, _now()),
        )
        for key in picked:
            im, t = pool[key]
            image_id, x, y = key
            existing = con.execute(
                'SELECT id FROM tile WHERE project_image_id = ? AND x = ? AND y = ?',
                (image_id, x, y),
            ).fetchone()
            tile_id = existing['id'] if existing else _uid()
            if not existing:
                con.execute(
                    'INSERT INTO tile (id, project_image_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)',
                    (tile_id, image_id, t.x, t.y, t.w, t.h),
                )
            bt_id = _uid()
            con.execute(
                'INSERT INTO batch_tile (id, batch_id, tile_id) VALUES (?, ?, ?)',
                (bt_id, batch_id, tile_id),
            )
            for byline in roster:
                con.execute(
                    '''INSERT INTO annotator_tile (id, batch_tile_id, annotator, state, updated_at)
                       VALUES (?, ?, ?, 'assigned', ?)''',
                    (_uid(), bt_id, byline, _now()),
                )
        con.commit()
        return jsonify({'id': batch_id, 'seq': seq, 'size': size,
                        'tileCount': len(picked), 'rosterSize': len(roster)}), 201
    finally:
        _db.close_db(con)


# ── batch / canvas read ───────────────────────────────────────────────────────

@projects_bp.get('/api/batches/<batch_id>')
@login_required
def get_batch(batch_id: str):
    """Batch detail for the canvas: images in the batch, their tiles, and (for ?annotator)
    that annotator's tile states + visible annotations (blind to others until merge)."""
    annotator = request.args.get('annotator')
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        proj = con.execute(
            'SELECT classes_json FROM project WHERE id = ?', (batch['project_id'],)
        ).fetchone()
        try:
            classes = json.loads(proj['classes_json'] or '[]') if proj else []
        except (TypeError, ValueError):
            classes = []
        rows = con.execute(
            '''SELECT bt.id bt_id, t.id tile_id, t.project_image_id, t.x, t.y, t.w, t.h
               FROM batch_tile bt JOIN tile t ON t.id = bt.tile_id
               WHERE bt.batch_id = ?''', (batch_id,)
        ).fetchall()
        by_image: dict[str, dict] = {}
        for r in rows:
            img = by_image.setdefault(r['project_image_id'], {'tiles': []})
            state, at_id = None, None
            if annotator:
                st = con.execute(
                    'SELECT id, state FROM annotator_tile WHERE batch_tile_id = ? AND annotator = ?',
                    (r['bt_id'], annotator),
                ).fetchone()
                if st:
                    state, at_id = st['state'], st['id']
            img['tiles'].append({
                'tileId': r['tile_id'], 'batchTileId': r['bt_id'], 'annotatorTileId': at_id,
                'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'], 'state': state,
            })
        images = []
        for image_id, payload in by_image.items():
            im = con.execute('SELECT * FROM project_image WHERE id = ?', (image_id,)).fetchone()
            if not im:
                continue
            entry = {
                'imageId': image_id, 'width': im['width'], 'height': im['height'],
                'tiles': payload['tiles'], 'annotations': [],
            }
            if annotator:
                entry['annotations'] = _visible_annotations(con, image_id, annotator,
                                                            [t['tileId'] for t in payload['tiles']])
            images.append(entry)
        return jsonify({
            'id': batch['id'], 'projectId': batch['project_id'], 'seq': batch['seq'],
            'status': batch['status'], 'classes': classes, 'images': images,
        })
    finally:
        _db.close_db(con)


def _visible_annotations(con, image_id: str, annotator: str, active_tile_ids: list[str]) -> list:
    """This annotator's non-deleted annotations on this image that intersect an active tile.

    Implements the within-your-own-work visibility rule; cross-annotator blindness is by
    never querying other annotators here.
    """
    if not active_tile_ids:
        return []
    qmarks = ','.join('?' * len(active_tile_ids))
    rows = con.execute(
        f'''SELECT DISTINCT a.* FROM annotation a
            JOIN annotation_tile atl ON atl.annotation_id = a.id
            WHERE a.project_image_id = ? AND a.annotator = ? AND a.deleted_at IS NULL
              AND atl.tile_id IN ({qmarks})''',
        (image_id, annotator, *active_tile_ids),
    ).fetchall()
    return [_annotation_out(r) for r in rows]


def _annotation_out(row: dict) -> dict:
    return {
        'id': row['id'], 'kind': row['kind'], 'passNo': row['pass_no'],
        'points': json.loads(row['points_json']), 'label': row['label'],
        'viewport': json.loads(row['viewport_json']) if row['viewport_json'] else None,
        'annotator': row['annotator'], 'imageId': row['project_image_id'],
    }


# ── annotations CRUD (the painting data sink) ─────────────────────────────────

@projects_bp.post('/api/projects/<project_id>/annotations')
@login_required
def create_annotation(project_id: str):
    body = request.json or {}
    image_id = body.get('imageId')
    kind = body.get('kind')
    points = body.get('points') or []
    annotator = (body.get('annotator') or '').strip()
    if not (image_id and kind and points and annotator):
        return jsonify({'error': 'imageId, kind, points, annotator required'}), 400
    con = _db.get_db()
    try:
        tile_ids = _tiles_intersecting(con, image_id, kind, points)
        if not tile_ids:
            return jsonify({'error': 'annotation must intersect at least one tile'}), 422
        aid = _uid()
        now = _now()
        con.execute(
            '''INSERT INTO annotation
                 (id, project_id, project_image_id, annotator, kind, pass_no,
                  points_json, label, viewport_json, hsv_hist_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (aid, project_id, image_id, annotator, kind, body.get('passNo'),
             json.dumps(points), body.get('label'),
             json.dumps(body['viewport']) if body.get('viewport') else None,
             json.dumps(body['hsvHist']) if body.get('hsvHist') else None, now, now),
        )
        for tid in tile_ids:
            con.execute(
                'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                (aid, tid),
            )
        con.commit()
        row = con.execute('SELECT * FROM annotation WHERE id = ?', (aid,)).fetchone()
        out = _annotation_out(row)
        out['tileIds'] = tile_ids
        return jsonify(out), 201
    finally:
        _db.close_db(con)


@projects_bp.patch('/api/annotations/<annotation_id>')
@login_required
def update_annotation(annotation_id: str):
    body = request.json or {}
    con = _db.get_db()
    try:
        row = con.execute('SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone()
        if not row or row['deleted_at']:
            return jsonify({'error': 'not found'}), 404
        old_tiles = [r['tile_id'] for r in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (annotation_id,)
        ).fetchall()]
        points = body.get('points', json.loads(row['points_json']))
        label = body.get('label', row['label'])
        con.execute(
            'UPDATE annotation SET points_json = ?, label = ?, updated_at = ? WHERE id = ?',
            (json.dumps(points), label, _now(), annotation_id),
        )
        # Recompute tile membership and dirty every touched tile (old ∪ new).
        new_tiles = _tiles_intersecting(con, row['project_image_id'], row['kind'], points)
        con.execute('DELETE FROM annotation_tile WHERE annotation_id = ?', (annotation_id,))
        for tid in new_tiles:
            con.execute(
                'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                (annotation_id, tid),
            )
        _mark_tiles_dirty(con, list(set(old_tiles) | set(new_tiles)), row['annotator'])
        con.commit()
        out = _annotation_out(con.execute(
            'SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone())
        out['tileIds'] = new_tiles
        return jsonify(out)
    finally:
        _db.close_db(con)


@projects_bp.delete('/api/annotations/<annotation_id>')
@login_required
def delete_annotation(annotation_id: str):
    """Soft delete; tiles it touched go dirty."""
    con = _db.get_db()
    try:
        row = con.execute('SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone()
        if not row:
            return jsonify({'error': 'not found'}), 404
        tiles = [r['tile_id'] for r in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (annotation_id,)
        ).fetchall()]
        con.execute('UPDATE annotation SET deleted_at = ? WHERE id = ?', (_now(), annotation_id))
        _mark_tiles_dirty(con, tiles, row['annotator'])
        con.commit()
        return jsonify({'ok': True})
    finally:
        _db.close_db(con)


# ── tile completion toggle ────────────────────────────────────────────────────

@projects_bp.patch('/api/annotator-tiles/<at_id>')
@login_required
def set_tile_state(at_id: str):
    """Mark complete is a separate action from drawing (a clean tile is a valid result)."""
    state = (request.json or {}).get('state')
    if state not in ('assigned', 'completed', 'dirty'):
        return jsonify({'error': 'state must be assigned|completed|dirty'}), 400
    con = _db.get_db()
    try:
        con.execute(
            'UPDATE annotator_tile SET state = ?, updated_at = ? WHERE id = ?',
            (state, _now(), at_id),
        )
        con.commit()
        return jsonify({'ok': True, 'state': state})
    finally:
        _db.close_db(con)


# ── project image serving ─────────────────────────────────────────────────────

def _image_row(con, image_id: str):
    return con.execute('SELECT * FROM project_image WHERE id = ?', (image_id,)).fetchone()


@projects_bp.get('/api/projects/images/<image_id>/overview')
@login_required
def image_overview(image_id: str):
    con = _db.get_db()
    try:
        im = _image_row(con, image_id)
    finally:
        _db.close_db(con)
    if not im:
        return jsonify({'error': 'not found'}), 404
    img = imaging.get_image(im['image_hash'], im['image_ext'])
    return send_file(_bytesio(imaging.overview_png(img)), mimetype='image/png')


@projects_bp.get('/api/projects/images/<image_id>/crop')
@login_required
def image_crop(image_id: str):
    con = _db.get_db()
    try:
        im = _image_row(con, image_id)
    finally:
        _db.close_db(con)
    if not im:
        return jsonify({'error': 'not found'}), 404
    try:
        x, y = int(request.args['x']), int(request.args['y'])
        w, h = int(request.args['w']), int(request.args['h'])
    except (KeyError, ValueError):
        return jsonify({'error': 'x, y, w, h required'}), 400
    img = imaging.get_image(im['image_hash'], im['image_ext'])
    return send_file(_bytesio(imaging.crop_png(img, x, y, w, h)), mimetype='image/png')


def _bytesio(data: bytes):
    import io
    return io.BytesIO(data)
