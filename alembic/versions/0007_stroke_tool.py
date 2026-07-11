"""stroke.tool — record which input tool created each stroke (brush | polyline)

Polyline click-brush (a11y #40): brush and polyline are two input modes over the SAME
data — a stroke now records the tool that created it, so each tool owns its geometry and
a stroke's look is locked after creation (its stored outline). The annotation mask is
still the cached union of its member strokes, so a polyline fuses like any other stroke.

Additive only: an existing stroke is a brush stroke, so the column defaults to 'brush'
(every pre-existing row is backfilled to 'brush' by the column default).
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0007_stroke_tool'
down_revision: Union[str, None] = '0006_co_erasure'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE stroke ADD COLUMN tool TEXT NOT NULL DEFAULT 'brush'")


def downgrade() -> None:
    # SQLite pre-3.35 can't DROP COLUMN; rebuild the table without `tool`.
    op.execute('ALTER TABLE stroke RENAME TO stroke__old')
    op.execute('''
        CREATE TABLE stroke (
          id            TEXT PRIMARY KEY,
          annotation_id TEXT,
          kind          TEXT,
          points_json   TEXT,
          stroke_width  REAL,
          outline_json  TEXT,
          created_at    TEXT
        )
    ''')
    op.execute('''INSERT INTO stroke
                    (id, annotation_id, kind, points_json, stroke_width, outline_json, created_at)
                  SELECT id, annotation_id, kind, points_json, stroke_width, outline_json, created_at
                  FROM stroke__old''')
    op.execute('DROP TABLE stroke__old')
    op.execute('CREATE INDEX idx_stroke_annotation ON stroke (annotation_id)')
