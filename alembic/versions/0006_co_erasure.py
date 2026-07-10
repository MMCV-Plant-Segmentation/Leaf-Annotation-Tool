"""co_erasure — merger's per-mark "not a lesion / error" toggle vote

Revision ID: 0006_co_erasure
Revises: 0005_candidate_objects
Create Date: 2026-07-10

Merge Phase 2a (backend): during merge mode a merger may cast an erasure vote on a
pooled mark — a recoverable TOGGLE (delete the row to un-erase, recovery beyond
undo/redo), scoped to the merger who cast it (see webapp/projects.py). The
(batch, merger, annotation) triple is UNIQUE so a repeat erase of the same mark
is a no-op instead of a duplicate row; and the annotation itself is never
touched (recovery preserves the source mark for provenance).

Additive only — every existing table (including 0005's candidate_object /
co_membership) is untouched.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0006_co_erasure'
down_revision: Union[str, None] = '0005_candidate_objects'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('''
        CREATE TABLE co_erasure (
          id            TEXT PRIMARY KEY,
          batch_id      TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
          merger        TEXT NOT NULL,
          annotation_id TEXT NOT NULL REFERENCES annotation(id) ON DELETE CASCADE,
          created_at    TEXT NOT NULL,
          UNIQUE (batch_id, merger, annotation_id)
        )
    ''')
    op.execute(
        'CREATE INDEX idx_co_erasure_batch_merger '
        'ON co_erasure (batch_id, merger)'
    )


def downgrade() -> None:
    op.execute('DROP INDEX IF EXISTS idx_co_erasure_batch_merger')
    op.execute('DROP TABLE IF EXISTS co_erasure')
