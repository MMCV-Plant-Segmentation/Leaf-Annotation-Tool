"""taxonomy v2 — compound labels + per-annotation denormalized label snapshot

Revision ID: 0004_taxonomy_v2
Revises: 0003_viewport_event
Create Date: 2026-07-05

Phase 1 of per-project compound labels (taxonomy v2). The taxonomy itself (groups +
saved compounds) lives in the EXISTING `project.classes_json` TEXT column as a JSON
object with a `schema: "compound-v2"` discriminator (see webapp/taxonomy.py) — NO new
table is created for it; legacy flat `classes_json` values are upgraded transparently on
read, so this migration touches NO project row.

The ONE schema change here is adding a single `label_snapshot` TEXT column to
`annotation`: the denormalized snapshot of the compound a lesion was painted with
(`{name, color, selections}`), persisted at assign time so a later preset edit/delete
never orphans a lesion's meaning. It is JSON (base64-friendly for future export) and
keeps per-group selections queryable. Existing annotation rows get NULL — they keep
rendering from their bare `label` text exactly as before (the read path is lenient).

Additive only (batch mode is mandatory for SQLite ALTER on existing tables; this is a
pure column add so the rebuild is a faithful copy).
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0004_taxonomy_v2'
down_revision: Union[str, None] = '0003_viewport_event'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add the denormalized compound-snapshot column. Existing rows stay NULL: they keep
    # rendering from their bare `label` text (lenient read path), and new paints populate
    # the snapshot from the project's taxonomy at assign time (see webapp.projects).
    with op.batch_alter_table('annotation', schema=None) as batch_op:
        batch_op.add_column(sa.Column('label_snapshot', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('annotation', schema=None) as batch_op:
        batch_op.drop_column('label_snapshot')
