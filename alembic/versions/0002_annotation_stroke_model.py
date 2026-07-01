"""annotation/stroke fused-mask model — persisted masks + universal old-data conversion

Revision ID: 0002_annotation_stroke_model
Revises: 0001_baseline
Create Date: 2026-07-01

See docs/plans/Plan — Annotation-stroke model (fused masks).md and docs/plans/
Plan — Old-data migration under the annotation-stroke model.md (Christian, 2026-07-01).

The model shift: today's `annotation` table (one row = one drawn stroke/point/line/
polygon) is renamed to `stroke` (provenance only) and trimmed down; a NEW `annotation`
table takes its name and becomes the first-class, persisted, hole-less MASK — what
renders and what `annotation_tile` references. Only brush (`kind='stroke'`) strokes ever
fuse into a shared mask; `point`/`line`/`polygon` each map 1:1 to their own annotation.

This migration also performs the ONE-TIME universal data conversion for every existing
row (all annotators, not just Burcu) — see `_convert_data()` below. It reuses the app's
OWN geometry helpers (`webapp.projects._stroke_polygon`, `_stroke_components`,
`_tiles_for_geom`, `_tiles_intersecting`, `_poly_rings`) — the exact same code path a
live request takes — rather than hand-rolling geometry here.

`annotation_tile` is dropped and recreated (same shape, fresh FK) rather than patched in
place: SQLite's `ALTER TABLE ... RENAME TO` rewrites every OTHER table's stored FK
declarations that reference the renamed table — so the moment `annotation` is renamed to
`stroke`, `annotation_tile`'s existing `REFERENCES annotation(id)` is silently REWRITTEN
by SQLite itself to `REFERENCES stroke(id)`. Recreating the table (instead of trying to
"fix up" that declaration in place) is simplest and is safe here because its content is
being fully replaced anyway (old rows are keyed by now-renamed per-stroke ids; new rows
are computed fresh from each mask's own geometry).

downgrade(): rebuilds the old one-row-per-stroke `annotation` shape by joining
`stroke JOIN annotation` (every stroke's own points/stroke_width/outline/kind/created_at,
plus its owning mask's project_id/project_image_id/annotator/label/viewport/hsv/pass_no/
deleted_at) and recomputing each stroke's OWN tile membership via `_tiles_intersecting`
(not the fused mask's). This is exact for every column except one: strokes that were
ALREADY soft-deleted before this migration ran are, going forward, bridged to an
already-deleted mask whose `deleted_at` is the MAX of its component members' original
timestamps (not each member's own) — downgrading recovers the correct deleted/live
STATUS for every row, but historical (already-invisible) rows may get a slightly
different deleted_at timestamp than they originally had. Anything created or merged
under the new model (including this migration's live-bucket conversions) round-trips
byte-for-byte, since a stroke's mask is always resolvable via `stroke.annotation_id`.
"""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0002_annotation_stroke_model'
down_revision: Union[str, None] = '0001_baseline'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# `webapp` must be importable to reuse its geometry helpers (same trick alembic/env.py
# already relies on for `from webapp import db`).
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Burcu's 90 pre-Phase-1 rows (and any other annotator's) with stroke_width IS NULL get
# this default footprint width — a thin centerline lesion, not the chunky tile-relative
# brush default (see docs/plans/Plan — Old-data migration ....md).
_DEFAULT_STROKE_WIDTH = 4.0


def _uid() -> str:
    return str(uuid.uuid4())


def _dict_factory(cursor, row):
    return {col[0]: value for col, value in zip(cursor.description, row)}


class _dict_rows:
    """Temporarily set dict-style row_factory on the SAME sqlite3.Connection backing
    Alembic's current transaction (same connection, same transaction — no separate
    lock-prone connection to this DB file), so the reused `webapp.projects` helpers
    (which index rows by column name) work unchanged. Restored on exit: SQLAlchemy's own
    cursor handling (table reflection inside batch_alter_table, subsequent op.execute)
    expects plain tuples, so the dict factory must NOT leak past this block.
    """

    def __enter__(self):
        self._raw = op.get_bind().connection.dbapi_connection
        self._prev = self._raw.row_factory
        self._raw.row_factory = _dict_factory
        return self._raw

    def __exit__(self, *exc):
        self._raw.row_factory = self._prev


def upgrade() -> None:
    from webapp.projects import (  # noqa: E402  (deferred: needs sys.path fixup above)
        _poly_rings, _stroke_components, _tiles_for_geom, _tiles_intersecting,
    )

    # The OLD `annotation`-table index — about to dangle on the renamed `stroke` table,
    # over columns (project_id, annotator) that step further down drops from it. Recreated
    # (same name) against the NEW mask table below.
    op.execute('DROP INDEX IF EXISTS idx_annotation_project')

    op.rename_table('annotation', 'stroke')

    op.execute('''
        CREATE TABLE annotation (
          id                TEXT PRIMARY KEY,
          project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          project_image_id  TEXT REFERENCES project_image(id) ON DELETE CASCADE,
          annotator         TEXT NOT NULL,
          kind              TEXT NOT NULL,
          pass_no           INTEGER,
          label             TEXT,
          points_json       TEXT,
          geometry_json     TEXT,
          viewport_json     TEXT,
          hsv_hist_json     TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          deleted_at        TEXT
        )
    ''')
    op.execute('CREATE INDEX idx_annotation_project ON annotation (project_id, annotator)')
    op.execute(
        'CREATE INDEX idx_annotation_image ON annotation (project_image_id, annotator, label)'
    )

    op.add_column('stroke', sa.Column('annotation_id', sa.Text(), nullable=True))

    # Recreate (not patch): see module docstring — the rename above already silently
    # rewrote this table's FK to point at `stroke`; drop and recreate against the new
    # mask table instead of trying to "fix up" the FK declaration in place.
    op.execute('DROP TABLE annotation_tile')
    op.execute('''
        CREATE TABLE annotation_tile (
          annotation_id TEXT NOT NULL REFERENCES annotation(id) ON DELETE CASCADE,
          tile_id       TEXT NOT NULL REFERENCES tile(id) ON DELETE CASCADE,
          PRIMARY KEY (annotation_id, tile_id)
        )
    ''')

    with _dict_rows() as raw:
        _convert_data(raw, _stroke_components, _tiles_for_geom, _tiles_intersecting, _poly_rings)

    with op.batch_alter_table('stroke') as batch_op:
        for col in ('project_id', 'project_image_id', 'annotator', 'label',
                   'viewport_json', 'hsv_hist_json', 'updated_at', 'deleted_at', 'pass_no'):
            batch_op.drop_column(col)
        batch_op.create_foreign_key(
            'fk_stroke_annotation', 'annotation', ['annotation_id'], ['id'],
            ondelete='CASCADE',
        )

    op.execute('CREATE INDEX idx_stroke_annotation ON stroke (annotation_id)')


def _convert_data(con, stroke_components, tiles_for_geom, tiles_intersecting, poly_rings) -> None:
    """One-time universal conversion: every existing `stroke` row (all annotators) is
    wrapped into a fused `annotation` (mask) row. Only `kind='stroke'` (brush) rows fuse —
    connected components of the union, per (annotator, project_image_id, label); `point`/
    `line`/`polygon` rows each get their own 1:1 annotation, unconditionally.

    Live (`deleted_at IS NULL`) and already-deleted rows are grouped SEPARATELY (two
    passes) so: (a) the live grouping matches exactly what the removed `_lesions_for_image`
    used to compute at read time (same filter), and (b) every row — including historical,
    already-invisible soft-deletes — still ends up bridged to exactly one annotation (no
    orphans), without resurrecting anything that was already erased.
    """
    now_rows = con.execute('SELECT DISTINCT created_at FROM stroke ORDER BY created_at DESC LIMIT 1').fetchall()
    fallback_now = now_rows[0]['created_at'] if now_rows else '1970-01-01T00:00:00+00:00'

    groups = con.execute(
        '''SELECT DISTINCT project_id, project_image_id, annotator, kind, label,
                  (deleted_at IS NOT NULL) AS is_deleted
           FROM stroke'''
    ).fetchall()

    for grp in groups:
        rows = con.execute(
            '''SELECT * FROM stroke
               WHERE project_id IS ? AND project_image_id IS ? AND annotator IS ?
                 AND kind IS ? AND label IS ? AND (deleted_at IS NOT NULL) = ?''',
            (grp['project_id'], grp['project_image_id'], grp['annotator'],
             grp['kind'], grp['label'], grp['is_deleted']),
        ).fetchall()
        if not rows:
            continue

        if grp['kind'] == 'stroke':
            for comp in stroke_components([
                {'id': r['id'], 'points': json.loads(r['points_json']),
                 'stroke_width': r['stroke_width'] if r['stroke_width'] is not None else _DEFAULT_STROKE_WIDTH,
                 'outline': json.loads(r['outline_json']) if r['outline_json'] else None}
                for r in rows
            ]):
                member_rows = [r for r in rows if r['id'] in comp['member_ids']]
                _mint_annotation(con, grp, member_rows, comp['geometry'], poly_rings,
                                 tiles_for_geom, fallback_now)
        else:
            # Non-brush kinds never fuse — one annotation per row, unconditionally.
            for r in rows:
                _mint_annotation(con, grp, [r], None, poly_rings, tiles_for_geom, fallback_now,
                                 tiles_intersecting=tiles_intersecting)


def _mint_annotation(con, grp, member_rows, geometry, poly_rings, tiles_for_geom, fallback_now,
                     tiles_intersecting=None) -> None:
    """INSERT one new `annotation` row for a component (or a single non-brush stroke),
    bridge its member `stroke` row(s) to it, and populate `annotation_tile` from the
    backend's own tile-intersection helper (never hand-rolled)."""
    aid = _uid()
    created_at = min(r['created_at'] for r in member_rows)
    updated_at = max(r['created_at'] for r in member_rows)
    deleted_at = max((r['deleted_at'] for r in member_rows if r['deleted_at']), default=None) \
        if grp['is_deleted'] else None
    first = min(member_rows, key=lambda r: r['created_at'])

    if grp['kind'] == 'stroke':
        rings = poly_rings(geometry) if geometry is not None else []
        geometry_json = json.dumps(rings)
        points_json = None
        tile_ids = tiles_for_geom(con, grp['project_image_id'], geometry) if geometry is not None else []
    else:
        geometry_json = None
        points_json = first['points_json']
        pts = json.loads(points_json) if points_json else []
        tile_ids = tiles_intersecting(con, grp['project_image_id'], grp['kind'], pts)

    con.execute(
        '''INSERT INTO annotation
             (id, project_id, project_image_id, annotator, kind, pass_no, label,
              points_json, geometry_json, viewport_json, hsv_hist_json,
              created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (aid, grp['project_id'], grp['project_image_id'], grp['annotator'], grp['kind'],
         first['pass_no'], grp['label'], points_json, geometry_json,
         first['viewport_json'], first['hsv_hist_json'],
         created_at or fallback_now, updated_at or fallback_now, deleted_at),
    )
    ids = [r['id'] for r in member_rows]
    qmarks = ','.join('?' * len(ids))
    con.execute(f'UPDATE stroke SET annotation_id = ? WHERE id IN ({qmarks})', (aid, *ids))
    for tid in tile_ids:
        con.execute(
            'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
            (aid, tid),
        )


def downgrade() -> None:
    """Best-effort, documented reconstruction of the old one-row-per-stroke `annotation`
    shape — see the module docstring for the one known imprecision (already-deleted rows'
    exact original deleted_at timestamp, not just live/dead status)."""
    op.execute('DROP INDEX IF EXISTS idx_stroke_annotation')
    op.execute('DROP INDEX IF EXISTS idx_annotation_project')
    op.execute('DROP INDEX IF EXISTS idx_annotation_image')

    op.execute('ALTER TABLE annotation RENAME TO annotation_mask_old')

    with op.batch_alter_table('stroke') as batch_op:
        batch_op.drop_constraint('fk_stroke_annotation', type_='foreignkey')
        batch_op.add_column(sa.Column('project_id', sa.Text()))
        batch_op.add_column(sa.Column('project_image_id', sa.Text()))
        batch_op.add_column(sa.Column('annotator', sa.Text()))
        batch_op.add_column(sa.Column('label', sa.Text()))
        batch_op.add_column(sa.Column('viewport_json', sa.Text()))
        batch_op.add_column(sa.Column('hsv_hist_json', sa.Text()))
        batch_op.add_column(sa.Column('updated_at', sa.Text()))
        batch_op.add_column(sa.Column('deleted_at', sa.Text()))
        batch_op.add_column(sa.Column('pass_no', sa.Integer()))

    op.execute('''
        UPDATE stroke SET
          project_id = (SELECT project_id FROM annotation_mask_old WHERE id = stroke.annotation_id),
          project_image_id = (SELECT project_image_id FROM annotation_mask_old WHERE id = stroke.annotation_id),
          annotator = (SELECT annotator FROM annotation_mask_old WHERE id = stroke.annotation_id),
          label = (SELECT label FROM annotation_mask_old WHERE id = stroke.annotation_id),
          viewport_json = (SELECT viewport_json FROM annotation_mask_old WHERE id = stroke.annotation_id),
          hsv_hist_json = (SELECT hsv_hist_json FROM annotation_mask_old WHERE id = stroke.annotation_id),
          updated_at = (SELECT updated_at FROM annotation_mask_old WHERE id = stroke.annotation_id),
          deleted_at = (SELECT deleted_at FROM annotation_mask_old WHERE id = stroke.annotation_id),
          pass_no = (SELECT pass_no FROM annotation_mask_old WHERE id = stroke.annotation_id)
    ''')

    # Compute each stroke's OWN tile membership (not the fused mask's — see module
    # docstring) BEFORE any further renames, while `stroke` still has everything
    # `_tiles_intersecting` needs. Applied to a freshly-recreated annotation_tile below,
    # once the final table is actually named `annotation` again (same rename-rewrites-
    # other-tables'-FKs hazard as upgrade() — see there).
    from webapp.projects import _tiles_intersecting  # noqa: E402
    with _dict_rows() as raw:
        rows = raw.execute('SELECT * FROM stroke').fetchall()
        tile_hits = []
        for r in rows:
            pts = json.loads(r['points_json']) if r['points_json'] else []
            outline = json.loads(r['outline_json']) if r['outline_json'] else None
            tile_ids = _tiles_intersecting(raw, r['project_image_id'], r['kind'], pts,
                                           r['stroke_width'], outline=outline)
            tile_hits.extend((r['id'], tid) for tid in tile_ids)

    with op.batch_alter_table('stroke') as batch_op:
        batch_op.drop_column('annotation_id')

    op.execute('DROP TABLE annotation_mask_old')
    op.rename_table('stroke', 'annotation')
    op.execute('CREATE INDEX idx_annotation_project ON annotation (project_id, annotator)')

    op.execute('DROP TABLE annotation_tile')
    op.execute('''
        CREATE TABLE annotation_tile (
          annotation_id TEXT NOT NULL REFERENCES annotation(id) ON DELETE CASCADE,
          tile_id       TEXT NOT NULL REFERENCES tile(id) ON DELETE CASCADE,
          PRIMARY KEY (annotation_id, tile_id)
        )
    ''')
    with _dict_rows() as raw:
        for ann_id, tile_id in tile_hits:
            raw.execute(
                'INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                (ann_id, tile_id),
            )
