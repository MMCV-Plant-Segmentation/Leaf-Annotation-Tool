"""candidate objects — merger's lesion-hypothesis (member marks only)

Revision ID: 0005_candidate_objects
Revises: 0004_taxonomy_v2
Create Date: 2026-07-10

Merge Phase 2a (backend): a candidate object (CO) is a merger's lesion-hypothesis
during merge mode; its identity is its MEMBER MARKS only. The stroke geometry the
merger brushes onto the canvas to pick members is a client-side gesture — the
BACKEND resolves membership via shapely (see webapp/projects.py) and stores only
the (candidate_object -> annotation) edges. Convex hull / union shape is a FE
display concern, not persisted here.

Two new tables:
  candidate_object  — one row per CO. Soft-deletes via `deleted_at` so a merger's
                      dissolve/undo is reversible and history is preserved.
  co_membership     — the (CO, annotation) edges. A mark may belong to several
                      COs (composite PK), and any CO or annotation removal
                      cascades.

Additive only — reannot_* and every existing table are untouched.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0005_candidate_objects'
down_revision: Union[str, None] = '0004_taxonomy_v2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('''
        CREATE TABLE candidate_object (
          id               TEXT PRIMARY KEY,
          batch_id         TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
          project_image_id TEXT NOT NULL REFERENCES project_image(id) ON DELETE CASCADE,
          merger           TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          deleted_at       TEXT
        )
    ''')
    op.execute(
        'CREATE INDEX idx_candidate_object_batch_merger '
        'ON candidate_object (batch_id, merger)'
    )
    op.execute('''
        CREATE TABLE co_membership (
          candidate_object_id TEXT NOT NULL
                              REFERENCES candidate_object(id) ON DELETE CASCADE,
          annotation_id       TEXT NOT NULL
                              REFERENCES annotation(id) ON DELETE CASCADE,
          PRIMARY KEY (candidate_object_id, annotation_id)
        )
    ''')


def downgrade() -> None:
    # Child first so its FK is dropped before the parent it references.
    op.execute('DROP TABLE IF EXISTS co_membership')
    op.execute('DROP INDEX IF EXISTS idx_candidate_object_batch_merger')
    op.execute('DROP TABLE IF EXISTS candidate_object')
