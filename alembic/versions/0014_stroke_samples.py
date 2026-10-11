"""stroke.samples_json — additive per-stroke max-rate input stream (t141 P1a)

A stroke gains a SECOND channel alongside its coarse points + server-derived geometry:
the raw max-rate capture (`samples`) — one entry per pointer sample carrying
x, y, t (ms from the stroke's first sample), pressure, tiltX, tiltY, twist, pointerType —
stored as a per-stroke JSON blob.

Additive + nullable: a stroke drawn without rich capture, and every pre-existing row, has
samples_json = NULL (reads back as no samples). Geometry is untouched — it is still derived
server-side from the points; the stream never perturbs the mask. A future pass may retire
the coarse points once we know which sample fields to keep (redundancy noted, t141).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0014_stroke_samples'
down_revision: Union[str, None] = 'ee3a4d0aa2aa'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('stroke', sa.Column('samples_json', sa.Text(), nullable=True))


def downgrade() -> None:
    # Reflection-accurate rebuild (SQLite pre-3.35 can't DROP COLUMN); batch mode copies
    # every other column + index for us.
    with op.batch_alter_table('stroke') as batch:
        batch.drop_column('samples_json')
