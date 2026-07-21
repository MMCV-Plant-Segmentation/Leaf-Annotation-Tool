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
from . import imaging, tile_cache, tiling
from .auth import admin_required, login_required
from . import taxonomy

projects_bp = Blueprint('projects', __name__)

# Sentinel default for `_annotation_out(raw_taxonomy=...)`: distinguishes "caller has no
# taxonomy handy" (fall back to the frozen label_snapshot, pre-t64 behaviour) from
# "caller passed an explicit None/'' taxonomy value" (still resolved, yields no match).
_UNSET = object()

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
    """Shape a project row for JSON (taxonomy v2: groups + compounds + flat classes).

    `classes_json` is upgraded from any legacy form (string-array / object-array) to the
    canonical taxonomy-v2 shape (see webapp.taxonomy): `groups`, `compounds` (the valid
    paintable palette), and `classes` (the compounds projected to the legacy flat
    `{id,name,color,order}` list, kept so every existing call site keeps working). The
    upgraded form is NOT persisted here — the next project write that touches the taxonomy
    re-serialises it; reads stay lenient/lossless.
    """
    out = dict(row)
    tax = taxonomy.taxonomy_out(row.get('classes_json'))
    out['classes'] = tax['classes']
    out['groups'] = tax['groups']
    out['compounds'] = tax['compounds']
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
        # Keep sub-pixel precision (BUGS #37): the FE maps client→image px as floats via the
        # CTM, so snapping to whole pixels loses accuracy and collapses a <1px-wide (thin/
        # vertical) stroke's two edges onto one column → a zero-area path that vanishes.
        return [[round(float(pt[0]), 2), round(float(pt[1]), 2)] for pt in ring.coords]
    return [coords(poly.exterior)]


def _exterior_only(geom):
    """Rebuild `geom` with interior holes filled in (exterior ring(s) only).

    `buffer(0)` on a self-intersecting outline (e.g. a loop drawn around a lesion without
    touching it) produces a polygon whose enclosed area is an interior hole — the loop's
    hole, not solid fill. `_poly_rings` already drops holes when STORING a fused brush
    mask's geometry, which is why a painted loop visually fills solid; this is the same
    fix applied in-memory to a `Polygon` or `MultiPolygon` before an intersection test, so
    the eraser's loop-fills-solid behavior matches the brush's.

    Returns None for empty/degenerate input.
    """
    if geom is None or geom.is_empty:
        return None
    parts = list(geom.geoms) if geom.geom_type == 'MultiPolygon' else [geom]
    solids = [ShapelyPolygon(p.exterior) for p in parts if p.geom_type == 'Polygon' and p.exterior]
    solids = [s for s in solids if s.is_valid and not s.is_empty]
    if not solids:
        return None
    return unary_union(solids)


def _footprint(points, stroke_width, outline=None):
    """The solid painted footprint of a stroke — the ONE geometry both paint and erase use.

    `_stroke_polygon` gives the raw shape (which `buffer(0)` can leave holed for a self-
    intersecting loop); `_exterior_only` fills those holes so a loop drawn AROUND something still
    englobes it. Consolidated 2026-07-02 so brush and eraser behave identically: circling a dot
    with the brush fuses it into one filled blob, exactly as circling with the eraser deletes it.
    """
    return _exterior_only(_stroke_polygon(points, stroke_width, outline=outline))


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
    # Taxonomy v2: accept either a v2 body ({groups, compounds}) or the legacy flat
    # `classes` list; both funnel through coerce_taxonomy -> dump_taxonomy. A new/empty
    # project seeds the single removable 'unknown' compound (backed by one default
    # group), so it behaves exactly like today's default - no hardcoded trio.
    taxonomy_body = body.get('taxonomy') or body.get('classes')
    if body.get('groups') is not None or body.get('compounds') is not None:
        taxonomy_body = {'groups': body.get('groups') or [],
                         'compounds': body.get('compounds') or []}
    if taxonomy_body is None:
        classes_json = taxonomy.dump_taxonomy(taxonomy.normalise_taxonomy('[]'))
    else:
        classes_json = taxonomy.dump_taxonomy(taxonomy.coerce_taxonomy(taxonomy_body))
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
            (pid, name, tile_size, threshold, classes_json,
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
        # Taxonomy v2: the editor sends a v2 object ({groups, compounds}); a legacy
        # flat `classes` list still upgrades cleanly. Both funnel through coerce/dump.
        # Member permission model unchanged (NOT admin-only).
        if 'taxonomy' in body or 'groups' in body or 'compounds' in body or 'classes' in body:
            if 'groups' in body or 'compounds' in body:
                tax_body = {'groups': body.get('groups') or [],
                            'compounds': body.get('compounds') or []}
            elif 'taxonomy' in body:
                tax_body = body['taxonomy']
            else:
                tax_body = body['classes']
            existing_row = _project(con, project_id)
            existing_raw = existing_row.get('classes_json') if existing_row else None
            # t64 C3: a saved compound's `selections` are IMMUTABLE — coerce_taxonomy
            # re-applies the STORED selections for any incoming compound id that already
            # existed (name/colour changes ARE honoured); only a brand-new id may set
            # selections.
            new_v2 = taxonomy.coerce_taxonomy(tax_body, existing=existing_raw)
            # t64 C4/C5/C6: a save that DROPS a previously-saved compound id must not
            # silently orphan lesions that reference it (`annotation.compound_id`).
            # Unreferenced -> deletes freely. Referenced + no `reassignCompounds` entry
            # -> reject (4xx naming the blocked id), nothing persisted. Referenced +
            # entry (mapping to a compound id still present after this save) -> repoint
            # those annotations' compound_id to the target, then persist without the old.
            existing_ids = {c['id'] for c in taxonomy.normalise_taxonomy(existing_raw)['compounds']}
            new_ids = {c['id'] for c in new_v2['compounds']}
            reassign = body.get('reassignCompounds') or {}
            repoint: dict[str, str] = {}
            for removed_id in existing_ids - new_ids:
                referenced = con.execute(
                    '''SELECT 1 FROM annotation
                       WHERE project_id = ? AND compound_id = ? AND deleted_at IS NULL
                       LIMIT 1''',
                    (project_id, removed_id),
                ).fetchone()
                if not referenced:
                    continue
                target = reassign.get(removed_id)
                if not target or target not in new_ids:
                    # `blockedCompoundId` is a structured echo of the same id named in
                    # `error` — the FE reassignment picker (LabelEditor.tsx) keys off it
                    # rather than parsing the human-readable message.
                    return jsonify({
                        'error': f'compound {removed_id} is referenced by existing '
                                 f'annotations; reassignCompounds must map it to another '
                                 f'compound before it can be deleted',
                        'blockedCompoundId': removed_id,
                    }), 409
                repoint[removed_id] = target
            for old_id, new_id in repoint.items():
                con.execute(
                    'UPDATE annotation SET compound_id = ? WHERE project_id = ? AND compound_id = ?',
                    (new_id, project_id, old_id),
                )
            classes_json = taxonomy.dump_taxonomy(new_v2)
            sets.append('classes_json = ?'); vals.append(classes_json)
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
            b['mergeReady'] = _merge_ready(con, b['id'])
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
    """Pre-flight dedup probe: given candidate content hashes, return the subset whose
    bytes ALREADY EXIST in the global content-addressed store — i.e. referenced by ANY
    project, not just this one (BUGS #26: global dedup, approved by Christian). Read-only
    — no bytes, no writes. Lets the browser skip re-uploading content already on disk;
    for content present globally but not yet in THIS project, the client registers it by
    hash via /images/register instead of re-sending bytes.

    Body {"hashes": [...]}  →  {"have": [...]}. Hashes are imaging.hash_bytes() values
    (sha256(bytes).hexdigest()[:24]); the client reproduces the scheme byte-for-byte.

    NOTE: "have" here means "the bytes are on disk somewhere" — the DB still guards which
    images are VISIBLE in which project (register-by-hash inserts the per-project row).
    Reporting a hash as present does NOT make its content viewable across projects.
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
        # GLOBAL: a hash is "have" when ANY project references it (the bytes are on disk in
        # the content-addressed store). De-dupe + chunk so a huge folder can't blow past
        # SQLite's bound-variable limit. DISTINCT so a hash shared by many projects hits once.
        wanted = list({str(h) for h in hashes if h})
        have: list[str] = []
        for i in range(0, len(wanted), 500):
            chunk = wanted[i:i + 500]
            placeholders = ','.join('?' * len(chunk))
            rows = con.execute(
                f'SELECT DISTINCT image_hash FROM project_image '
                f'WHERE image_hash IN ({placeholders})',
                (*chunk,),
            ).fetchall()
            have.extend(r['image_hash'] for r in rows)
        return jsonify({'have': have})
    finally:
        _db.close_db(con)


def _register_one_by_hash(con, project_id: str, image_hash: str, source_name: str,
                          threshold: int, tile_size: int) -> dict:
    """Register an already-stored image into THIS project by content hash, WITHOUT
    re-uploading its bytes (BUGS #26). Pulls the stored bytes (via imaging.get_image, keyed
    by hash+ext copied from an existing project_image row anywhere in the system), recomputes
    THIS project's leaf_bbox/origin_y from its own threshold/tile_size, and inserts a
    project_image row. Idempotent: a row already present for (project_id, image_hash) is a
    no-op. Returns {'registered': bool, 'missing': bool} — 'missing' means the hash is
    genuinely not in the store and the client must fall back to the full upload path.

    Does NOT commit — the caller controls the transaction.
    """
    # Already in THIS project? UNIQUE(project_id, image_hash) — idempotent no-op.
    if con.execute(
        'SELECT 1 FROM project_image WHERE project_id = ? AND image_hash = ?',
        (project_id, image_hash),
    ).fetchone():
        return {'registered': True, 'missing': False}
    # The bytes are on disk only if SOME project references the hash. Grab ext + dims from
    # any existing row (they are content-derived: same hash ⇒ same image ⇒ same ext/dims).
    src = con.execute(
        'SELECT image_ext, width, height FROM project_image WHERE image_hash = ? LIMIT 1',
        (image_hash,),
    ).fetchone()
    if src is None:
        return {'registered': False, 'missing': True}
    ext = src['image_ext']
    img = imaging.get_image(image_hash, ext)
    w, hgt = img.size
    bb = tiling.compute_leaf_bbox(img, threshold)
    if bb is None:
        bb = tiling.Rect(0, 0, w, hgt)
    origin_y = tiling.bbox_centered_origin_y(bb, hgt, tile_size)
    con.execute(
        '''INSERT INTO project_image
             (id, project_id, image_hash, image_ext, source_name, source_path,
              width, height, origin_y, leaf_x, leaf_y, leaf_w, leaf_h, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (_uid(), project_id, image_hash, ext, source_name, None, w, hgt,
         origin_y, bb.x, bb.y, bb.w, bb.h, _now()),
    )
    return {'registered': True, 'missing': False}


@projects_bp.post('/api/projects/<project_id>/images/register')
@login_required
def register_images(project_id: str):
    """Register already-stored images into THIS project by content hash, WITHOUT
    re-uploading bytes (BUGS #26: global pre-flight dedup). For each hash whose bytes
    already exist in the global content-addressed store (any project references it),
    insert a project_image row for THIS project (ext/dims from the stored image, leaf_bbox
    + origin recomputed for this project's threshold/tile_size). Hashes that are genuinely
    absent from the store are returned as 'missing' so the client falls back to the normal
    full-upload path. UNIQUE(project_id, image_hash) is enforced (idempotent re-register).

    Body {"items": [{"hash": "...", "name": "..."}, ...]}
      → {"registered": [hash, ...], "missing": [hash, ...]}
    """
    items = (request.json or {}).get('items')
    if not isinstance(items, list):
        return jsonify({'error': 'items must be a list'}), 400
    con = _db.get_db()
    try:
        proj = _project(con, project_id)
        if not proj:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, project_id)
        if err:
            return err
        threshold, tile_size = proj['black_threshold'], proj['tile_size_px']
        registered: list[str] = []
        missing: list[str] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            h = str(it.get('hash') or '')
            if not h:
                continue
            name = str(it.get('name') or '')
            res = _register_one_by_hash(con, project_id, h, name, threshold, tile_size)
            if res['missing']:
                missing.append(h)
            else:
                registered.append(h)
        con.commit()
        return jsonify({'registered': registered, 'missing': missing})
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

        used = {
            (r['project_image_id'], r['x'], r['y'])
            for r in con.execute(
                '''SELECT t.project_image_id, t.x, t.y FROM tile t
                   JOIN project_image pi ON pi.id = t.project_image_id
                   WHERE pi.project_id = ?''', (project_id,)
            ).fetchall()
        }

        # Build candidate pool across images; exclude positions already tiled (= used by
        # a previous batch, since tiles are only created at batch time).
        #
        # PERF (task #4 root cause): the per-image work here — imaging.get_image (decode)
        # + tiling.surviving_tiles (full-resolution connected-component pixel analysis) —
        # used to run for EVERY project image on EVERY batch-creation call, regardless of
        # the requested `size` or whether tile_size/black_threshold had changed since the
        # last call. tile_cache.get_or_compute_tiles memoizes that per (image, tile_size,
        # threshold), so repeat batch creations become cheap in-memory lookups. On top of
        # that, images are scanned in RANDOM order and scanning stops early once the
        # unused-candidate pool comfortably exceeds what this call could ever need — so
        # even a cold first-ever batch on a huge project only pays for a bounded sample of
        # images, not a full-project sweep.
        # Deterministic per-batch RNG: the image scan order and the tile sample are a pure
        # function of (project_id, seq), so batch composition is reproducible in prod AND tests
        # and is safe under the concurrent test server (no shared process-global RNG state
        # consumed in nondeterministic order — the BUGS #31 flake root cause). seq is the next
        # batch number; compute it up front so it can seed the RNG.
        seq = (con.execute(
            'SELECT COALESCE(MAX(seq), 0) m FROM batch WHERE project_id = ?', (project_id,)
        ).fetchone()['m']) + 1
        rng = random.Random(f'{project_id}:{seq}')
        POOL_TARGET = max(size * 20, 200)
        shuffled = list(images)
        rng.shuffle(shuffled)
        pool: dict[tuple, tuple] = {}   # (image_id, x, y) -> (image_row, Rect)
        unused = 0
        for im in shuffled:
            for t in tile_cache.get_or_compute_tiles(im, proj['tile_size_px'], proj['black_threshold']):
                key = (im['id'], t.x, t.y)
                if key not in pool:
                    pool[key] = (im, t)
                    if key not in used:
                        unused += 1
            if unused >= POOL_TARGET:
                break
        picked = tiling.sample_positions(list(pool.keys()), used, size, rng=rng)
        if not picked:
            return jsonify({'error': 'no unused tiles left to sample'}), 409

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

def _merge_ready(con, batch_id: str) -> bool:
    """MERGE Phase 1 gate: a batch is merge-ready when EVERY annotator_tile for it
    (all its batch_tiles × all its roster annotators) has state='completed'. A batch
    with no annotator_tile rows at all (no tiles or no roster) is never ready."""
    row = con.execute(
        '''SELECT COUNT(*) total,
                  SUM(CASE WHEN at.state = 'completed' THEN 1 ELSE 0 END) done
           FROM annotator_tile at
           JOIN batch_tile bt ON bt.id = at.batch_tile_id
           WHERE bt.batch_id = ?''', (batch_id,)
    ).fetchone()
    total = row['total'] or 0
    done = row['done'] or 0
    return total > 0 and total == done


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
        tax = taxonomy.taxonomy_out(proj['classes_json']) if proj else taxonomy.taxonomy_out(None)
        classes = tax['classes']
        groups = tax['groups']
        compounds = tax['compounds']
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
                entry['annotations'] = _visible_annotations(
                    con, image_id, annotator,
                    [t['tileId'] for t in payload['tiles']],
                    proj['classes_json'] if proj else None)
            images.append(entry)
        return jsonify({
            'id': batch['id'], 'projectId': batch['project_id'], 'seq': batch['seq'],
            'status': batch['status'], 'mergeReady': _merge_ready(con, batch_id),
            'classes': classes, 'groups': groups, 'compounds': compounds, 'images': images,
        })
    finally:
        _db.close_db(con)


# ── merge mode (Phase 1: gate + blind pooled read) ────────────────────────────

@projects_bp.post('/api/batches/<batch_id>/enter-merge')
@login_required
def enter_merge(batch_id: str):
    """Advance a merge-ready batch to status='merge'. Idempotent when already in merge;
    409 when not yet merge-ready (every annotator_tile must be 'completed' — see
    _merge_ready)."""
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        if batch['status'] == 'merge':
            return jsonify({'ok': True, 'status': 'merge'})
        if not _merge_ready(con, batch_id):
            return jsonify({'error': 'batch is not merge-ready — every tile must be '
                                      'completed by every annotator'}), 409
        con.execute("UPDATE batch SET status = 'merge' WHERE id = ?", (batch_id,))
        con.commit()
        return jsonify({'ok': True, 'status': 'merge'})
    finally:
        _db.close_db(con)


def _pooled_annotations(con, image_id: str, active_tile_ids: list[str],
                        raw_taxonomy: Any = _UNSET) -> list:
    """Every LIVE annotation from EVERY annotator on this image that intersects an
    active tile — the merge-mode pooled read. Unlike _visible_annotations, this is
    cross-annotator BY DESIGN (that's the whole point of merge mode); blindness (all
    marks render identically, one colour, outline-only) is enforced client-side by
    MergeCanvasScreen, never by hiding whose mark is whose here — the merger is a
    project member and the data isn't secret, just visually anonymised."""
    if not active_tile_ids:
        return []
    qmarks = ','.join('?' * len(active_tile_ids))
    rows = con.execute(
        f'''SELECT DISTINCT a.* FROM annotation a
            JOIN annotation_tile atl ON atl.annotation_id = a.id
            WHERE a.project_image_id = ? AND a.deleted_at IS NULL
              AND atl.tile_id IN ({qmarks})''',
        (image_id, *active_tile_ids),
    ).fetchall()
    return [_annotation_out(r, raw_taxonomy=raw_taxonomy) for r in rows]


@projects_bp.get('/api/batches/<batch_id>/merge-annotations')
@login_required
def batch_merge_annotations(batch_id: str):
    """All non-deleted annotations from ALL annotators that intersect this batch's
    tiles — the pooled, blind read MergeCanvasScreen renders (Phase 1: read-only)."""
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        proj_row = _project(con, batch['project_id'])
        raw_taxonomy = proj_row.get('classes_json') if proj_row else None
        rows = con.execute(
            '''SELECT t.id tile_id, t.project_image_id FROM batch_tile bt
               JOIN tile t ON t.id = bt.tile_id
               WHERE bt.batch_id = ?''', (batch_id,)
        ).fetchall()
        tiles_by_image: dict[str, list[str]] = {}
        for r in rows:
            tiles_by_image.setdefault(r['project_image_id'], []).append(r['tile_id'])
        out = []
        for image_id, tile_ids in tiles_by_image.items():
            out.extend(_pooled_annotations(con, image_id, tile_ids, raw_taxonomy))
        return jsonify({'annotations': out})
    finally:
        _db.close_db(con)


# ── merge mode Phase 2a: candidate objects ────────────────────────────────────
# A candidate object (CO) is a merger's lesion-hypothesis during merge mode. Its
# identity is its MEMBER MARKS only (co_membership rows) — the convex-hull / union
# shape a merger sees is a FE display concern, not persisted here (see
# alembic/versions/0005_candidate_objects.py). Any project member may merge and
# owns/edits only their OWN COs.


def _batch_tile_ids_for_image(con, batch_id: str, image_id: str) -> list[str]:
    """Tile ids of this batch that lie on this image — the "active tiles" that
    scope which annotations are pooled for merge (see _pooled_annotations)."""
    rows = con.execute(
        '''SELECT t.id FROM batch_tile bt
           JOIN tile t ON t.id = bt.tile_id
           WHERE bt.batch_id = ? AND t.project_image_id = ?''',
        (batch_id, image_id),
    ).fetchall()
    return [r['id'] for r in rows]


def _pooled_annotation_ids_for_image(con, batch_id: str, image_id: str) -> set[str]:
    """The set of pooled annotation ids for this batch/image — the marks a merger
    is allowed to reference from a candidate object. Same scoping as
    `_pooled_annotations` (cross-annotator, live, intersects an active tile), but
    returns ids only for cheap membership checks."""
    tile_ids = _batch_tile_ids_for_image(con, batch_id, image_id)
    if not tile_ids:
        return set()
    qmarks = ','.join('?' * len(tile_ids))
    rows = con.execute(
        f'''SELECT DISTINCT a.id FROM annotation a
            JOIN annotation_tile atl ON atl.annotation_id = a.id
            WHERE a.project_image_id = ? AND a.deleted_at IS NULL
              AND atl.tile_id IN ({qmarks})''',
        (image_id, *tile_ids),
    ).fetchall()
    return {r['id'] for r in rows}


def _co_member_ids(con, coid: str) -> list[str]:
    return [r['annotation_id'] for r in con.execute(
        'SELECT annotation_id FROM co_membership WHERE candidate_object_id = ?',
        (coid,),
    ).fetchall()]


def _co_out(con, row: dict) -> dict:
    return {'id': row['id'], 'imageId': row['project_image_id'],
            'memberIds': _co_member_ids(con, row['id'])}


def _co_owner_or_403(row: dict):
    """A merger owns/edits only their OWN COs. Admin bypasses (matches _member_or_403).
    Returns a 403 tuple or None."""
    if session.get('username') == 'admin':
        return None
    if (row['merger'] or '') != (session.get('username') or ''):
        return jsonify({'error': 'forbidden'}), 403
    return None


def _resolve_brush_members(con, brush_path, brush_width, pooled_ids: set[str]) -> list[str]:
    """The BACKEND-side membership resolution for a brush-stroke CO create: build the
    stroke's shapely footprint (LineString + buffer) and pick every pooled mark whose
    stored geometry it intersects. Mirrors create_annotation's shapely usage — the
    client never resolves membership."""
    if not brush_path or brush_width is None or not pooled_ids:
        return []
    try:
        coords = [tuple(p) for p in brush_path]
        if len(coords) < 2:
            return []
        stroke = LineString(coords).buffer(float(brush_width) / 2.0)
    except (TypeError, ValueError):
        return []
    if stroke is None or stroke.is_empty:
        return []
    ids_list = list(pooled_ids)
    qmarks = ','.join('?' * len(ids_list))
    rows = con.execute(
        f'''SELECT * FROM annotation
            WHERE id IN ({qmarks}) AND deleted_at IS NULL''',
        (*ids_list,),
    ).fetchall()
    members = []
    for r in rows:
        g = _annotation_geom(r)
        if g is not None and not g.is_empty and stroke.intersects(g):
            members.append(r['id'])
    return members


@projects_bp.get('/api/batches/<batch_id>/candidate-objects')
@login_required
def list_candidate_objects(batch_id: str):
    """That merger's non-deleted COs for this batch."""
    merger = (request.args.get('merger') or '').strip()
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        rows = con.execute(
            '''SELECT * FROM candidate_object
               WHERE batch_id = ? AND merger = ? AND deleted_at IS NULL
               ORDER BY created_at ASC''',
            (batch_id, merger),
        ).fetchall()
        return jsonify({'candidateObjects': [_co_out(con, r) for r in rows]})
    finally:
        _db.close_db(con)


@projects_bp.post('/api/batches/<batch_id>/candidate-objects')
@login_required
def create_candidate_object(batch_id: str):
    """Create a CO from EITHER explicit `memberIds` OR a brush stroke.

    For a brush stroke: membership is resolved BACKEND-side via shapely against each
    pooled mark's stored geometry — the client sends the raw path + width only.
    For explicit `memberIds`: every id must be a pooled mark of this batch on this
    image (rejected 422 otherwise).
    """
    body = request.json or {}
    image_id = body.get('imageId')
    if not image_id:
        return jsonify({'error': 'imageId required'}), 400
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        im = _image_row(con, image_id)
        if not im or im['project_id'] != batch['project_id']:
            return jsonify({'error': 'imageId not in this batch project'}), 404
        pooled = _pooled_annotation_ids_for_image(con, batch_id, image_id)

        raw_member_ids = body.get('memberIds')
        brush_path = body.get('brushPath')
        if raw_member_ids is not None:
            member_ids = list(raw_member_ids)
            bad = [mid for mid in member_ids if mid not in pooled]
            if bad:
                return jsonify({'error': 'member id is not a pooled mark of this batch',
                                'invalidIds': bad}), 422
        elif brush_path is not None:
            brush_width = body.get('brushWidth')
            if brush_width is None:
                return jsonify({'error': 'brushWidth required'}), 400
            member_ids = _resolve_brush_members(con, brush_path, brush_width, pooled)
        else:
            return jsonify({'error': 'memberIds or brushPath required'}), 400

        coid = _uid()
        merger = session.get('username') or ''
        con.execute(
            '''INSERT INTO candidate_object
                 (id, batch_id, project_image_id, merger, created_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, NULL)''',
            (coid, batch_id, image_id, merger, _now()),
        )
        # De-duplicate to keep the (co, annotation) unique-pair contract.
        for mid in list(dict.fromkeys(member_ids)):
            con.execute(
                '''INSERT INTO co_membership (candidate_object_id, annotation_id)
                   VALUES (?, ?)''',
                (coid, mid),
            )
        con.commit()
        row = con.execute(
            'SELECT * FROM candidate_object WHERE id = ?', (coid,)
        ).fetchone()
        return jsonify(_co_out(con, row)), 201
    finally:
        _db.close_db(con)


@projects_bp.patch('/api/candidate-objects/<coid>')
@login_required
def patch_candidate_object(coid: str):
    """Group/ungroup a CO's members (addIds / removeIds). Emptying the CO
    soft-dissolves it (deleted_at set) — the merger's undo can then restore it
    (v1: no explicit restore endpoint; the row survives for provenance)."""
    body = request.json or {}
    add_ids = list(body.get('addIds') or [])
    remove_ids = list(body.get('removeIds') or [])
    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT * FROM candidate_object WHERE id = ?', (coid,)
        ).fetchone()
        if not row:
            return jsonify({'error': 'not found'}), 404
        batch = con.execute(
            'SELECT * FROM batch WHERE id = ?', (row['batch_id'],)
        ).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id']) or _co_owner_or_403(row)
        if err:
            return err
        if row['deleted_at']:
            return jsonify({'error': 'candidate object dissolved'}), 404

        if add_ids:
            pooled = _pooled_annotation_ids_for_image(
                con, row['batch_id'], row['project_image_id']
            )
            bad = [mid for mid in add_ids if mid not in pooled]
            if bad:
                return jsonify({'error': 'member id is not a pooled mark of this batch',
                                'invalidIds': bad}), 422
            for mid in add_ids:
                con.execute(
                    '''INSERT OR IGNORE INTO co_membership
                         (candidate_object_id, annotation_id) VALUES (?, ?)''',
                    (coid, mid),
                )
        if remove_ids:
            qmarks = ','.join('?' * len(remove_ids))
            con.execute(
                f'''DELETE FROM co_membership
                    WHERE candidate_object_id = ? AND annotation_id IN ({qmarks})''',
                (coid, *remove_ids),
            )

        remaining = con.execute(
            'SELECT COUNT(*) c FROM co_membership WHERE candidate_object_id = ?',
            (coid,),
        ).fetchone()['c']
        if remaining == 0:
            con.execute(
                'UPDATE candidate_object SET deleted_at = ? WHERE id = ?',
                (_now(), coid),
            )
        con.commit()
        row = con.execute(
            'SELECT * FROM candidate_object WHERE id = ?', (coid,)
        ).fetchone()
        return jsonify(_co_out(con, row))
    finally:
        _db.close_db(con)


@projects_bp.delete('/api/candidate-objects/<coid>')
@login_required
def dissolve_candidate_object(coid: str):
    """Soft-dissolve a CO (deleted_at set). The row + its co_membership edges are
    preserved for provenance; list_candidate_objects hides it going forward."""
    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT * FROM candidate_object WHERE id = ?', (coid,)
        ).fetchone()
        if not row:
            return jsonify({'error': 'not found'}), 404
        batch = con.execute(
            'SELECT * FROM batch WHERE id = ?', (row['batch_id'],)
        ).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id']) or _co_owner_or_403(row)
        if err:
            return err
        con.execute(
            'UPDATE candidate_object SET deleted_at = ? '
            'WHERE id = ? AND deleted_at IS NULL',
            (_now(), coid),
        )
        con.commit()
        return ('', 204)
    finally:
        _db.close_db(con)


# ── merge mode Phase 2a: erasures ─────────────────────────────────────────────
# An erasure = a per-merger "this mark is not a lesion / an error" vote on a
# pooled mark — a recoverable TOGGLE (delete the row to un-erase; recovery beyond
# undo/redo), scoped to the merger who cast it (see
# alembic/versions/0006_co_erasure.py). The source annotation is NEVER touched
# — erasure lives in its own table so un-erase always restores the mark from
# provenance. Mirrors the CO endpoints above (member-gated; per-merger visibility).


def _annotation_is_pooled_in_batch(con, batch_id: str, annotation_id: str) -> bool:
    """True iff `annotation_id` is a pooled mark of this batch — a live
    annotation that intersects any of the batch's active tiles. Same scoping as
    `_pooled_annotations` / `_pooled_annotation_ids_for_image`, generalised
    across every image in the batch (an erasure POST identifies a mark by id
    only — no imageId in the payload)."""
    row = con.execute(
        '''SELECT 1 FROM annotation a
           JOIN annotation_tile atl ON atl.annotation_id = a.id
           JOIN batch_tile bt ON bt.tile_id = atl.tile_id
           WHERE bt.batch_id = ? AND a.id = ? AND a.deleted_at IS NULL
           LIMIT 1''',
        (batch_id, annotation_id),
    ).fetchone()
    return row is not None


@projects_bp.get('/api/batches/<batch_id>/erasures')
@login_required
def list_erasures(batch_id: str):
    """That merger's erasures for this batch — the pooled-annotation ids they've
    toggled off. Per-merger isolation: another merger's erasures never appear
    here (co_erasure rows are keyed by (batch, merger, annotation))."""
    merger = (request.args.get('merger') or '').strip()
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        rows = con.execute(
            '''SELECT annotation_id FROM co_erasure
               WHERE batch_id = ? AND merger = ?
               ORDER BY created_at ASC''',
            (batch_id, merger),
        ).fetchall()
        return jsonify({'erasedIds': [r['annotation_id'] for r in rows]})
    finally:
        _db.close_db(con)


@projects_bp.post('/api/batches/<batch_id>/erasures')
@login_required
def create_erasure(batch_id: str):
    """Cast an erasure vote on a pooled mark for the acting merger. The mark
    must be a pooled mark of this batch (rejected 422 otherwise). Idempotent:
    a repeat erase of the same mark is a no-op — the
    UNIQUE (batch, merger, annotation) constraint dedupes so we never surface
    a 500 on a second erase."""
    body = request.json or {}
    annotation_id = body.get('annotationId')
    if not annotation_id:
        return jsonify({'error': 'annotationId required'}), 400
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        if not _annotation_is_pooled_in_batch(con, batch_id, annotation_id):
            return jsonify({'error': 'annotationId is not a pooled mark of this batch'}), 422
        merger = session.get('username') or ''
        con.execute(
            '''INSERT OR IGNORE INTO co_erasure
                 (id, batch_id, merger, annotation_id, created_at)
               VALUES (?, ?, ?, ?, ?)''',
            (_uid(), batch_id, merger, annotation_id, _now()),
        )
        con.commit()
        return jsonify({'ok': True, 'annotationId': annotation_id}), 201
    finally:
        _db.close_db(con)


@projects_bp.delete('/api/batches/<batch_id>/erasures/<annotation_id>')
@login_required
def delete_erasure(batch_id: str, annotation_id: str):
    """Un-erase (recoverable toggle) — drop the acting merger's erasure row on
    this mark. Idempotent: deleting a non-existent erasure is a no-op 204 (so
    an undo replaying against a stale state can't spuriously 404)."""
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        merger = session.get('username') or ''
        con.execute(
            '''DELETE FROM co_erasure
               WHERE batch_id = ? AND merger = ? AND annotation_id = ?''',
            (batch_id, merger, annotation_id),
        )
        con.commit()
        return ('', 204)
    finally:
        _db.close_db(con)


# ── merge mode Phase 2b: completeness + explicit submission ───────────────────
# A merger's pass is COMPLETE when every pooled mark for the batch is accounted
# for — a member of one of THAT merger's LIVE candidate objects (co_membership
# via candidate_object.deleted_at IS NULL) OR erased by that merger (co_erasure).
# Completeness only ENABLES; SUBMIT is the explicit "I'm done — lock my pass so
# agreement can compute across mergers" signal (a merger may reach completeness
# yet keep revising), recorded per merger in `merge_submission`
# (alembic/versions/0008_merge_submission.py). Mirrors the CO/erasure handlers
# above (member-gated; per-merger isolation).


def _pooled_annotation_ids_for_batch(con, batch_id: str) -> set[str]:
    """Every pooled mark id for this batch across all its images — the same
    scoping as `_pooled_annotations` / `_pooled_annotation_ids_for_image`
    (cross-annotator, live, intersects an active batch tile), rolled up per
    batch for the completeness count."""
    rows = con.execute(
        '''SELECT DISTINCT a.id FROM annotation a
           JOIN annotation_tile atl ON atl.annotation_id = a.id
           JOIN batch_tile bt ON bt.tile_id = atl.tile_id
           WHERE bt.batch_id = ? AND a.deleted_at IS NULL''',
        (batch_id,),
    ).fetchall()
    return {r['id'] for r in rows}


def _merger_accounted_ids(con, batch_id: str, merger: str, pooled: set[str]) -> set[str]:
    """The distinct pooled marks THIS merger has accounted for on this batch —
    (members of their LIVE COs via co_membership) ∪ (their erasures via
    co_erasure). Intersected with `pooled` so a mark that has since dropped
    out of the pool can never count. Per-merger by design."""
    if not pooled:
        return set()
    accounted: set[str] = set()
    rows = con.execute(
        '''SELECT DISTINCT m.annotation_id FROM co_membership m
           JOIN candidate_object c ON c.id = m.candidate_object_id
           WHERE c.batch_id = ? AND c.merger = ? AND c.deleted_at IS NULL''',
        (batch_id, merger),
    ).fetchall()
    accounted.update(r['annotation_id'] for r in rows)
    rows = con.execute(
        '''SELECT annotation_id FROM co_erasure
           WHERE batch_id = ? AND merger = ?''',
        (batch_id, merger),
    ).fetchall()
    accounted.update(r['annotation_id'] for r in rows)
    return accounted & pooled


@projects_bp.get('/api/batches/<batch_id>/merge-completeness')
@login_required
def merge_completeness(batch_id: str):
    """That merger's pass status on this batch: total pooled marks, how many
    they've accounted for (CO-member or erased), whether that's complete, and
    whether they've submitted (with the ISO timestamp). Read-only; per-merger."""
    merger = (request.args.get('merger') or '').strip()
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        pooled = _pooled_annotation_ids_for_batch(con, batch_id)
        accounted = _merger_accounted_ids(con, batch_id, merger, pooled)
        total = len(pooled)
        n_acc = len(accounted)
        row = con.execute(
            'SELECT submitted_at FROM merge_submission WHERE batch_id = ? AND merger = ?',
            (batch_id, merger),
        ).fetchone()
        submitted_at = row['submitted_at'] if row else None
        return jsonify({
            'total': total,
            'accounted': n_acc,
            'complete': n_acc == total,
            'submitted': submitted_at is not None,
            'submittedAt': submitted_at,
        })
    finally:
        _db.close_db(con)


@projects_bp.post('/api/batches/<batch_id>/submit-merge')
@login_required
def submit_merge(batch_id: str):
    """Lock the SESSION user's merge pass on this batch — 409 if their pass
    isn't complete (every pooled mark accounted for via CO-member or erasure),
    otherwise UPSERT the merge_submission row so re-submit is idempotent
    (never a 500) and returns the recorded timestamp."""
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        merger = session.get('username') or ''
        pooled = _pooled_annotation_ids_for_batch(con, batch_id)
        accounted = _merger_accounted_ids(con, batch_id, merger, pooled)
        if len(accounted) < len(pooled):
            return jsonify({'error': 'merge pass is not complete',
                            'total': len(pooled), 'accounted': len(accounted)}), 409
        # (batch_id, merger) is the PK — a repeat submit refreshes submitted_at
        # instead of raising a UNIQUE conflict.
        con.execute(
            '''INSERT INTO merge_submission (batch_id, merger, submitted_at)
               VALUES (?, ?, ?)
               ON CONFLICT (batch_id, merger)
               DO UPDATE SET submitted_at = excluded.submitted_at''',
            (batch_id, merger, _now()),
        )
        con.commit()
        row = con.execute(
            'SELECT submitted_at FROM merge_submission WHERE batch_id = ? AND merger = ?',
            (batch_id, merger),
        ).fetchone()
        return jsonify({'ok': True, 'submittedAt': row['submitted_at']})
    finally:
        _db.close_db(con)


@projects_bp.delete('/api/batches/<batch_id>/submit-merge')
@login_required
def unsubmit_merge(batch_id: str):
    """Un-submit — drop the SESSION user's merge_submission row so they may
    revise. Idempotent (no row is a no-op 204)."""
    con = _db.get_db()
    try:
        batch = con.execute('SELECT * FROM batch WHERE id = ?', (batch_id,)).fetchone()
        if not batch:
            return jsonify({'error': 'not found'}), 404
        err = _member_or_403(con, batch['project_id'])
        if err:
            return err
        merger = session.get('username') or ''
        con.execute(
            'DELETE FROM merge_submission WHERE batch_id = ? AND merger = ?',
            (batch_id, merger),
        )
        con.commit()
        return ('', 204)
    finally:
        _db.close_db(con)


def _visible_annotations(con, image_id: str, annotator: str, active_tile_ids: list[str],
                         raw_taxonomy: Any = _UNSET) -> list:
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
    return [_annotation_out(r, con, raw_taxonomy=raw_taxonomy) for r in rows]


def _member_strokes_out(con, annotation_id: str) -> list:
    """Member strokes of a fused mask, shaped for JSON — the per-stroke clicked/mouse
    vertices (a11y #40 v1b vertex editing). A stroke's `points` are the raw input path
    (polyline = clicked vertices; brush = the freehand trail); the FE draws draggable
    handles from them when the mask is selected and PATCHes /strokes/<id> to reshape.

    t50 phase 1: `points` is reconstructed from the normalized `vertex`/`stroke_vertex`
    tables (the source of truth), NOT `stroke.points_json` — see `_read_stroke_vertices`.
    """
    rows = con.execute(
        'SELECT id, tool, stroke_width FROM stroke WHERE annotation_id = ?',
        (annotation_id,)).fetchall()
    return [{'id': s['id'], 'tool': s['tool'],
             'points': _read_stroke_vertices(con, s['id']),
             'vertexIds': _read_stroke_vertex_ids(con, s['id']),
             'strokeWidth': s['stroke_width']} for s in rows]


def _annotation_out(row: dict, con=None, raw_taxonomy: Any = _UNSET) -> dict:
    """Shape an `annotation` (mask) row for JSON. kind='stroke' masks render from the
    stored fused `rings` (geometry_json); other kinds render from their own `points`
    (never fused, so points_json is always the exact shape that was drawn).

    t64: `label`/`labelColor`/`labelSnapshot` resolve LIVE by `compound_id` from
    `raw_taxonomy` (the project's CURRENT `classes_json`, passed by the caller) — so a
    rename/recolour of a compound flows through to every lesion that references it.
    Falls back to the frozen `label_snapshot` column (and bare `label` text) only when
    `compound_id` is null/unresolvable (legacy data, or `raw_taxonomy` wasn't supplied
    by a caller that doesn't have it handy — same lenient behaviour as before t64).

    When `con` is supplied, a stroke mask also carries its `strokes` (member vertices)
    so the FE can offer vertex editing (a11y #40 v1b) — omitted otherwise (small extra
    query kept opt-in for callers that don't need it)."""
    is_mask = row['kind'] == 'stroke'
    rings = json.loads(row['geometry_json']) if (is_mask and row['geometry_json']) else []
    points = [] if is_mask else (json.loads(row['points_json']) if row['points_json'] else [])
    compound_id = row.get('compound_id') if isinstance(row, dict) else None
    live = None
    if compound_id and raw_taxonomy is not _UNSET:
        live = taxonomy.resolve_compound_snapshot(raw_taxonomy, compound_id)
    if live is not None:
        snapshot, label, label_color = live, live['name'], live['color']
    else:
        snap_raw = row.get('label_snapshot') if isinstance(row, dict) else None
        snapshot = json.loads(snap_raw) if snap_raw else None
        label = row['label']
        label_color = snapshot.get('color') if snapshot else None
    out = {
        'id': row['id'], 'kind': row['kind'], 'passNo': row['pass_no'],
        'points': points, 'rings': rings, 'label': label,
        'labelColor': label_color, 'labelSnapshot': snapshot,
        'viewport': json.loads(row['viewport_json']) if row['viewport_json'] else None,
        'annotator': row['annotator'], 'imageId': row['project_image_id'],
    }
    if is_mask and con is not None:
        out['strokes'] = _member_strokes_out(con, row['id'])
    return out


# ── annotations CRUD (the painting data sink) ─────────────────────────────────

def _insert_stroke(con, sid: str, annotation_id: str, kind: str, points: list,
                   stroke_width, outline, now: str, tool: str = 'brush',
                   vertex_refs: list | None = None) -> None:
    """INSERT the provenance-only `stroke` row bridged to its owning `annotation`.

    `tool` records the input mode that created the stroke (brush | polyline) — brush and
    polyline are two ways of producing the same stroke data (a11y #40). It drives editing
    affordances (a polyline's clicked vertices are editable), never fusion.

    `vertex_refs` (t50 phase 2a) — see `_write_stroke_vertices`.
    """
    con.execute(
        '''INSERT INTO stroke (id, annotation_id, kind, points_json, stroke_width,
             outline_json, created_at, tool)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
        (sid, annotation_id, kind, json.dumps(points), stroke_width,
         json.dumps(outline) if outline is not None else None, now, tool),
    )
    _write_stroke_vertices(con, sid, points, vertex_refs)


def _write_stroke_vertices(con, stroke_id: str, points: list,
                           vertex_refs: list | None = None) -> None:
    """t50 phase 1/2a: write-through — replace `stroke_id`'s ordered vertex list to match
    `points` (delete + reinsert stroke_vertex rows, the whole-stroke edit granularity this
    phase supports).

    `vertex_refs` (t50 phase 2a, optional, parallel to `points`): per point, either an
    EXISTING vertex id to REFERENCE (a draw-time snap → the new/edited stroke_vertex row
    points at that SAME vertex, sharing/locking it with whatever else already references
    it), or None/absent to MINT a fresh vertex (phase-1 behaviour, back-compatible when
    `vertex_refs` is omitted entirely). A ref to a vertex id that doesn't actually exist
    just falls back to minting — never crashes. A referenced vertex's `x,y` is NEVER
    rewritten here — the FE snapped to its canonical position, which stays authoritative.

    Reconciliation ordering matters: we WRITE the new stroke_vertex rows first (so a
    reused id keeps its row, e.g. re-sending a stroke's own vertexIds as refs is a
    no-op-shape re-point) and only THEN garbage-collect vertices this stroke used to
    reference — a vertex still referenced by another stroke_vertex row (this stroke's new
    rows, or another stroke's rows — a share) survives; nothing else does.
    """
    old_vids = [r['vertex_id'] for r in con.execute(
        'SELECT vertex_id FROM stroke_vertex WHERE stroke_id = ?', (stroke_id,)).fetchall()]
    con.execute('DELETE FROM stroke_vertex WHERE stroke_id = ?', (stroke_id,))
    refs = vertex_refs if vertex_refs is not None else []
    for seq, p in enumerate(points or []):
        ref = refs[seq] if seq < len(refs) else None
        x, y = float(p[0]), float(p[1])
        size = float(p[2]) if len(p) >= 3 and p[2] is not None else None
        vid = None
        if ref is not None:
            exists = con.execute('SELECT 1 FROM vertex WHERE id = ?', (ref,)).fetchone()
            if exists:
                vid = ref
        if vid is None:
            vid = _uid()
            con.execute('INSERT INTO vertex (id, x, y) VALUES (?, ?, ?)', (vid, x, y))
        con.execute(
            'INSERT INTO stroke_vertex (stroke_id, seq, vertex_id, size) VALUES (?, ?, ?, ?)',
            (stroke_id, seq, vid, size))
    # GC AFTER writing the new refs (not before) — a vertex this stroke used to reference
    # is deleted only if nothing (this stroke's new rows, or another stroke) references it
    # anymore; a shared vertex survives.
    if old_vids:
        qm = ','.join('?' * len(old_vids))
        con.execute(
            f'DELETE FROM vertex WHERE id IN ({qm}) '
            'AND id NOT IN (SELECT vertex_id FROM stroke_vertex)', old_vids)


def _read_stroke_vertices(con, stroke_id: str) -> list:
    """t50 phase 1: the ordered `[[x,y]]`/`[[x,y,size]]` point list reconstructed from the
    normalized `vertex`/`stroke_vertex` tables — the source of truth (see
    `_write_stroke_vertices`). A 3-tuple is emitted when the reference's `size` is
    non-NULL, a 2-tuple otherwise, so the exact drawn shape round-trips."""
    rows = con.execute(
        '''SELECT v.x AS x, v.y AS y, sv.size AS size
           FROM stroke_vertex sv JOIN vertex v ON v.id = sv.vertex_id
           WHERE sv.stroke_id = ? ORDER BY sv.seq''', (stroke_id,)).fetchall()
    return [[r['x'], r['y']] if r['size'] is None else [r['x'], r['y'], r['size']]
            for r in rows]


def _read_stroke_vertex_ids(con, stroke_id: str) -> list:
    """t50 phase 2a: the ordered `vertex_id` list parallel to `_read_stroke_vertices` —
    the stable per-point identity the FE indexes (position → vertex id) and later sends
    back as a `vertexRefs` snap-lock or id-stable reconciliation ref."""
    rows = con.execute(
        'SELECT vertex_id FROM stroke_vertex WHERE stroke_id = ? ORDER BY seq',
        (stroke_id,)).fetchall()
    return [r['vertex_id'] for r in rows]


# ── Session-free permission checks (call sites: the do_* mutators below, which are also
#    reached from the WebSocket op handler in webapp/asgi.py that runs outside a Flask
#    request context and so cannot read `session`). The Flask shims still use the older
#    session-driven helpers above; both must stay in sync. ─────────────────────────────

def _member_or_403_direct(con, project_id: str, username: str | None, user_id):
    """Session-free variant of _member_or_403 — takes user identity as explicit args.
    Returns None (permitted) or ({'error': 'forbidden'}, 403). Admin bypasses."""
    if username == 'admin':
        return None
    row = con.execute(
        'SELECT 1 FROM project_annotator WHERE project_id = ? AND user_id = ?',
        (project_id, user_id),
    ).fetchone()
    if row is None:
        return {'error': 'forbidden'}, 403
    return None


def _owner_or_403_direct(row_annotator: str | None, username: str | None):
    """Session-free variant of _owner_or_403. Admin bypasses."""
    if username == 'admin':
        return None
    if (row_annotator or '') != (username or ''):
        return {'error': 'forbidden'}, 403
    return None


# ── The mutation core (do_* functions) ──────────────────────────────────────────────────
#
# The polyline undo-determinism fix (feat/annotation-ws Phase 1) makes the WebSocket the
# single ordered channel for annotation ops so all writes serialize per connection. To keep
# ONE mutation path (BE tests are our guardrail the WS extraction didn't drift), the Flask
# route bodies for `create_annotation` / `edit_stroke` / `reverse_stroke_edit` moved into
# these plain `do_*(con, project_id, body, username, user_id, is_admin) -> (dict, status)`
# functions. Both the REST shims below AND the WS op handler in webapp/asgi.py call these
# same functions — the HTTP contract is UNCHANGED (BE tests still enforce it).

def do_create_annotation(con, project_id: str, body: dict, *,
                          username: str | None, user_id, is_admin: bool):
    """Core of create_annotation — returns (response_dict, status). See the route shim's
    docstring below for the full contract."""
    image_id = body.get('imageId')
    kind = body.get('kind')
    points = body.get('points') or []
    # t50 phase 2a: optional per-point vertex references (parallel to `points`) — an
    # existing vertex id to REFERENCE (a draw-time snap → shared/locked vertex) or None to
    # MINT fresh (absent entirely = mint all, phase-1 back-compatible).
    vertex_refs = body.get('vertexRefs')
    # Annotate-as-yourself: non-admins are forced to their own identity; admin may seed any
    # annotator (matches the _member_or_403 / _owner_or_403 admin bypass).
    if is_admin:
        annotator = (body.get('annotator') or '').strip()
    else:
        annotator = username or ''
    if not (image_id and kind and points and annotator):
        return {'error': 'imageId, kind, points, annotator required'}, 400
    err = _member_or_403_direct(con, project_id, username, user_id)
    if err:
        return err
    label = body.get('label')
    pass_no = body.get('passNo')
    viewport_json = json.dumps(body['viewport']) if body.get('viewport') else None
    hsv_json = json.dumps(body['hsvHist']) if body.get('hsvHist') else None
    # t64: resolve the incoming label NAME to its matching compound's STABLE id and
    # store that (`compound_id`) — display then resolves {name,color,selections} LIVE
    # from the CURRENT taxonomy (see _annotation_out), so a later rename/recolour flows
    # through to every lesion painted with that compound. `label_snapshot` is still
    # written as a fallback (used only when compound_id is null/unresolvable).
    proj_row = _project(con, project_id)
    classes_json = proj_row.get('classes_json') if proj_row else None
    compound_id = taxonomy.id_from_label(classes_json, label)
    snapshot = taxonomy.snapshot_from_label(classes_json, label)
    snapshot_json = json.dumps(snapshot) if snapshot else None
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
        tool = 'polyline' if body.get('tool') == 'polyline' else 'brush'
        footprint = _footprint(points, stroke_width, outline)
        # t59 (Christian, 2026-07-19): defer the tile check for POLYLINE ONLY. A polyline
        # is drawn click-by-click and an intermediate click may legitimately land off-tile
        # mid-stroke (e.g. panning while drawing) — rejecting it here 422s and resets the
        # per-click session, spuriously minting a second annotation on the next click. The
        # whole-stroke tile check instead runs on FINISH (see do_edit_stroke's `final`
        # branch below) — keep or discard, exactly like a no-tile brush stroke. Brush is
        # UNCHANGED: an off-tile brush stroke still 422s at create (that instant reject IS
        # the brush's discard path).
        if footprint is None or footprint.is_empty:
            return {'error': 'annotation must intersect at least one tile'}, 422
        if tool != 'polyline' and not _tiles_for_geom(con, image_id, footprint):
            return {'error': 'annotation must intersect at least one tile'}, 422

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
                  label_snapshot, compound_id, points_json, geometry_json, viewport_json,
                  hsv_hist_json, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, 'stroke', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)''',
            (aid, project_id, image_id, annotator, pass_no, label, snapshot_json, compound_id,
             json.dumps(_poly_rings(merged)), viewport_json, hsv_json, now, now),
        )
        _insert_stroke(con, sid, aid, 'stroke', points, stroke_width, outline, now,
                      tool=tool, vertex_refs=vertex_refs)

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
        out = _annotation_out(
            con.execute('SELECT * FROM annotation WHERE id = ?', (aid,)).fetchone(),
            con, raw_taxonomy=classes_json)
        out.update({'tileIds': tile_ids, 'tileStates': tile_states,
                   'consumedAnnotationIds': consumed_ids, 'createdStrokeId': sid,
                   'consumedGroups': consumed_groups})
        return out, 201

    # Non-fusing kinds (point / line / polygon): unconditional fresh 1:1 wrap.
    tile_ids = _tiles_intersecting(con, image_id, kind, points)
    if not tile_ids:
        return {'error': 'annotation must intersect at least one tile'}, 422
    aid = _uid()
    con.execute(
        '''INSERT INTO annotation
             (id, project_id, project_image_id, annotator, kind, pass_no, label,
              label_snapshot, compound_id, points_json, geometry_json, viewport_json,
              hsv_hist_json, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)''',
        (aid, project_id, image_id, annotator, kind, pass_no, label, snapshot_json, compound_id,
         json.dumps(points), viewport_json, hsv_json, now, now),
    )
    _insert_stroke(con, sid, aid, kind, points, None, None, now, vertex_refs=vertex_refs)
    for tid in tile_ids:
        con.execute(
            'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
            (aid, tid),
        )
    tile_states = _mark_tiles_dirty(con, tile_ids, annotator)
    con.commit()
    out = _annotation_out(
        con.execute('SELECT * FROM annotation WHERE id = ?', (aid,)).fetchone(),
        raw_taxonomy=classes_json)
    out.update({'tileIds': tile_ids, 'tileStates': tile_states,
               'consumedAnnotationIds': [], 'createdStrokeId': sid, 'consumedGroups': []})
    return out, 201


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

    This is a thin shim around do_create_annotation — the WS op handler in webapp/asgi.py
    calls that same core so mutations serialize through the single WS channel.
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_create_annotation(
            con, project_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


def _do_finish_stroke(con, srow, ann, points):
    """t59 FINISH: whole-stroke keep/discard, brush-parity. `points` is the stroke's
    current (already-persisted, possibly off-tile mid-draw) vertex list. Keep leaves the
    annotation untouched (same id, same rows) — discard soft-deletes it and drops its
    tile links, exactly like a no-tile brush stroke create-time reject."""
    stroke_id = srow['id']
    aid = ann['id']
    image_id = ann['project_image_id']
    stroke_width = srow['stroke_width']
    outline = json.loads(srow['outline_json']) if srow['outline_json'] else None
    before = {'points': json.loads(srow['points_json']) if srow['points_json'] else [],
              'strokeWidth': srow['stroke_width'], 'outline': outline}
    footprint = _footprint(points, stroke_width, outline)
    tile_ids = _tiles_for_geom(con, image_id, footprint) \
        if footprint is not None and not footprint.is_empty else []
    if tile_ids:
        return {'ok': True, 'strokeId': stroke_id, 'discarded': False, 'before': before,
                'deletedAnnotationIds': [], 'deletedGroups': [], 'created': [],
                'createdGroups': [], 'tileStates': []}, 200
    # No tile touched at all — discard, same as a no-tile brush stroke: soft-delete the
    # annotation and drop its (empty, since off-tile) annotation_tile links.
    now = _now()
    tiles = [r['tile_id'] for r in con.execute(
        'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (aid,)).fetchall()]
    con.execute('UPDATE annotation SET deleted_at = ? WHERE id = ?', (now, aid))
    con.execute('DELETE FROM annotation_tile WHERE annotation_id = ?', (aid,))
    tile_states = _mark_tiles_dirty(con, tiles, ann['annotator'])
    con.commit()
    return {'ok': True, 'strokeId': stroke_id, 'discarded': True,
            # Same message text a no-tile BRUSH stroke's create-time 422 carries — the FE
            # reuses it verbatim for the discard notice (no new i18n string invented).
            'message': 'annotation must intersect at least one tile',
            'before': before, 'deletedAnnotationIds': [aid],
            'deletedGroups': [{'annotationId': aid, 'strokeIds': [stroke_id]}],
            'created': [], 'createdGroups': [], 'tileStates': tile_states}, 200


def _recompute_fused_scope(con, project_id: str, image_id: str, annotator: str, label,
                            now: str) -> dict:
    """Recompute connected components over ALL live strokes in a (image, annotator, label)
    scope from their CURRENT `points_json`, soft-deleting the affected annotation(s) and
    minting one fresh annotation per resulting component. This is the recompute half of
    `do_edit_stroke` (t59), extracted so `do_move_vertex` (t50 phase 3a) can re-fuse a
    scope after a shared-vertex move without duplicating the fusion/tile-membership logic.

    Never mutates a mask in place — same invariant as do_edit_stroke. Returns
    {'deletedAnnotationIds', 'deletedGroups', 'createdIds', 'createdGroups', 'dirtyTiles'};
    the caller is responsible for `_mark_tiles_dirty`, building the JSON `created` payload,
    and `con.commit()`.
    """
    srows = con.execute(
        '''SELECT s.* FROM stroke s JOIN annotation a ON a.id = s.annotation_id
           WHERE a.project_image_id = ? AND a.annotator = ? AND a.label IS ?
             AND a.kind = 'stroke' AND a.deleted_at IS NULL''',
        (image_id, annotator, label)).fetchall()
    if not srows:
        return {'deletedAnnotationIds': [], 'deletedGroups': [], 'createdIds': [],
                'createdGroups': [], 'dirtyTiles': []}
    parsed = [{'id': s['id'],
               'points': json.loads(s['points_json']) if s['points_json'] else [],
               'stroke_width': s['stroke_width'],
               'outline': json.loads(s['outline_json']) if s['outline_json'] else None}
              for s in srows]
    components = _stroke_components(parsed)

    old_ids = list({s['annotation_id'] for s in srows})
    # Snapshot metadata (pass_no/label_snapshot/compound_id/viewport/hsv) from any one of
    # the scope's live annotations BEFORE soft-deleting — they share (annotator, image,
    # label) so this metadata is consistent across the scope.
    qmarks0 = ','.join('?' * len(old_ids))
    ref_ann = con.execute(
        f'SELECT * FROM annotation WHERE id IN ({qmarks0}) LIMIT 1', old_ids).fetchone()
    deleted_groups = [{'annotationId': oid,
                       'strokeIds': [s['id'] for s in srows if s['annotation_id'] == oid]}
                      for oid in old_ids]
    con.execute(f'UPDATE annotation SET deleted_at = ? WHERE id IN ({qmarks0})',
               (now, *old_ids))
    con.execute(f'DELETE FROM annotation_tile WHERE annotation_id IN ({qmarks0})', old_ids)

    dirty_tiles: list[str] = []
    created_groups: list[dict] = []
    created_ids: list[str] = []
    for comp in components:
        geom = comp['geometry']
        if geom is None or geom.is_empty:
            continue
        geom = _exterior_only(geom)  # fill loop holes — a lesion is a solid blob
        rings = _poly_rings(geom)
        if not rings:
            continue
        aid = _uid()
        con.execute(
            '''INSERT INTO annotation
                 (id, project_id, project_image_id, annotator, kind, pass_no, label,
                  label_snapshot, compound_id, points_json, geometry_json, viewport_json,
                  hsv_hist_json, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, 'stroke', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)''',
            (aid, project_id, image_id, annotator, ref_ann['pass_no'], label,
             ref_ann['label_snapshot'], ref_ann.get('compound_id'), json.dumps(rings),
             ref_ann['viewport_json'], ref_ann['hsv_hist_json'], now, now))
        member_ids = comp['member_ids']
        qm = ','.join('?' * len(member_ids))
        con.execute(f'UPDATE stroke SET annotation_id = ? WHERE id IN ({qm})',
                   (aid, *member_ids))
        tile_ids = _tiles_for_geom(con, image_id, geom)
        for tid in tile_ids:
            con.execute(
                'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                (aid, tid))
        dirty_tiles.extend(tile_ids)
        created_ids.append(aid)
        created_groups.append({'annotationId': aid, 'strokeIds': member_ids})

    return {'deletedAnnotationIds': old_ids, 'deletedGroups': deleted_groups,
            'createdIds': created_ids, 'createdGroups': created_groups,
            'dirtyTiles': dirty_tiles}


def do_edit_stroke(con, project_id: str, stroke_id: str, body: dict, *,
                    username: str | None, user_id, is_admin: bool):
    """Core of edit_stroke — returns (response_dict, status). See the route shim's docstring
    below for the full contract."""
    srow = con.execute('SELECT * FROM stroke WHERE id = ?', (stroke_id,)).fetchone()
    if not srow:
        return {'error': 'not found'}, 404
    ann = con.execute('SELECT * FROM annotation WHERE id = ?',
                      (srow['annotation_id'],)).fetchone()
    if not ann or ann['deleted_at']:
        return {'error': 'not found'}, 404
    if ann['kind'] != 'stroke':
        return {'error': 'only stroke masks support vertex editing'}, 422
    err = (_member_or_403_direct(con, project_id, username, user_id)
           or _owner_or_403_direct(ann['annotator'], username))
    if err:
        return err
    final = bool(body.get('final'))
    points = body.get('points')
    if points is None:
        # `final: true` may arrive WITHOUT points (t59) — reuse the stored stroke points.
        if not final:
            return {'error': 'points required'}, 400
        points = json.loads(srow['points_json']) if srow['points_json'] else []
    elif not points:
        return {'error': 'points required'}, 400

    if final:
        # t59: FINISH — recompute this stroke's footprint and apply the SAME tile check
        # the brush uses at create (keep if it touches >=1 tile, discard exactly like a
        # no-tile brush stroke otherwise). This is deliberately NOT the full recompute/
        # remint pipeline below (which always mints a fresh annotation id per component,
        # even a no-op) — finish only decides keep-vs-discard on the WHOLE stroke, never
        # per-point, and never touches the annotation id when kept.
        return _do_finish_stroke(con, srow, ann, points)

    image_id = ann['project_image_id']
    annotator = ann['annotator']
    label = ann['label']
    now = _now()

    # Clamp stroke width to [1px, image diagonal] — never trust the client (mirrors create).
    stroke_width = srow['stroke_width']
    if body.get('strokeWidth') is not None:
        im = _image_row(con, image_id)
        diag = ((float(im['width']) ** 2 + float(im['height']) ** 2) ** 0.5) if im else None
        try:
            w = float(body['strokeWidth'])
            stroke_width = max(1.0, min(w, diag) if diag else w)
        except (TypeError, ValueError):
            pass
    outline = body.get('outline')
    # Snapshot the stroke's PRE-edit record so undo can restore it verbatim (robust
    # undo: exact prior rows, not a lossy re-derivation — Christian, "robust > easy").
    before = {'points': json.loads(srow['points_json']) if srow['points_json'] else [],
              'strokeWidth': srow['stroke_width'],
              'outline': json.loads(srow['outline_json']) if srow['outline_json'] else None}

    # 1) apply the edit to this stroke's raw record.
    con.execute(
        'UPDATE stroke SET points_json = ?, stroke_width = ?, outline_json = ? WHERE id = ?',
        (json.dumps(points), stroke_width,
         json.dumps(outline) if outline is not None else None, stroke_id))
    # t50 phase 1/2a: write through to the normalized tables — the source of truth for
    # reads. `vertexRefs` (optional, parallel to `points`) lets the per-click polyline edit
    # reconcile rather than re-mint — see `_write_stroke_vertices`.
    _write_stroke_vertices(con, stroke_id, points, body.get('vertexRefs'))

    # 2-5) recompute the whole (annotator, image, label) scope's fusion — shared with
    # do_move_vertex (t50 phase 3a) via _recompute_fused_scope.
    scope = _recompute_fused_scope(con, project_id, image_id, annotator, label, now)
    old_ids = scope['deletedAnnotationIds']
    deleted_groups = scope['deletedGroups']
    created_ids = scope['createdIds']
    created_groups = scope['createdGroups']
    dirty_tiles = scope['dirtyTiles']

    tile_states = _mark_tiles_dirty(con, list(set(dirty_tiles)), annotator)
    con.commit()
    # The reversal descriptor is everything undo needs (POST /strokes/<id>/reverse):
    # reset this stroke to `before`, drop the `created` masks, repoint `deletedGroups`
    # strokes back and un-delete those exact annotations. `created` carries the live
    # masks (with member strokes) for the FE to splice in immediately.
    proj_row = _project(con, project_id)
    classes_json = proj_row.get('classes_json') if proj_row else None
    created = [_annotation_out(
        con.execute('SELECT * FROM annotation WHERE id = ?', (cid,)).fetchone(),
        con, raw_taxonomy=classes_json)
        for cid in created_ids]
    return {'ok': True, 'strokeId': stroke_id, 'before': before,
            'deletedAnnotationIds': old_ids, 'deletedGroups': deleted_groups,
            'created': created, 'createdGroups': created_groups,
            'tileStates': tile_states}, 200


@projects_bp.patch('/api/projects/<project_id>/strokes/<stroke_id>')
@login_required
def edit_stroke(project_id: str, stroke_id: str):
    """Edit a stroke's vertices and RECOMPUTE the affected mask(s) — a11y #40 v1b.

    The one new capability the computed-from-strokes model unlocks. A `stroke` is the raw
    record of a mark; brush and polyline are two ways of producing one (a brush stroke is
    just a polyline whose in-between points perfect-freehand fills), so this endpoint is
    stroke-general, NOT polyline-only (Christian, 2026-07-11). Moving a stroke's points
    changes its footprint, so we recompute EVERY same-(annotator, image, label) mask from
    ALL those strokes' footprints as connected components — which naturally MOVES a mask,
    SPLITS one whose strokes now disconnect, and MERGES strokes that now overlap. Scoping
    the recompute over the whole label set (not just the edited stroke's own annotation) is
    what preserves the "annotations never overlap" invariant. Like create_annotation, we
    never mutate a mask in place: the affected masks are soft-deleted and one fresh
    annotation is minted per resulting component.

    Thin shim around do_edit_stroke — the WS op handler in webapp/asgi.py calls the same
    core function so mutations serialize through the single WS channel.
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_edit_stroke(
            con, project_id, stroke_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


def do_splice_polyline(con, project_id: str, body: dict, *,
                        username: str | None, user_id, is_admin: bool):
    """t67: splice a freshly-drawn polyline run INTO an existing stroke. The run's first &
    last vertices snapped (t50) onto an ADJACENT pair of the existing stroke's vertices; the
    FE has already computed that stroke's NEW point + `vertexRefs` list (the run's middle
    vertices inserted between the pair, oriented lo→hi, endpoints keeping their shared ids).

    We rewrite that stroke, DELETE the standalone run annotation so its geometry doesn't
    re-contribute to the fusion, then re-fuse the scope — the same machinery as
    `do_edit_stroke`. Body: {strokeId (the EXISTING stroke), points, vertexRefs, outline,
    removeStrokeId (any stroke of the standalone run, whose annotation is deleted)}.
    """
    stroke_id = body.get('strokeId')
    remove_stroke_id = body.get('removeStrokeId')
    points = body.get('points')
    if not stroke_id or not remove_stroke_id or not points:
        return {'error': 'strokeId, removeStrokeId and points required'}, 400

    srow = con.execute('SELECT * FROM stroke WHERE id = ?', (stroke_id,)).fetchone()
    if not srow:
        return {'error': 'not found'}, 404
    ann = con.execute('SELECT * FROM annotation WHERE id = ?', (srow['annotation_id'],)).fetchone()
    if not ann or ann['deleted_at']:
        return {'error': 'not found'}, 404
    if ann['kind'] != 'stroke':
        return {'error': 'only stroke masks support splicing'}, 422
    err = (_member_or_403_direct(con, project_id, username, user_id)
           or _owner_or_403_direct(ann['annotator'], username))
    if err:
        return err

    if remove_stroke_id == stroke_id:
        return {'error': 'cannot splice a stroke into itself'}, 422
    run_srow = con.execute('SELECT * FROM stroke WHERE id = ?', (remove_stroke_id,)).fetchone()
    if not run_srow:
        return {'error': 'run stroke not found'}, 404
    run_ann_id = run_srow['annotation_id']

    image_id = ann['project_image_id']
    annotator = ann['annotator']
    label = ann['label']
    now = _now()

    # Clamp stroke width to [1px, image diagonal] — never trust the client (mirrors edit).
    stroke_width = srow['stroke_width']
    if body.get('strokeWidth') is not None:
        im = _image_row(con, image_id)
        diag = ((float(im['width']) ** 2 + float(im['height']) ** 2) ** 0.5) if im else None
        try:
            w = float(body['strokeWidth'])
            stroke_width = max(1.0, min(w, diag) if diag else w)
        except (TypeError, ValueError):
            pass
    outline = body.get('outline')
    before = {'points': json.loads(srow['points_json']) if srow['points_json'] else [],
              'strokeWidth': srow['stroke_width'],
              'outline': json.loads(srow['outline_json']) if srow['outline_json'] else None}

    # 1) rewrite the EXISTING stroke FIRST, so its new stroke_vertex rows reference the run's
    # middle vertices before we delete the run — keeping those vertices alive (GC-safe).
    con.execute(
        'UPDATE stroke SET points_json = ?, stroke_width = ?, outline_json = ? WHERE id = ?',
        (json.dumps(points), stroke_width,
         json.dumps(outline) if outline is not None else None, stroke_id))
    _write_stroke_vertices(con, stroke_id, points, body.get('vertexRefs'))

    # 2) delete the run STROKE (not its annotation): the run + the target usually already
    # CO-FUSED into one annotation on draw (they share endpoint positions), so removing the
    # stroke — its middle vertices now referenced by the rewritten stroke (step 1), so GC
    # keeps them; shared endpoints survive too — is what drops the redundant run geometry.
    _write_stroke_vertices(con, remove_stroke_id, [])   # deletes its stroke_vertex rows + GCs exclusives
    con.execute('DELETE FROM stroke WHERE id = ?', (remove_stroke_id,))
    # If that emptied the run's annotation (it was NOT co-fused with the target), soft-delete
    # the husk so no stroke-less annotation lingers.
    husk: list[str] = []
    if run_ann_id != ann['id']:
        remaining = con.execute(
            'SELECT COUNT(*) c FROM stroke WHERE annotation_id = ?', (run_ann_id,)).fetchone()['c']
        if remaining == 0:
            con.execute('UPDATE annotation SET deleted_at = ? WHERE id = ?', (now, run_ann_id))
            husk.append(run_ann_id)

    # 3) re-fuse the (image, annotator, label) scope — same as do_edit_stroke.
    scope = _recompute_fused_scope(con, project_id, image_id, annotator, label, now)
    tile_states = _mark_tiles_dirty(con, list(set(scope['dirtyTiles'])), annotator)
    con.commit()

    proj_row = _project(con, project_id)
    classes_json = proj_row.get('classes_json') if proj_row else None
    created = [_annotation_out(
        con.execute('SELECT * FROM annotation WHERE id = ?', (cid,)).fetchone(),
        con, raw_taxonomy=classes_json)
        for cid in scope['createdIds']]
    deleted = list(scope['deletedAnnotationIds']) + [h for h in husk if h not in scope['deletedAnnotationIds']]
    return {'ok': True, 'strokeId': stroke_id, 'before': before,
            'deletedAnnotationIds': deleted, 'deletedGroups': scope['deletedGroups'],
            'created': created, 'createdGroups': scope['createdGroups'],
            'tileStates': tile_states}, 200


def do_move_vertex(con, project_id: str, vertex_id: str, body: dict, *,
                    username: str | None, user_id, is_admin: bool):
    """Core of move_vertex (t50 phase 3a) — moves a vertex's canonical position and
    re-fuses EVERY annotation whose stroke references it. A snap-shared vertex moves
    every sharer transitively (move one → move all, even across different labels); a
    vertex referenced by only one stroke moves just that mask.

    Does NOT rewrite `stroke_vertex` refs and does NOT re-mint the vertex — its id and
    every stroke's reference to it are untouched, only its (x, y) changes. Reuses
    `_recompute_fused_scope` (the recompute half of `do_edit_stroke`) once per distinct
    (image, annotator, label) scope touched by the move — different sharers may carry
    different labels, so each scope re-fuses independently.
    """
    err = _member_or_403_direct(con, project_id, username, user_id)
    if err:
        return err
    vrow = con.execute('SELECT * FROM vertex WHERE id = ?', (vertex_id,)).fetchone()
    if not vrow:
        return {'error': 'not found'}, 404
    try:
        x = float(body.get('x'))
        y = float(body.get('y'))
    except (TypeError, ValueError):
        return {'error': 'x and y required'}, 400
    now = _now()

    # 1) update the vertex's canonical position — the single source of truth every
    # referencing stroke reads through to.
    con.execute('UPDATE vertex SET x = ?, y = ? WHERE id = ?', (x, y, vertex_id))

    # 2) every stroke referencing this vertex needs its `points_json` synced to the new
    # position — `_recompute_fused_scope` (like do_edit_stroke) fuses from `points_json`,
    # not a live vertex-table join. `stroke_vertex` rows themselves are untouched.
    stroke_ids = [r['stroke_id'] for r in con.execute(
        'SELECT DISTINCT stroke_id FROM stroke_vertex WHERE vertex_id = ?',
        (vertex_id,)).fetchall()]
    scopes: set[tuple] = set()
    for sid in stroke_ids:
        pts = _read_stroke_vertices(con, sid)
        con.execute('UPDATE stroke SET points_json = ? WHERE id = ?',
                   (json.dumps(pts), sid))
        srow = con.execute(
            'SELECT annotation_id FROM stroke WHERE id = ?', (sid,)).fetchone()
        if not srow:
            continue
        ann = con.execute(
            'SELECT * FROM annotation WHERE id = ?', (srow['annotation_id'],)).fetchone()
        if ann and not ann['deleted_at'] and ann['kind'] == 'stroke':
            scopes.add((ann['project_image_id'], ann['annotator'], ann['label']))

    # 3) re-fuse every affected (image, annotator, label) scope independently.
    deleted_ids: list[str] = []
    deleted_groups: list[dict] = []
    created_ids: list[str] = []
    created_groups: list[dict] = []
    dirty_by_annotator: dict[str, list[str]] = {}
    for image_id, annotator, label in scopes:
        res = _recompute_fused_scope(con, project_id, image_id, annotator, label, now)
        deleted_ids.extend(res['deletedAnnotationIds'])
        deleted_groups.extend(res['deletedGroups'])
        created_ids.extend(res['createdIds'])
        created_groups.extend(res['createdGroups'])
        dirty_by_annotator.setdefault(annotator, []).extend(res['dirtyTiles'])

    tile_states: list[dict] = []
    for annotator, tiles in dirty_by_annotator.items():
        tile_states.extend(_mark_tiles_dirty(con, list(set(tiles)), annotator))

    con.commit()

    proj_row = _project(con, project_id)
    classes_json = proj_row.get('classes_json') if proj_row else None
    created = [_annotation_out(
        con.execute('SELECT * FROM annotation WHERE id = ?', (cid,)).fetchone(),
        con, raw_taxonomy=classes_json)
        for cid in created_ids]
    return {'ok': True, 'vertexId': vertex_id, 'x': x, 'y': y,
            'deletedAnnotationIds': deleted_ids, 'deletedGroups': deleted_groups,
            'annotations': created, 'createdGroups': created_groups,
            'tileStates': tile_states}, 200


@projects_bp.post('/api/projects/<project_id>/splice')
@login_required
def splice_polyline(project_id: str):
    """Splice a freshly-drawn polyline run into an existing stroke (t67) — thin shim around
    do_splice_polyline (the WS op handler calls the same core). See its docstring."""
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_splice_polyline(
            con, project_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


@projects_bp.patch('/api/projects/<project_id>/vertices/<vertex_id>')
@login_required
def move_vertex(project_id: str, vertex_id: str):
    """Move a shared vertex's canonical position — the payoff of the snap-lock (t50 phase
    3a): moving a vertex shared by several strokes moves every mask that references it,
    transitively, even across different labels/annotations. Thin shim around
    do_move_vertex — see its docstring for the full contract.
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_move_vertex(
            con, project_id, vertex_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


def do_reverse_stroke_edit(con, project_id: str, stroke_id: str, body: dict, *,
                            username: str | None, user_id, is_admin: bool):
    """Core of reverse_stroke_edit — returns (response_dict, status). See the route shim's
    docstring below for the full contract."""
    before = body.get('before') or {}
    deleted_groups = body.get('deletedGroups') or []
    created_ids = body.get('createdAnnotationIds') or []
    srow = con.execute('SELECT * FROM stroke WHERE id = ?', (stroke_id,)).fetchone()
    if not srow:
        return {'error': 'not found'}, 404
    old_ids = [g['annotationId'] for g in deleted_groups]
    # Authorize via a resurrection target's owner (all one annotator by construction).
    owner = None
    for oid in old_ids:
        r = con.execute('SELECT annotator FROM annotation WHERE id = ?', (oid,)).fetchone()
        if r:
            owner = r['annotator']
            break
    err = (_member_or_403_direct(con, project_id, username, user_id)
           or (_owner_or_403_direct(owner, username) if owner else None))
    if err:
        return err
    now = _now()
    # Tiles the minted masks occupied — reopen them once the masks are gone.
    created_tiles: list[str] = []
    if created_ids:
        qm = ','.join('?' * len(created_ids))
        created_tiles = [r['tile_id'] for r in con.execute(
            f'SELECT tile_id FROM annotation_tile WHERE annotation_id IN ({qm})',
            created_ids).fetchall()]

    # 1) reset the edited stroke to its pre-edit record.
    before_points = before.get('points') or []
    con.execute(
        'UPDATE stroke SET points_json = ?, stroke_width = ?, outline_json = ? WHERE id = ?',
        (json.dumps(before_points), before.get('strokeWidth'),
         json.dumps(before.get('outline')) if before.get('outline') is not None else None,
         stroke_id))
    # t50 phase 1: write through to the normalized tables — the source of truth for reads.
    _write_stroke_vertices(con, stroke_id, before_points)
    # 2) repoint each retired mask's strokes back to it + un-delete those exact rows.
    for g in deleted_groups:
        sids = g.get('strokeIds') or []
        if sids:
            qm = ','.join('?' * len(sids))
            con.execute(f'UPDATE stroke SET annotation_id = ? WHERE id IN ({qm})',
                       (g['annotationId'], *sids))
    if old_ids:
        qm = ','.join('?' * len(old_ids))
        con.execute(f'UPDATE annotation SET deleted_at = NULL, updated_at = ? WHERE id IN ({qm})',
                   (now, *old_ids))
    # 3) hard-delete the minted masks (cascades their annotation_tile).
    for cid in created_ids:
        con.execute('DELETE FROM annotation WHERE id = ?', (cid,))
    # 4) rebuild resurrected masks' tiles from their stored geometry + dirty every tile.
    proj_row = _project(con, project_id)
    classes_json = proj_row.get('classes_json') if proj_row else None
    dirtied: dict[str, dict] = {}
    annotator = None
    resurrected = []
    for oid in old_ids:
        r = con.execute('SELECT * FROM annotation WHERE id = ?', (oid,)).fetchone()
        if not r:
            continue
        annotator = r['annotator']
        tile_ids = _tiles_for_geom(con, r['project_image_id'], _annotation_geom(r))
        for tid in tile_ids:
            con.execute(
                'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                (oid, tid))
        for d in _mark_tiles_dirty(con, tile_ids, annotator):
            dirtied[d['tileId']] = d
        resurrected.append(_annotation_out(r, con, raw_taxonomy=classes_json))
    if annotator and created_tiles:
        for d in _mark_tiles_dirty(con, created_tiles, annotator):
            dirtied[d['tileId']] = d
    con.commit()
    return {'ok': True, 'resurrected': resurrected,
            'deletedAnnotationIds': created_ids,
            'tileStates': list(dirtied.values())}, 200


@projects_bp.post('/api/projects/<project_id>/strokes/<stroke_id>/reverse')
@login_required
def reverse_stroke_edit(project_id: str, stroke_id: str):
    """Undo a stroke-vertex edit (compound op — mirrors reverse_annotation_merge). Reset the
    stroke to its pre-edit record, hard-delete the annotations the edit minted, repoint every
    retired mask's strokes back to it and resurrect those EXACT rows (flip deleted_at to NULL
    + rebuild their tiles from stored geometry). Robust undo: the prior annotation ids/rows
    come back verbatim, not a re-derivation (Christian, "robust > easy").

    Body (the edit's reversal descriptor): { before: {points, strokeWidth, outline},
      deletedGroups: [{annotationId, strokeIds}, ...], createdAnnotationIds: [...] }
    Returns: { ok, resurrected: [...], deletedAnnotationIds: [...], tileStates: [...] }

    Thin shim around do_reverse_stroke_edit — the WS op handler in webapp/asgi.py calls
    the same core function so mutations serialize through the single WS channel.
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_reverse_stroke_edit(
            con, project_id, stroke_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


def do_create_viewport_events(con, project_id: str, body: dict, *,
                               username: str | None, user_id, is_admin: bool):
    """Core of create_viewport_events — returns (response_dict, status). See the route
    shim's docstring below for the full contract.

    Called BOTH by the REST route AND by the WS `viewport` fire-and-forget message
    handler in webapp/asgi.py, so the single mutation path stays in one place. Admin
    sessions are dropped server-side (unchanged behaviour) — the REST test pins this,
    and the WS handler skips the call entirely for admin connections.
    """
    image_id = body.get('imageId')
    events = body.get('events') or []
    acting = username or ''
    if not (image_id and acting and isinstance(events, list) and events):
        return {'error': 'imageId, events required'}, 400
    if is_admin:
        # Admins are read-only when viewing an annotator's canvas — never record telemetry
        # "as" admin. AFTER body-validation so a malformed admin body still 400s like a
        # non-admin's. Keep this guard confined to THIS endpoint; see docstring above.
        return {'ok': True, 'count': 0}, 201
    err = _member_or_403_direct(con, project_id, acting, user_id)
    if err:
        return err
    received_at = _now()
    rows = []
    for ev in events:
        try:
            rows.append((
                project_id, image_id, acting,
                str(ev.get('clientTs') or ''), received_at,
                float(ev['x']), float(ev['y']), float(ev['w']), float(ev['h']),
                float(ev['cssW']), float(ev['cssH']), float(ev['dpr']),
            ))
        except (KeyError, TypeError, ValueError):
            continue  # malformed sample — skip it, never fail the whole batch
    if rows:
        con.executemany(
            '''INSERT INTO viewport_event
                 (project_id, image_id, user_id, client_ts, received_at,
                  x, y, w, h, css_w, css_h, dpr)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            rows,
        )
        con.commit()
    return {'ok': True, 'count': len(rows)}, 201


@projects_bp.post('/api/projects/<project_id>/viewport-events')
@login_required
def create_viewport_events(project_id: str):
    """Batch-insert canvas viewport (pan+zoom) telemetry samples for later analysis of
    how users view images at different magnifications (per-user "vision level" tile
    sizing, eventually). Best-effort / fail-quiet by design on the frontend
    (webapp/frontend/src/projects/viewportTelemetry.ts) — this endpoint just needs to be
    fast and not blow up; it never affects annotation UX.

    The sample is always attributed to the acting session user (their own token) — there
    is no admin/annotator override: we never record telemetry "as" someone else, and admins
    viewing the annotator view are read-only, so their navigation is simply not recorded.

    No consent/opt-out gating — annotators are lab staff. This is the spot to add a
    gate (e.g. a per-user opt-out flag) if that's ever needed.

    Body: {imageId, events: [{clientTs, x, y, w, h, cssW, cssH, dpr}, ...]}.
    Response: {ok: true, count: N}.

    Thin shim around do_create_viewport_events — the WS handler in webapp/asgi.py calls
    the same core over a fire-and-forget `{type:"viewport"}` message so ALL viewport
    telemetry funnels through one mutation path.
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_create_viewport_events(
            con, project_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


@projects_bp.get('/api/projects/<project_id>/images/<image_id>/viewport-events')
@admin_required
def list_viewport_events(project_id: str, image_id: str):
    """Admin-only: return `viewport_event` rows for a project + image so the client can
    compute the viewport-attention heatmap overlay.

    Each row is one sampled canvas viewport (the SVG viewBox in IMAGE coordinates: pan =
    x,y; zoom = w,h; smaller w*h = more zoomed in). Rows are ordered by (user_id,
    client_ts) so the client can compute per-user dwell (Delta-t) between consecutive
    samples from the SAME user on this image.

    Optional `?user_id=<byline>` filters to a single annotator. Admin-only (auth.
    admin_required) - this is analysis data, not part of the annotator workflow.

    Response: {events: [{id, userId, clientTs, receivedAt, x, y, w, h, cssW, cssH, dpr}, ...]}.
    """
    user_filter = (request.args.get('user_id') or '').strip()
    con = _db.get_db()
    try:
        if user_filter:
            rows = con.execute(
                'SELECT * FROM viewport_event WHERE project_id = ? AND image_id = ? AND user_id = ? ORDER BY user_id, client_ts, id',
                (project_id, image_id, user_filter),
            ).fetchall()
        else:
            rows = con.execute(
                'SELECT * FROM viewport_event WHERE project_id = ? AND image_id = ? ORDER BY user_id, client_ts, id',
                (project_id, image_id),
            ).fetchall()
        return jsonify({
            'events': [
                {
                    'id': r['id'],
                    'userId': r['user_id'],
                    'clientTs': r['client_ts'],
                    'receivedAt': r['received_at'],
                    'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
                    'cssW': r['css_w'], 'cssH': r['css_h'], 'dpr': r['dpr'],
                }
                for r in rows
            ]
        })
    finally:
        _db.close_db(con)


def do_update_annotation(con, annotation_id: str, body: dict, *,
                          username: str | None, user_id, is_admin: bool):
    """Core of update_annotation — returns (response_dict, status). See the route shim's
    docstring below for the full contract. Phase 2 (feat/annotation-ws): the WS op
    handler in webapp/asgi.py calls this same function for the `relabel` op so mutations
    serialize through the single WS channel."""
    row = con.execute('SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone()
    if not row or row['deleted_at']:
        return {'error': 'not found'}, 404
    if row['kind'] == 'stroke':
        # Compound labels Phase 2b (relabel): a LABEL-ONLY patch (no `points` key) on a
        # fused mask is allowed — it re-labels the lesion in place without touching its
        # geometry. Any attempt to also edit `points`/geometry on a stroke still 422s
        # (see docstring): erase + redraw is still the only way to reshape a fused mask.
        if 'points' in body or 'label' not in body:
            return {'error': 'a fused mask cannot be edited directly; erase and redraw'}, 422
        err = (_member_or_403_direct(con, row['project_id'], username, user_id)
               or _owner_or_403_direct(row['annotator'], username))
        if err:
            return err
        label = body.get('label')
        proj_row = _project(con, row['project_id'])
        classes_json = proj_row.get('classes_json') if proj_row else None
        compound_id = taxonomy.id_from_label(classes_json, label)
        snap = taxonomy.snapshot_from_label(classes_json, label)
        snapshot_json = json.dumps(snap) if snap else None
        con.execute(
            'UPDATE annotation SET label = ?, label_snapshot = ?, compound_id = ?, '
            'updated_at = ? WHERE id = ?',
            (label, snapshot_json, compound_id, _now(), annotation_id),
        )
        tile_ids = [r['tile_id'] for r in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (annotation_id,)
        ).fetchall()]
        _mark_tiles_dirty(con, tile_ids, row['annotator'])
        con.commit()
        out = _annotation_out(con.execute(
            'SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone(),
            con, raw_taxonomy=classes_json)
        out['tileIds'] = tile_ids
        return out, 200
    err = (_member_or_403_direct(con, row['project_id'], username, user_id)
           or _owner_or_403_direct(row['annotator'], username))
    if err:
        return err
    old_tiles = [r['tile_id'] for r in con.execute(
        'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (annotation_id,)
    ).fetchall()]
    points = body.get('points', json.loads(row['points_json']) if row['points_json'] else [])
    label = body.get('label', row['label'])
    # Taxonomy v2: re-snapshot when the label changes so the denormalised colour/
    # selections stay in sync with the newly-assigned compound (Phase 1 has no
    # relabel UI, but the PATCH endpoint stays correct for any caller). t64: also
    # re-resolve compound_id so LIVE display (_annotation_out) follows the relabel.
    proj_row = _project(con, row['project_id'])
    classes_json = proj_row.get('classes_json') if proj_row else None
    snapshot_json = row.get('label_snapshot')
    compound_id = row.get('compound_id')
    if body.get('label') is not None:
        compound_id = taxonomy.id_from_label(classes_json, label)
        snap = taxonomy.snapshot_from_label(classes_json, label)
        snapshot_json = json.dumps(snap) if snap else None
    points_json = json.dumps(points)
    con.execute(
        'UPDATE annotation SET points_json = ?, label = ?, label_snapshot = ?, '
        'compound_id = ?, updated_at = ? WHERE id = ?',
        (points_json, label, snapshot_json, compound_id, _now(), annotation_id),
    )
    con.execute('UPDATE stroke SET points_json = ? WHERE annotation_id = ?',
               (points_json, annotation_id))
    # t50 phase 1: write through to the normalized tables — the source of truth for reads.
    for srow2 in con.execute(
            'SELECT id FROM stroke WHERE annotation_id = ?', (annotation_id,)).fetchall():
        _write_stroke_vertices(con, srow2['id'], points)
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
        'SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone(),
        con, raw_taxonomy=classes_json)
    out['tileIds'] = new_tiles
    return out, 200


@projects_bp.patch('/api/annotations/<annotation_id>')
@login_required
def update_annotation(annotation_id: str):
    """Edit points/label in place. Only non-fusing kinds (point/line/polygon) support this
    — a `stroke` mask is fused geometry, not a single editable shape; erase + redraw
    instead (see docs/plans/Plan — Annotation-stroke model (fused masks).md).

    Thin shim around do_update_annotation — the WS op handler in webapp/asgi.py calls
    the same core function so mutations serialize through the single WS channel (Phase 2)."""
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_update_annotation(
            con, annotation_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
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

def do_mutate_annotations(con, project_id: str, body: dict, *,
                           username: str | None, user_id, is_admin: bool):
    """Core of mutate_annotations — returns (response_dict, status). Phase 2
    (feat/annotation-ws): the WS op handler in webapp/asgi.py calls this same function
    for the `mutate` op so draw-undo/redo mutations serialize through the single WS
    channel behind any in-flight polyline persist ops."""
    op = body.get('op')
    ids = body.get('ids') or []
    if op not in ('delete', 'restore') or not ids:
        return {'error': 'op (delete|restore) and ids required'}, 400
    err = _member_or_403_direct(con, project_id, username, user_id)
    if err:
        return err
    annotator = None
    for ann_id in ids:
        row = con.execute('SELECT * FROM annotation WHERE id = ?', (ann_id,)).fetchone()
        if not row:
            return {'error': f'annotation {ann_id} not found'}, 404
        if row['project_id'] != project_id:
            return {'error': 'forbidden'}, 403
        e = _owner_or_403_direct(row['annotator'], username)
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
    return {'ok': True, 'ids': ids, 'tileStates': list(dirtied.values())}, 200


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

    Thin shim around do_mutate_annotations — the WS op handler in webapp/asgi.py calls
    the same core function so mutations serialize through the single WS channel (Phase 2).
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_mutate_annotations(
            con, project_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


def do_erase_stroke(con, project_id: str, body: dict, *,
                     username: str | None, user_id, is_admin: bool):
    """Core of erase_stroke — returns (response_dict, status). See the route shim's
    docstring below for the full contract. Phase 2 (feat/annotation-ws): the WS op
    handler in webapp/asgi.py calls this same function for the `erase` op so brush-
    eraser mutations serialize through the single WS channel."""
    image_id = body.get('imageId')
    points = body.get('points') or []
    stroke_width = body.get('strokeWidth')
    outline = body.get('outline')
    # Annotate-as-yourself, same admin bypass as create_annotation.
    if is_admin:
        annotator = (body.get('annotator') or '').strip()
    else:
        annotator = username or ''
    if not (image_id and points and annotator):
        return {'error': 'imageId, points, annotator required'}, 400
    err = _member_or_403_direct(con, project_id, username, user_id)
    if err:
        return err
    eraser_geom = _footprint(points, stroke_width, outline=outline)
    if eraser_geom is None or eraser_geom.is_empty:
        return {'deletedAnnotationIds': [], 'tileStates': []}, 200
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
    return {'deletedAnnotationIds': deleted_ids, 'tileStates': list(dirtied.values())}, 200


@projects_bp.post('/api/projects/<project_id>/annotations/erase-stroke')
@login_required
def erase_stroke(project_id: str):
    """Brush eraser: soft-delete every LIVE annotation of this image+annotator (any kind)
    whose painted footprint intersects the swept eraser brush polygon.

    Erase deletes the WHOLE intersected annotation(s) — no stroke-level logic, no area-
    subtraction. Splits are impossible by construction: a mask only ever grows (via fuse)
    or is deleted whole. Geometry stays server-authoritative: the eraser polygon is built
    with the same `_stroke_polygon` helper used for paint strokes, then passed through
    `_exterior_only` so a self-intersecting (looped) eraser stroke fills solid instead of
    testing against a hollow donut — a lesion circled entirely within the loop, without the
    eraser ever touching the lesion's own strokes, is still enclosed and gets erased, matching
    the brush's loop-fills-solid behavior. Each candidate's own geometry comes from
    `_annotation_geom` (stored fused rings for masks, fresh points for 1:1 kinds — never
    recomputed from raw strokes).

    Body: { imageId, annotator, points, strokeWidth, outline? } — same shape as a paint
    stroke commit (points + brush size, optionally the perfect-freehand outline).
    Returns: { deletedAnnotationIds: [...], tileStates: [...] }

    Thin shim around do_erase_stroke — the WS op handler in webapp/asgi.py calls the
    same core function so mutations serialize through the single WS channel (Phase 2).
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_erase_stroke(
            con, project_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
    finally:
        _db.close_db(con)


def do_reverse_annotation_merge(con, project_id: str, body: dict, *,
                                 username: str | None, user_id, is_admin: bool):
    """Core of reverse_annotation_merge — returns (response_dict, status). See the
    route shim's docstring below for the full contract. Phase 2 (feat/annotation-ws):
    the WS op handler in webapp/asgi.py calls this same function for the
    `reverse_merge` op so merge-undo mutations serialize through the single WS channel."""
    annotation_id = body.get('annotationId')
    stroke_id = body.get('strokeId')
    groups = body.get('consumedGroups') or []
    if not (annotation_id and stroke_id and groups):
        return {'error': 'annotationId, strokeId, consumedGroups required'}, 400
    row = con.execute('SELECT * FROM annotation WHERE id = ?', (annotation_id,)).fetchone()
    if not row:
        return {'error': 'not found'}, 404
    err = (_member_or_403_direct(con, project_id, username, user_id)
           or _owner_or_403_direct(row['annotator'], username))
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

    proj_row = _project(con, project_id)
    classes_json = proj_row.get('classes_json') if proj_row else None
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
        resurrected.append(_annotation_out(r, con, raw_taxonomy=classes_json))
    for d in _mark_tiles_dirty(con, created_tiles, row['annotator']):
        dirtied[d['tileId']] = d
    con.commit()
    return {'ok': True, 'resurrected': resurrected,
            'deletedAnnotationId': annotation_id,
            'tileStates': list(dirtied.values())}, 200


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

    Thin shim around do_reverse_annotation_merge — the WS op handler in webapp/asgi.py
    calls the same core function so mutations serialize through the single WS channel
    (Phase 2).
    """
    body = request.json or {}
    con = _db.get_db()
    try:
        result, status = do_reverse_annotation_merge(
            con, project_id, body,
            username=session.get('username') or '',
            user_id=session.get('user_id'),
            is_admin=session.get('username') == 'admin')
        return jsonify(result), status
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
    try:
        img = imaging.get_image(im['image_hash'], im['image_ext'])
    except FileNotFoundError:
        return jsonify({'error': 'image file not found'}), 404
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
    try:
        img = imaging.get_image(im['image_hash'], im['image_ext'])
    except FileNotFoundError:
        return jsonify({'error': 'image file not found'}), 404
    return send_file(_bytesio(imaging.crop_png(img, x, y, w, h)), mimetype='image/png')


def _bytesio(data: bytes):
    import io
    return io.BytesIO(data)
