"""batch_member — batch membership as a first-class, editable set (t126 Phase 2)

Revision ID: 0013_batch_member
Revises: 0012_orphan_labels
Create Date: 2026-07-22

Christian, t126 Phase 2: "Users are assigned to BATCHES; batches have TILES; users own the
ANNOTATIONS they place." Phase 1 made per-(member,tile) completion lazy but left
"membership" implicit (= the live project roster). This migration makes membership a real
STORED, EDITABLE set per batch: `batch_member (batch_id, annotator)` is the source of truth
for who is on a batch — readiness/progress derive from it, not from `project_annotator`.

Additive only (new table, no existing table touched). Seeds each EXISTING batch's
membership from the CURRENT project roster (`project_annotator` bylines for that batch's
project) — this preserves today's behaviour exactly, since Phase 1 treated membership as
== the live roster. Idempotent (INSERT OR IGNORE on the (batch_id, annotator) PK).

Downgrade: drop the table (pure re-derivable membership data, safe to drop).
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0013_batch_member'
down_revision: Union[str, None] = '0012_orphan_labels'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('''
        CREATE TABLE batch_member (
          batch_id   TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
          annotator  TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (batch_id, annotator)
        )
    ''')
    # Seed existing batches' membership from the CURRENT project roster (preserves
    # today's "membership == live roster" behaviour for anything cut before Phase 2).
    op.execute('''
        INSERT OR IGNORE INTO batch_member (batch_id, annotator, created_at)
        SELECT b.id, pa.byline, COALESCE(b.created_at, '1970-01-01T00:00:00')
        FROM batch b
        JOIN project_annotator pa ON pa.project_id = b.project_id
    ''')


def downgrade() -> None:
    op.execute('DROP TABLE IF EXISTS batch_member')
