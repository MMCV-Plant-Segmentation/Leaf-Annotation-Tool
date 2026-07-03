"""viewport telemetry — record pan/zoom (SVG viewBox) samples per annotator/image

Revision ID: 0003_viewport_event
Revises: 0002_annotation_stroke_model
Create Date: 2026-07-03

Adds an append-only `viewport_event` table: one row per captured canvas viewport sample
(settle-debounced + heartbeat, see webapp/frontend/src/projects/viewportTelemetry.ts).
Purely additive — no existing table is touched. Purpose: analyze how users view images at
different magnifications, to eventually support per-user "vision level" tile sizing (see
the viewport-telemetry task doc). No UI reads this yet; that's a later admin-heatmap task.

`id` is an INTEGER AUTOINCREMENT (unlike the UUID-keyed domain tables) because this is a
high-volume, append-only log rather than a referenced domain entity — matches the `users`
/ `invite_codes` precedent in 0001_baseline.py.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0003_viewport_event'
down_revision: Union[str, None] = '0002_annotation_stroke_model'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('''
        CREATE TABLE viewport_event (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          image_id     TEXT REFERENCES project_image(id) ON DELETE CASCADE,
          user_id      TEXT NOT NULL,
          client_ts    TEXT NOT NULL,
          received_at  TEXT NOT NULL,
          x            REAL NOT NULL,
          y            REAL NOT NULL,
          w            REAL NOT NULL,
          h            REAL NOT NULL,
          css_w        REAL NOT NULL,
          css_h        REAL NOT NULL,
          dpr          REAL NOT NULL
        )
    ''')
    op.execute(
        'CREATE INDEX idx_viewport_event_lookup '
        'ON viewport_event (project_id, image_id, user_id)'
    )
    op.execute(
        'CREATE INDEX idx_viewport_event_received_at ON viewport_event (received_at)'
    )


def downgrade() -> None:
    op.execute('DROP INDEX IF EXISTS idx_viewport_event_received_at')
    op.execute('DROP INDEX IF EXISTS idx_viewport_event_lookup')
    op.execute('DROP TABLE IF EXISTS viewport_event')
