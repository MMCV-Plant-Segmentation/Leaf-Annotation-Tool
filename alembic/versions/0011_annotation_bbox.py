"""annotation bounding box — consolidated server-side spatial index (t68-i1)

Revision ID: 0011_annotation_bbox
Revises: 0010_vertex_normalization
Create Date: 2026-07-21

Christian, 2026-07-21. t68: a consolidated, tile-size-INDEPENDENT server-side spatial index
for the polygon-overlap queries (create-fuse candidate lookup, eraser hit-test, …) that today
scan every annotation on the image. Mechanism = a persisted axis-aligned bounding box per
annotation (`min_x,min_y,max_x,max_y`) + a per-image composite index. Queries bbox-prune in SQL
(`WHERE project_image_id=? AND deleted_at IS NULL AND min_x<=qmaxx AND max_x>=qminx AND …`) then
run the exact shapely test only on candidates.

Chosen over a SQLite R*Tree because annotations are soft-deleted + re-minted constantly (every
fusion): bbox columns only need maintenance at the 3 geometry-INSERT sites, and soft-deleted rows
drop out for free via `deleted_at IS NULL` — an R*Tree would need explicit delete/re-insert at all
12 soft-delete/undelete sites. Tile-size-independent either way (it indexes real geometry bboxes).

Backfill: derive each existing annotation's bbox from its stored geometry — `geometry_json` rings
for fused stroke masks (the authoritative rendered geometry), else `points_json` for other kinds.
Rows with no usable geometry keep NULL bbox (they never match a bbox-overlap query, which is
correct: a null-geometry annotation has no footprint to overlap).
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = '0011_annotation_bbox'
down_revision: Union[str, None] = '0010_vertex_normalization'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bbox_from_stored(geometry_json, points_json):
    """(min_x,min_y,max_x,max_y) from stored geometry, or None. Prefers the fused ring
    geometry (stroke masks); falls back to raw points (other kinds)."""
    coords: list = []
    if geometry_json:
        for ring in json.loads(geometry_json) or []:
            coords.extend(ring or [])
    if not coords and points_json:
        coords = json.loads(points_json) or []
    pts = [(float(p[0]), float(p[1])) for p in coords if p is not None and len(p) >= 2]
    if not pts:
        return None
    xs = [x for x, _ in pts]
    ys = [y for _, y in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def upgrade() -> None:
    for col in ('min_x', 'min_y', 'max_x', 'max_y'):
        op.execute(f'ALTER TABLE annotation ADD COLUMN {col} REAL')
    op.execute('CREATE INDEX idx_annotation_bbox '
               'ON annotation (project_image_id, deleted_at, min_x, max_x)')

    conn = op.get_bind()
    rows = conn.execute(sa.text(
        'SELECT id, geometry_json, points_json FROM annotation')).fetchall()
    for aid, geometry_json, points_json in rows:
        bbox = _bbox_from_stored(geometry_json, points_json)
        if bbox is None:
            continue
        conn.execute(
            sa.text('UPDATE annotation SET min_x=:a, min_y=:b, max_x=:c, max_y=:d WHERE id=:id'),
            {'a': bbox[0], 'b': bbox[1], 'c': bbox[2], 'd': bbox[3], 'id': aid})


def downgrade() -> None:
    op.execute('DROP INDEX IF EXISTS idx_annotation_bbox')
    for col in ('min_x', 'min_y', 'max_x', 'max_y'):
        op.execute(f'ALTER TABLE annotation DROP COLUMN {col}')
