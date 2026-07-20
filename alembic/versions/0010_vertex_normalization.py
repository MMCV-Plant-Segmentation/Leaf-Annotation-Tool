"""vertex normalization — vertex + stroke_vertex tables (t50 phase 1)

Revision ID: 0010_vertex_normalization
Revises: 0009_annotation_compound_id
Create Date: 2026-07-20

Christian, 2026-07-20. Phase 1 of vertex snapping (t50) — pure storage + backfill, ZERO
behaviour change (no snapping yet — that lands later as its own dispatch). Adds:

  Table `vertex(id, x, y)` — a first-class geometric vertex; canonical position at full
      sub-pixel precision. Identity, NOT coordinate-dedup: two vertices at the same spot
      are DISTINCT rows until a future snap makes one reference the other (phase 2).
  Table `stroke_vertex(stroke_id, seq, vertex_id, size)` — a stroke references an ORDERED
      list of vertices. `size` is that point's own brush diameter (t62 per-point width)
      and lives on the REFERENCE, not the shared vertex — NULL means a legacy 2-tuple
      point (falls back to the stroke's own `stroke_width`).

Backfill: every existing `stroke` row's inline `points_json` (a list of `[x,y]` or
`[x,y,size]`) is parsed into one `vertex` + one `stroke_vertex` per point, 1:1, in order,
full precision, NO sharing — exactly what a fresh create does under this model
(see webapp/projects.py `_write_stroke_vertices`). Existing data survives untouched;
`stroke.points_json` itself is left in place (still written by the app for the
unchanged shapely fusion/geometry seam) but demoted — reads now come from these tables.
"""
from __future__ import annotations

import json
import uuid
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0010_vertex_normalization'
down_revision: Union[str, None] = '0009_annotation_compound_id'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('''
        CREATE TABLE vertex (
          id TEXT PRIMARY KEY,
          x  REAL NOT NULL,
          y  REAL NOT NULL
        )
    ''')
    op.execute('''
        CREATE TABLE stroke_vertex (
          stroke_id TEXT NOT NULL REFERENCES stroke(id) ON DELETE CASCADE,
          seq       INTEGER NOT NULL,
          vertex_id TEXT REFERENCES vertex(id),
          size      REAL,
          PRIMARY KEY (stroke_id, seq)
        )
    ''')
    op.execute('CREATE INDEX idx_stroke_vertex_vertex ON stroke_vertex (vertex_id)')

    # Backfill every existing stroke's inline points_json 1:1 — no sharing (identity is
    # only ever created by a future snap, phase 2).
    conn = op.get_bind()
    rows = conn.execute(sa.text('SELECT id, points_json FROM stroke')).fetchall()
    for stroke_id, points_json in rows:
        if not points_json:
            continue
        points = json.loads(points_json)
        for seq, p in enumerate(points):
            vid = str(uuid.uuid4())
            x, y = float(p[0]), float(p[1])
            size = float(p[2]) if len(p) >= 3 and p[2] is not None else None
            conn.execute(sa.text('INSERT INTO vertex (id, x, y) VALUES (:id, :x, :y)'),
                        {'id': vid, 'x': x, 'y': y})
            conn.execute(
                sa.text('INSERT INTO stroke_vertex (stroke_id, seq, vertex_id, size) '
                        'VALUES (:sid, :seq, :vid, :size)'),
                {'sid': stroke_id, 'seq': seq, 'vid': vid, 'size': size})


def downgrade() -> None:
    op.execute('DROP TABLE IF EXISTS stroke_vertex')
    op.execute('DROP TABLE IF EXISTS vertex')
