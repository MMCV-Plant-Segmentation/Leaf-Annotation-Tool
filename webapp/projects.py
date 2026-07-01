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
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, send_file, session, stream_with_context
from shapely.geometry import LineString, Point
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.geometry import box as shapely_box
from shapely.ops import unary_union

from . import db as _db
from . import imaging, tiling
from .auth import admin_required, login_required

projects_bp = Blueprint('projects', __name__)

IMAGE_EXTS = {'.tif', '.tiff', '.png', '.jpg', '.jpeg'}

# Max simultaneous browser uploads (matches FE UPLOAD_CONCURRENCY).
UPLOAD_CONCURRENCY = 4
# Per-process semaphore — single dev server; multi-worker prod would need shared state.
_upload_sema = threading.BoundedSemaphore(UPLOAD_CONCURRENCY)


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


def _stroke_polygon(points, stroke_width, outline=None):
    """Build a shapely geometry for a brush stroke's footprint.

    When `outline` (≥3 pts, a perfect-freehand outline polygon) is provided, use
    ShapelyPolygon(outline).buffer(0) — buffer(0) repairs self-intersecting contours
    (e.g. figure-eight loops) into valid (multi)polygon geometry. Falls back to the
    centerline buffer for legacy rows without an outline.

    Returns None for degenerate input. May return a MultiPolygon when buffer(0) splits
    a self-intersecting outline into disconnected regions.
    """
    outline_pts = [(float(p[0]), float(p[1])) for p in (outline or []) if len(p) >= 2]
    if len(outline_pts) >= 3:
        try:
            return ShapelyPolygon(outline_pts).buffer(0)
        except Exception:
            pass  # fall through to centerline buffer

    # Legacy / no-outline fallback: centerline buffer
    width = max(float(stroke_width or 0) or 1, 1)
    pts = [(float(p[0]), float(p[1])) for p in (points or []) if len(p) >= 2]
    if not pts:
        return None
    if len(pts) == 1:
        return Point(pts[0]).buffer(width / 2)
    return LineString(pts).buffer(width / 2, cap_style='round', join_style='round')


def _poly_rings(poly) -> list:
    """Extract only the exterior ring from a Shapely Polygon as a [[x,y],...] list.

    Lesions are solid blobs by definition — interior rings (holes) are dropped so a
    drawn loop fills solid instead of rendering as a donut. Returns [] for degenerate
    or empty geometry so the frontend can fall back gracefully.
    """
    if poly is None or poly.is_empty or poly.geom_type != 'Polygon':
        return []
    def coords(ring):
        return [[round(float(pt[0])), round(float(pt[1]))] for pt in ring.coords]
    return [coords(poly.exterior)]


def _stroke_components(rows: list[dict]) -> list[dict]:
    """Connected components of a set of brush-stroke footprints (pure geometry helper).

    Only brush (kind='stroke') annotations ever fuse (Christian, 2026-07-01) — this is the
    ONE place that groups a batch of strokes into fused-mask pieces, replacing what
    `_lesions_for_image` used to derive on every read. Used by the one-time old-data
    Alembic migration (alembic/versions/0002_annotation_stroke_model.py), which must wrap
    ALL pre-existing strokes into `annotation` (mask) rows in one pass. The live write path
    (create_annotation) does its OWN incremental new-stroke-vs-existing-masks fuse check —
    it doesn't need a whole-group regroup, so it doesn't call this.

    rows: [{'id', 'points', 'stroke_width', 'outline'}, ...] (points/outline already
    parsed to plain lists — caller's job, so this stays pure geometry).
    Returns [{'member_ids': [id, ...], 'geometry': ShapelyPolygon | None}, ...] — one entry
    per component, plus one singleton entry per degenerate (no-geometry) row.
    """
    polys = [(r['id'], _stroke_polygon(r['points'], r.get('stroke_width'),
                                       outline=r.get('outline'))) for r in rows]
    valid = [(rid, p) for rid, p in polys if p is not None and not p.is_empty]
    invalid_ids = [rid for rid, p in polys if p is None or p.is_empty]

    components = [{'member_ids': [rid], 'geometry': None} for rid in invalid_ids]
    if not valid:
        return components

    union = unary_union([p for _, p in valid])
    if union.is_empty:
        return components + [{'member_ids': [rid], 'geometry': None} for rid, _ in valid]

    pieces = list(union.geoms) if union.geom_type == 'MultiPolygon' else [union]
    piece_members: list[list[str]] = [[] for _ in pieces]
    for rid, poly in valid:
        for i, piece in enumerate(pieces):
            if poly.intersects(piece):
                piece_members[i].append(rid)
                break
        else:
            # Shouldn't happen (stroke is part of the union) but handle defensively.
            components.append({'member_ids': [rid], 'geometry': None})
    for i, members in enumerate(piece_members):
        if members:
            components.append({'member_ids': members, 'geometry': pieces[i]})
    return components


def _annotation_geom(row: dict):
    """Shapely geometry for an EXISTING `annotation` (mask) row.

    kind='stroke' masks read the STORED fused geometry_json (exterior ring only, no
    holes) — this is the "rendering reads stored geometry" rule, no recompute-on-read.
    Other kinds never fuse, so their geometry is always freshly derived from points_json
    (identical to what a live create_annotation call tested for tile intersection).
    """
    if row['kind'] == 'stroke':
        rings = json.loads(row['geometry_json']) if row['geometry_json'] else []
        if not rings or not rings[0]:
            return None
        try:
            poly = ShapelyPolygon(rings[0])
            return poly if poly.is_valid else poly.buffer(0)
        except Exception:
            return None
    pts = json.loads(row['points_json']) if row['points_json'] else []
    return _shape_geom(row['kind'], pts)


def _tiles_for_geom(con, project_image_id: str, geom) -> list[str]:
    """Return ids of existing tiles (on this image) that `geom` intersects. Shared tail of
    _tiles_intersecting (fresh shape) and the merge/undo paths (an already-built mask
    geometry) — one geometry-vs-tiles test, so both stay in lockstep."""
    if geom is None or geom.is_empty:
        return []
    rows = con.execute(
        'SELECT id, x, y, w, h FROM tile WHERE project_image_id = ?', (project_image_id,)
    ).fetchall()
    return [t['id'] for t in rows
            if geom.intersects(shapely_box(t['x'], t['y'], t['x'] + t['w'], t['y'] + t['h']))]


def _tiles_intersecting(con, project_image_id: str, kind: str, points: list,
                        stroke_width=None, outline=None) -> list[str]:
    """Return ids of existing tiles (on this image) that the shape's painted area intersects.

    For strokes, tests against the outline polygon (when provided) or the centerline buffer
    — this catches strokes whose centerline misses a tile but whose painted width overlaps
    it. Falls back to _shape_geom for other kinds.
    """
    if kind == 'stroke' and (outline is not None or stroke_width is not None):
        geom = _stroke_polygon(points, stroke_width, outline=outline)
    else:
        geom = _shape_geom(kind, points)
    return _tiles_for_geom(con, project_image_id, geom)


def _mark_tiles_dirty(con, tile_ids: list[str], annotator: str) -> list[dict]:
    """Completed annotator_tiles for these tiles flip to 'dirty' (BUGS #16: editing a
    completed tile marks it incomplete again — any create/delete/restore that touches one
    of this annotator's completed tiles re-opens it).

    Returns the affected rows as [{'tileId', 'annotatorTileId', 'state'}, ...] so callers can
    include them in the response and the FE can patch its local tile state without reloading.

    SEAM: the plan says a dirty tile is *pulled into the current batch*. v1 marks it dirty
    in place; cross-batch pull-forward is a follow-up (see ANNOTATOR_STATUS.md).
    """
    if not tile_ids:
        return []
    qmarks = ','.join('?' * len(tile_ids))
    rows = con.execute(
        f'''SELECT at.id at_id, bt.tile_id FROM annotator_tile at
            JOIN batch_tile bt ON bt.id = at.batch_tile_id
            WHERE at.annotator = ? AND at.state = 'completed' AND bt.tile_id IN ({qmarks})''',
        (annotator, *tile_ids),
    ).fetchall()
    if not rows:
        return []
    at_ids = [r['at_id'] for r in rows]
    qmarks2 = ','.join('?' * len(at_ids))
    con.execute(
        f'''UPDATE annotator_tile SET state = 'dirty', updated_at = ? WHERE id IN ({qmarks2})''',
        (_now(), *at_ids),
    )
    return [{'tileId': r['tile_id'], 'annotatorTileId': r['at_id'], 'state': 'dirty'} for r in rows]


# ── membership helpers ────────────────────────────────────────────────────────

def _add_annotator(con, project_id: str, user_id, byline: str) -> None:
    """INSERT user into project_annotator. Caller handles IntegrityError and commit."""
    con.execute(
        'INSERT INTO project_annotator (id, project_id, user_id, byline) VALUES (?, ?, ?, ?)',
        (_uid(), project_id, user_id, byline),
    )


def _member_or_403(con, project_id: str):
    """Return (json 403 response, 403) when the session user is not a project member.

    Admin (session username == 'admin', matching auth.admin_required) always passes.
    Returns None if the user is permitted.
    """
    if session.get('username') == 'admin':
        return None
    user_id = session.get('user_id')
    row = con.execute(
        'SELECT 1 FROM project_annotator WHERE project_id = ? AND user_id = ?',
        (project_id, user_id),
    ).fetchone()
    if row is None:
        return jsonify({'error': 'forbidden'}), 403
    return None


def _owner_or_403(row_annotator: str):
    """Members may only mutate their OWN annotator data (annotations, tile state).

    Admin bypasses (matches _member_or_403). Returns a 403 tuple or None.
    """
    if session.get('username') == 'admin':
        return None
    if (row_annotator or '') != (session.get('username') or ''):
        return jsonify({'error': 'forbidden'}), 403
    return None


# ── projects CRUD ─────────────────────────────────────────────────────────────

@projects_bp.get('/api/projects')
@login_required
def list_projects():
    con = _db.get_db()
    try:
        if session.get('username') == 'admin':
            rows = con.execute('SELECT * FROM project ORDER BY created_at DESC').fetchall()
        else:
            rows = con.execute(
                '''SELECT p.* FROM project p
                   WHERE EXISTS (
                     SELECT 1 FROM project_annotator pa
                     WHERE pa.project_id = p.id AND pa.user_id = ?
                   )
                   ORDER BY p.created_at DESC''',
                (session.get('user_id'),),
            ).fetchall()
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
        # Auto-add creator as an annotator so the project is immediately visible to them.
        # Admin is excluded: admin already sees every project via the membership bypass
        # (see _member_or_403), so keep the roster to real annotators only.
        if session.get('username') != 'admin':
            try:
                _add_annotator(con, pid, session.get('user_id'), _byline())
            except _db.sqlite3.IntegrityError:
                pass  # already on roster — idempotent
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
        err = _member_or_403(con, project_id)
        if err:
            return err
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
        err = _member_or_403(con, project_id)
        if err:
            return err
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
        err = _member_or_403(con, project_id)
        if err:
            return err
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
    """Per-annotator progress for the latest batch (tiles done/total, annotations, vertices).

    annotationCount = every live `annotation` (mask) row — under the fused-mask model each
    row is already one distinct labelled object (brush masks included, not just polygons).
    """
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
            '''SELECT kind, points_json, geometry_json FROM annotation
               WHERE project_id = ? AND annotator = ? AND deleted_at IS NULL''',
            (project_id, byline),
        ).fetchall()
        vertex_count = 0
        for x in anns:
            try:
                if x['kind'] == 'stroke':
                    rings = json.loads(x['geometry_json']) if x['geometry_json'] else []
                    vertex_count += len(rings[0]) if rings else 0
                else:
                    vertex_count += len(json.loads(x['points_json'])) if x['points_json'] else 0
            except (ValueError, TypeError):
                pass
        out.append({
            'annotator': byline,
            'tilesCompleted': done,
            'tilesTotal': tiles_total,
            'annotationCount': len(anns),
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
        err = _member_or_403(con, project_id)
        if err:
            return err
        user = con.execute(
            'SELECT id, username FROM users WHERE id = ?', (user_id,)
        ).fetchone()
        if not user:
            return jsonify({'error': 'user not found'}), 404
        byline = user['username']
        try:
            _add_annotator(con, project_id, user_id, byline)
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
        err = _member_or_403(con, project_id)
        if err:
            return err
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
    # Deterministic leaf-bbox centring (no RNG). Target (deferred, needs a mask): centre on
    # the leaf centroid; bb is already computed just above and gives this cheap upgrade.
    origin_y = tiling.bbox_centered_origin_y(bb, hgt, tile_size)
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
@admin_required
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
@admin_required
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
    err = _member_or_403(con, project_id)
    if err:
        _db.close_db(con)
        return err
    threshold, tile_size = proj['black_threshold'], proj['tile_size_px']
    # Cap concurrent uploads per process (single dev server; multi-worker prod needs shared
    # state such as Redis — out of scope).
    if not _upload_sema.acquire(blocking=False):
        _db.close_db(con)
        return jsonify({'error': 'too many concurrent uploads'}), 429

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
            _upload_sema.release()

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


@projects_bp.post('/api/projects/<project_id>/images/probe')
@login_required
def probe_images(project_id: str):
    """Pre-flight dedup probe: given candidate content hashes, return the subset this
    project already has. Read-only — no bytes, no writes. Lets the browser skip
    re-uploading files already present; the upload path keeps its own dedup as backstop.

    Body {"hashes": [...]}  →  {"have": [...]}. Hashes are imaging.hash_bytes() values
    (sha256(bytes).hexdigest()[:24]); the client reproduces the scheme byte-for-byte.
    """
    hashes = (request.json or {}).get('hashes')
    if not isinstance(hashes, list):
        return jsonify({'error': 'hashes must be a list'}), 400
    con = _db.get_db()
    try:
        if not _project(con, project_id):
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, project_id)
        if err:
            return err
        # De-dupe the candidates and query in chunks so a huge folder can't blow past
        # SQLite's bound-variable limit. Hits the UNIQUE(project_id, image_hash) index.
        wanted = list({str(h) for h in hashes if h})
        have: list[str] = []
        for i in range(0, len(wanted), 500):
            chunk = wanted[i:i + 500]
            placeholders = ','.join('?' * len(chunk))
            rows = con.execute(
                f'SELECT image_hash FROM project_image '
                f'WHERE project_id = ? AND image_hash IN ({placeholders})',
                (project_id, *chunk),
            ).fetchall()
            have.extend(r['image_hash'] for r in rows)
        return jsonify({'have': have})
    finally:
        _db.close_db(con)


@projects_bp.delete('/api/projects/<project_id>/images/<image_id>')
@login_required
def delete_image(project_id: str, image_id: str):
    con = _db.get_db()
    try:
        err = _member_or_403(con, project_id)
        if err:
            return err
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
        err = _member_or_403(con, project_id)
        if err:
            return err
        tile_size = int(request.args.get('tile_size', proj['tile_size_px']))
        threshold = int(request.args.get('black_threshold', proj['black_threshold']))
        img = imaging.get_image(img_row['image_hash'], img_row['image_ext'])
        # Recompute the leaf bbox from the image at the REQUESTED threshold rather than
        # trusting the stored leaf_* columns. Two reasons: (a) the threshold slider changes
        # the foreground, so the bbox (and thus centring) must track it; (b) images imported
        # before the largest-connected-component bbox rule have a stale stored bbox that spans
        # nearly the whole image (the old all-above-threshold span), which collapses centring
        # to origin 0 and leaves the top row ~90% background.
        bb = tiling.compute_leaf_bbox(img, threshold) or tiling.Rect(0, 0, img_row['width'], img_row['height'])
        # Default origin is RECOMPUTED for the requested tile_size (not the stale stored
        # import-time origin_y, which was computed for the default 128px tile). An explicit
        # origin_y query-arg still overrides. This is what makes the slider's preview track
        # tile_size — otherwise a 500px row sits ~92% above the leaf at origin≈30.
        origin_y = int(request.args.get(
            'origin_y', tiling.bbox_centered_origin_y(bb, img_row['height'], tile_size)))
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
        err = _member_or_403(con, project_id)
        if err:
            return err
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
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
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
    """Shape an `annotation` (mask) row for JSON. kind='stroke' masks render from the
    stored fused `rings` (geometry_json); other kinds render from their own `points`
    (never fused, so points_json is always the exact shape that was drawn)."""
    is_mask = row['kind'] == 'stroke'
    rings = json.loads(row['geometry_json']) if (is_mask and row['geometry_json']) else []
    points = [] if is_mask else (json.loads(row['points_json']) if row['points_json'] else [])
    return {
        'id': row['id'], 'kind': row['kind'], 'passNo': row['pass_no'],
        'points': points, 'rings': rings, 'label': row['label'],
        'viewport': json.loads(row['viewport_json']) if row['viewport_json'] else None,
        'annotator': row['annotator'], 'imageId': row['project_image_id'],
    }


# ── annotations CRUD (the painting data sink) ─────────────────────────────────

def _insert_stroke(con, sid: str, annotation_id: str, kind: str, points: list,
                   stroke_width, outline, now: str) -> None:
    """INSERT the provenance-only `stroke` row bridged to its owning `annotation`."""
    con.execute(
        '''INSERT INTO stroke (id, annotation_id, kind, points_json, stroke_width,
             outline_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)''',
        (sid, annotation_id, kind, json.dumps(points), stroke_width,
         json.dumps(outline) if outline is not None else None, now),
    )


@projects_bp.post('/api/projects/<project_id>/annotations')
@login_required
def create_annotation(project_id: str):
    """Create a stroke. Brush (`kind='stroke'`) strokes may FUSE with existing same-
    annotator + same-image + same-label masks — see docs/plans/Plan — Annotation-stroke
    model (fused masks).md. A fuse mints a brand-new `annotation` (never mutates a live
    one in place): its geometry = drop_holes(union(new footprint, *fuse_set)); the fused
    set's own strokes are repointed to it and the fused set is soft-deleted. `point` /
    `line` / `polygon` never fuse — always a fresh 1:1 annotation+stroke pair.

    Response always carries `consumedAnnotationIds` / `consumedGroups` / `createdStrokeId`
    (empty/none when no fuse happened) so the FE can tell a plain create from a merge and
    drive undo accordingly (canvasHistory.ts).
    """
    body = request.json or {}
    image_id = body.get('imageId')
    kind = body.get('kind')
    points = body.get('points') or []
    # Annotate-as-yourself: non-admins are forced to their own identity; admin may seed any
    # annotator (matches the _member_or_403 / _owner_or_403 admin bypass).
    if session.get('username') == 'admin':
        annotator = (body.get('annotator') or '').strip()
    else:
        annotator = session.get('username') or ''
    if not (image_id and kind and points and annotator):
        return jsonify({'error': 'imageId, kind, points, annotator required'}), 400
    con = _db.get_db()
    try:
        err = _member_or_403(con, project_id)
        if err:
            return err
        label = body.get('label')
        pass_no = body.get('passNo')
        viewport_json = json.dumps(body['viewport']) if body.get('viewport') else None
        hsv_json = json.dumps(body['hsvHist']) if body.get('hsvHist') else None
        now = _now()
        sid = _uid()

        if kind == 'stroke':
            # Clamp stroke width to [1px, image diagonal] — the API must not trust the client.
            stroke_width = None
            if body.get('strokeWidth') is not None:
                im = _image_row(con, image_id)
                diag = ((float(im['width']) ** 2 + float(im['height']) ** 2) ** 0.5) if im else None
                try:
                    w = float(body['strokeWidth'])
                    stroke_width = max(1.0, min(w, diag) if diag else w)
                except (TypeError, ValueError):
                    stroke_width = None
            outline = body.get('outline')
            footprint = _stroke_polygon(points, stroke_width, outline=outline)
            if footprint is None or footprint.is_empty \
               or not _tiles_for_geom(con, image_id, footprint):
                return jsonify({'error': 'annotation must intersect at least one tile'}), 422

            fuse_rows = con.execute(
                '''SELECT * FROM annotation
                   WHERE project_image_id = ? AND annotator = ? AND kind = 'stroke'
                     AND label IS ? AND deleted_at IS NULL''',
                (image_id, annotator, label),
            ).fetchall()
            fuse_set = [(r, g) for r in fuse_rows
                       for g in [_annotation_geom(r)]
                       if g is not None and not g.is_empty and g.intersects(footprint)]

            merged = unary_union([footprint] + [g for _, g in fuse_set]) if fuse_set else footprint
            if merged.geom_type == 'MultiPolygon':
                # Defensive: every fuse_set member was chosen because it intersects the new
                # footprint, so the union should already be one piece; a boundary-only touch
                # is the one case that can still split it — keep the largest piece.
                merged = max(merged.geoms, key=lambda g: g.area)

            aid = _uid()
            con.execute(
                '''INSERT INTO annotation
                     (id, project_id, project_image_id, annotator, kind, pass_no, label,
                      points_json, geometry_json, viewport_json, hsv_hist_json,
                      created_at, updated_at, deleted_at)
                   VALUES (?, ?, ?, ?, 'stroke', ?, ?, NULL, ?, ?, ?, ?, ?, NULL)''',
                (aid, project_id, image_id, annotator, pass_no, label,
                 json.dumps(_poly_rings(merged)), viewport_json, hsv_json, now, now),
            )
            _insert_stroke(con, sid, aid, 'stroke', points, stroke_width, outline, now)

            consumed_groups = []
            for r, _g in fuse_set:
                stroke_ids = [s['id'] for s in con.execute(
                    'SELECT id FROM stroke WHERE annotation_id = ?', (r['id'],)
                ).fetchall()]
                if stroke_ids:
                    qmarks = ','.join('?' * len(stroke_ids))
                    con.execute(f'UPDATE stroke SET annotation_id = ? WHERE id IN ({qmarks})',
                               (aid, *stroke_ids))
                consumed_groups.append({'annotationId': r['id'], 'strokeIds': stroke_ids})
            consumed_ids = [g['annotationId'] for g in consumed_groups]
            if consumed_ids:
                qmarks = ','.join('?' * len(consumed_ids))
                con.execute(f'UPDATE annotation SET deleted_at = ? WHERE id IN ({qmarks})',
                           (now, *consumed_ids))
                con.execute(f'DELETE FROM annotation_tile WHERE annotation_id IN ({qmarks})',
                           consumed_ids)

            tile_ids = _tiles_for_geom(con, image_id, merged)
            for tid in tile_ids:
                con.execute(
                    'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                    (aid, tid),
                )
            tile_states = _mark_tiles_dirty(con, tile_ids, annotator)
            con.commit()
            out = _annotation_out(con.execute('SELECT * FROM annotation WHERE id = ?', (aid,)).fetchone())
            out.update({'tileIds': tile_ids, 'tileStates': tile_states,
                       'consumedAnnotationIds': consumed_ids, 'createdStrokeId': sid,
                       'consumedGroups': consumed_groups})
            return jsonify(out), 201

        # Non-fusing kinds (point / line / polygon): unconditional fresh 1:1 wrap.
        tile_ids = _tiles_intersecting(con, image_id, kind, points)
        if not tile_ids:
            return jsonify({'error': 'annotation must intersect at least one tile'}), 422
        aid = _uid()
        con.execute(
            '''INSERT INTO annotation
                 (id, project_id, project_image_id, annotator, kind, pass_no, label,
                  points_json, geometry_json, viewport_json, hsv_hist_json,
                  created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)''',
            (aid, project_id, image_id, annotator, kind, pass_no, label,
             json.dumps(points), viewport_json, hsv_json, now, now),
        )
        _insert_stroke(con, sid, aid, kind, points, None, None, now)
        for tid in tile_ids:
            con.execute(
                'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                (aid, tid),
            )
        tile_states = _mark_tiles_dirty(con, tile_ids, annotator)
        con.commit()
        out = _annotation_out(con.execute('SELECT * FROM annotation WHERE id = ?', (aid,)).fetchone())
        out.update({'tileIds': tile_ids, 'tileStates': tile_states,
                   'consumedAnnotationIds': [], 'createdStrokeId': sid, 'consumedGroups': []})
        return jsonify(out), 201
    finally:
        _db.close_db(con)


@projects_bp.patch('/api/annotations/<annotation_id>')
@login_required
def update_annotation(annotation_id: str):
    """Edit points/label in place. Only non-fusing kinds (point/line/polygon) support this
    — a `stroke` mask is fused geometry, not a single editable shape; erase + redraw
    instead (see docs/plans/Plan — Annotation-stroke model (fused masks).md)."""
    body = request.json or {}
    con = _db.get_db()
    try:
        row = con.execute('SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone()
        if not row or row['deleted_at']:
            return jsonify({'error': 'not found'}), 404
        if row['kind'] == 'stroke':
            return jsonify({'error': 'a fused mask cannot be edited directly; erase and redraw'}), 422
        err = _member_or_403(con, row['project_id']) or _owner_or_403(row['annotator'])
        if err:
            return err
        old_tiles = [r['tile_id'] for r in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (annotation_id,)
        ).fetchall()]
        points = body.get('points', json.loads(row['points_json']) if row['points_json'] else [])
        label = body.get('label', row['label'])
        points_json = json.dumps(points)
        con.execute(
            'UPDATE annotation SET points_json = ?, label = ?, updated_at = ? WHERE id = ?',
            (points_json, label, _now(), annotation_id),
        )
        con.execute('UPDATE stroke SET points_json = ? WHERE annotation_id = ?',
                   (points_json, annotation_id))
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
    """Soft delete this exact annotation (mask or 1:1 shape); tiles it touched go dirty."""
    con = _db.get_db()
    try:
        row = con.execute('SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone()
        if not row:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, row['project_id']) or _owner_or_403(row['annotator'])
        if err:
            return err
        tiles = [r['tile_id'] for r in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (annotation_id,)
        ).fetchall()]
        con.execute('UPDATE annotation SET deleted_at = ? WHERE id = ?', (_now(), annotation_id))
        tile_states = _mark_tiles_dirty(con, tiles, row['annotator'])
        con.commit()
        return jsonify({'ok': True, 'tileStates': tile_states})
    finally:
        _db.close_db(con)


# ── bulk mutate (eraser-undo + draw-undo/redo) ────────────────────────────────

@projects_bp.post('/api/projects/<project_id>/annotations/mutate')
@login_required
def mutate_annotations(project_id: str):
    """Bulk delete or restore whole annotations (for erase-undo + plain draw undo/redo —
    a create with no fuse reverses cleanly this way; a create THAT fused needs the
    compound /annotations/reverse endpoint below instead, since it must also repoint
    strokes).

    Body: { 'op': 'delete'|'restore', 'ids': [annId, ...] }
    All ids must belong to the same project_image_id and annotator (enforced by the
    eraser/undo design; a mismatch here is a client bug, not a valid request).
    Returns: { 'ok': True, 'ids': [...], 'tileStates': [...] }
    """
    body = request.json or {}
    op = body.get('op')
    ids = body.get('ids') or []
    if op not in ('delete', 'restore') or not ids:
        return jsonify({'error': 'op (delete|restore) and ids required'}), 400
    con = _db.get_db()
    try:
        err = _member_or_403(con, project_id)
        if err:
            return err
        annotator = None
        for ann_id in ids:
            row = con.execute('SELECT * FROM annotation WHERE id = ?', (ann_id,)).fetchone()
            if not row:
                return jsonify({'error': f'annotation {ann_id} not found'}), 404
            if row['project_id'] != project_id:
                return jsonify({'error': 'forbidden'}), 403
            e = _owner_or_403(row['annotator'])
            if e:
                return e
            if annotator is None:
                annotator = row['annotator']
        now = _now()
        # BUGS #16: either direction (erase or undo/redo-restore) re-opens a completed tile
        # it touches for this annotator. Dedupe by tileId across ids in case several
        # annotations land in the same tile.
        dirtied: dict[str, dict] = {}
        if op == 'delete':
            for ann_id in ids:
                tiles = [r['tile_id'] for r in con.execute(
                    'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (ann_id,)
                ).fetchall()]
                con.execute('UPDATE annotation SET deleted_at = ? WHERE id = ?', (now, ann_id))
                for d in _mark_tiles_dirty(con, tiles, annotator):
                    dirtied[d['tileId']] = d
        else:  # restore
            con.execute(
                f'UPDATE annotation SET deleted_at = NULL WHERE id IN ({",".join("?" * len(ids))})',
                ids,
            )
            qmarks = ','.join('?' * len(ids))
            tiles = [r['tile_id'] for r in con.execute(
                f'SELECT DISTINCT tile_id FROM annotation_tile WHERE annotation_id IN ({qmarks})',
                ids,
            ).fetchall()]
            for d in _mark_tiles_dirty(con, tiles, annotator):
                dirtied[d['tileId']] = d
        con.commit()
        return jsonify({'ok': True, 'ids': ids, 'tileStates': list(dirtied.values())})
    finally:
        _db.close_db(con)


@projects_bp.post('/api/projects/<project_id>/annotations/erase-stroke')
@login_required
def erase_stroke(project_id: str):
    """Brush eraser: soft-delete every LIVE annotation of this image+annotator (any kind)
    whose painted footprint intersects the swept eraser brush polygon.

    Erase deletes the WHOLE intersected annotation(s) — no stroke-level logic, no area-
    subtraction. Splits are impossible by construction: a mask only ever grows (via fuse)
    or is deleted whole. Geometry stays server-authoritative: the eraser polygon is built
    with the same `_stroke_polygon` helper used for paint strokes, and each candidate's own
    geometry via `_annotation_geom` (stored fused rings for masks, fresh points for 1:1
    kinds — never recomputed from raw strokes).

    Body: { imageId, annotator, points, strokeWidth, outline? } — same shape as a paint
    stroke commit (points + brush size, optionally the perfect-freehand outline).
    Returns: { deletedAnnotationIds: [...], tileStates: [...] }
    """
    body = request.json or {}
    image_id = body.get('imageId')
    points = body.get('points') or []
    stroke_width = body.get('strokeWidth')
    outline = body.get('outline')
    # Annotate-as-yourself, same admin bypass as create_annotation.
    if session.get('username') == 'admin':
        annotator = (body.get('annotator') or '').strip()
    else:
        annotator = session.get('username') or ''
    if not (image_id and points and annotator):
        return jsonify({'error': 'imageId, points, annotator required'}), 400
    con = _db.get_db()
    try:
        err = _member_or_403(con, project_id)
        if err:
            return err
        eraser_geom = _stroke_polygon(points, stroke_width, outline=outline)
        if eraser_geom is None or eraser_geom.is_empty:
            return jsonify({'deletedAnnotationIds': [], 'tileStates': []})
        rows = con.execute(
            '''SELECT * FROM annotation
               WHERE project_image_id = ? AND annotator = ? AND deleted_at IS NULL''',
            (image_id, annotator),
        ).fetchall()
        deleted_ids = []
        for r in rows:
            g = _annotation_geom(r)
            if g is not None and not g.is_empty and g.intersects(eraser_geom):
                deleted_ids.append(r['id'])
        dirtied: dict[str, dict] = {}
        if deleted_ids:
            now = _now()
            qmarks = ','.join('?' * len(deleted_ids))
            con.execute(
                f'UPDATE annotation SET deleted_at = ? WHERE id IN ({qmarks})',
                (now, *deleted_ids),
            )
            for ann_id in deleted_ids:
                tiles = [t['tile_id'] for t in con.execute(
                    'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (ann_id,)
                ).fetchall()]
                for d in _mark_tiles_dirty(con, tiles, annotator):
                    dirtied[d['tileId']] = d
            con.commit()
        return jsonify({'deletedAnnotationIds': deleted_ids, 'tileStates': list(dirtied.values())})
    finally:
        _db.close_db(con)


@projects_bp.post('/api/projects/<project_id>/annotations/reverse')
@login_required
def reverse_annotation_merge(project_id: str):
    """Undo a brush create/merge (compound op): hard-delete the created `annotation` +
    its bridging `stroke`, resurrect every consumed annotation (flip deleted_at back to
    NULL) and repoint their strokes back to their original owner. See docs/plans/
    Plan — Annotation-stroke model (fused masks).md §Undo/redo.

    There is no matching "forward-replay" endpoint for redo — the client just re-POSTs
    the original create_annotation body, which re-derives the same merge deterministically
    against the now-resurrected originals (see canvasHistory.ts's `merge` redo path).

    Body: { annotationId, strokeId, consumedGroups: [{annotationId, strokeIds}, ...] }
    Returns: { ok, resurrected: [...], deletedAnnotationId, tileStates: [...] }
    """
    body = request.json or {}
    annotation_id = body.get('annotationId')
    stroke_id = body.get('strokeId')
    groups = body.get('consumedGroups') or []
    if not (annotation_id and stroke_id and groups):
        return jsonify({'error': 'annotationId, strokeId, consumedGroups required'}), 400
    con = _db.get_db()
    try:
        row = con.execute('SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone()
        if not row:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, project_id) or _owner_or_403(row['annotator'])
        if err:
            return err
        created_tiles = [r['tile_id'] for r in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (annotation_id,)
        ).fetchall()]
        con.execute('DELETE FROM stroke WHERE id = ?', (stroke_id,))
        consumed_ids = [g['annotationId'] for g in groups]
        for g in groups:
            stroke_ids = g.get('strokeIds') or []
            if stroke_ids:
                qmarks = ','.join('?' * len(stroke_ids))
                con.execute(f'UPDATE stroke SET annotation_id = ? WHERE id IN ({qmarks})',
                           (g['annotationId'], *stroke_ids))
        qmarks = ','.join('?' * len(consumed_ids))
        con.execute(f'UPDATE annotation SET deleted_at = NULL, updated_at = ? WHERE id IN ({qmarks})',
                   (_now(), *consumed_ids))
        con.execute('DELETE FROM annotation WHERE id = ?', (annotation_id,))  # cascades annotation_tile

        dirtied: dict[str, dict] = {}
        resurrected = []
        for cid in consumed_ids:
            r = con.execute('SELECT * FROM annotation WHERE id = ?', (cid,)).fetchone()
            if not r:
                continue
            tile_ids = _tiles_for_geom(con, r['project_image_id'], _annotation_geom(r))
            for tid in tile_ids:
                con.execute(
                    'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                    (cid, tid),
                )
            for d in _mark_tiles_dirty(con, tile_ids, r['annotator']):
                dirtied[d['tileId']] = d
            resurrected.append(_annotation_out(r))
        for d in _mark_tiles_dirty(con, created_tiles, row['annotator']):
            dirtied[d['tileId']] = d
        con.commit()
        return jsonify({'ok': True, 'resurrected': resurrected,
                        'deletedAnnotationId': annotation_id, 'tileStates': list(dirtied.values())})
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
        # Resolve project_id through the annotator_tile → batch_tile → batch chain.
        at_row = con.execute(
            '''SELECT b.project_id, at.annotator FROM annotator_tile at
               JOIN batch_tile bt ON bt.id = at.batch_tile_id
               JOIN batch b ON b.id = bt.batch_id
               WHERE at.id = ?''', (at_id,),
        ).fetchone()
        if not at_row:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, at_row['project_id']) or _owner_or_403(at_row['annotator'])
        if err:
            return err
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
        if not im:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, im['project_id'])
        if err:
            return err
    finally:
        _db.close_db(con)
    img = imaging.get_image(im['image_hash'], im['image_ext'])
    return send_file(_bytesio(imaging.overview_png(img)), mimetype='image/png')


@projects_bp.get('/api/projects/images/<image_id>/crop')
@login_required
def image_crop(image_id: str):
    con = _db.get_db()
    try:
        im = _image_row(con, image_id)
        if not im:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, im['project_id'])
        if err:
            return err
    finally:
        _db.close_db(con)
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
