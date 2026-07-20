"""annotation.compound_id — annotations reference a compound by stable ID

Revision ID: 0009_annotation_compound_id
Revises: 0008_merge_submission
Create Date: 2026-07-19

t64 (Christian, 2026-07-19). Today a lesion's label is a NAME string plus a frozen
`label_snapshot` — renaming/recolouring a compound leaves old lesions stale, and
deleting a referenced compound silently orphans them. This migration adds a NULLABLE
`annotation.compound_id` column so a lesion instead references its compound by a
STABLE id; display then resolves {name,color,selections} LIVE from the project's
CURRENT taxonomy (see webapp/taxonomy.py `compounds_by_id` / `id_from_label`,
webapp/projects.py `_annotation_out`). `label_snapshot` is demoted to a fallback used
only when `compound_id` is null/unresolvable (e.g. this migration's best-effort miss).

Backfill (best-effort, per project): for every existing annotation, resolve its
`label` (compound NAME at paint time) against that project's CURRENT taxonomy the same
way `taxonomy.id_from_label` does — an exact name match. A miss (renamed/deleted
compound, legacy free-text label, or no `classes_json`) leaves `compound_id` NULL; the
lesion keeps rendering from its bare `label` text / `label_snapshot`, exactly as before
this migration (no data loss — see `_annotation_out`'s fallback).

Additive only (batch mode is mandatory for SQLite ALTER on existing tables; this is a
pure column add so the rebuild is a faithful copy).
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0009_annotation_compound_id'
down_revision: Union[str, None] = '0008_merge_submission'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('annotation', schema=None) as batch_op:
        batch_op.add_column(sa.Column('compound_id', sa.Text(), nullable=True))

    # Best-effort backfill: resolve each existing annotation's `label` (a compound NAME
    # at paint time) to its CURRENT project's matching compound id. Deferred import (the
    # webapp package is only needed here, at migration run time — mirrors the pattern in
    # 0002_annotation_stroke_model.py).
    from webapp import taxonomy as _taxonomy

    conn = op.get_bind()
    projects = conn.execute(sa.text('SELECT id, classes_json FROM project')).fetchall()
    for project_id, classes_json in projects:
        by_id = _taxonomy.compounds_by_id(classes_json)
        by_name = {c['name']: c['id'] for c in by_id.values()}
        rows = conn.execute(
            sa.text('SELECT id, label FROM annotation WHERE project_id = :pid AND label IS NOT NULL'),
            {'pid': project_id},
        ).fetchall()
        for ann_id, label in rows:
            cid = by_name.get(label)
            if cid:
                conn.execute(
                    sa.text('UPDATE annotation SET compound_id = :cid WHERE id = :aid'),
                    {'cid': cid, 'aid': ann_id},
                )


def downgrade() -> None:
    with op.batch_alter_table('annotation', schema=None) as batch_op:
        batch_op.drop_column('compound_id')
