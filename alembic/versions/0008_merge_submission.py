"""merge_submission — merger's explicit "I'm done" lock on a merge pass

Revision ID: 0008_merge_submission
Revises: 0007_stroke_tool
Create Date: 2026-07-12

Merge Phase 2b (backend): a merger's pass is COMPLETE when every pooled mark
for the batch is accounted for — a member of one of THAT merger's LIVE
candidate objects (co_membership via candidate_object.deleted_at IS NULL) OR
erased by that merger (co_erasure). Completeness only ENABLES; the explicit
SUBMIT is the merger's "I'm done — lock my pass so agreement can compute
across mergers" signal (a merger may reach completeness yet keep revising),
recorded per merger.

`(batch_id, merger)` is the PRIMARY KEY so a re-submit UPSERTs (never a 500)
and completeness/submission stay per-merger.

Additive only — every existing table (candidate_object / co_membership /
co_erasure) is untouched.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0008_merge_submission'
down_revision: Union[str, None] = '0007_stroke_tool'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('''
        CREATE TABLE merge_submission (
          batch_id     TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
          merger       TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          PRIMARY KEY (batch_id, merger)
        )
    ''')


def downgrade() -> None:
    op.execute('DROP TABLE IF EXISTS merge_submission')
