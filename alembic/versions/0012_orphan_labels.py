"""orphaned painted labels — fold into INVALID compounds (t109)

Revision ID: 0012_orphan_labels
Revises: 0011_annotation_bbox
Create Date: 2026-07-21

Christian, t109: legacy/orphaned painted labels (e.g. `lesion` from pre-v2 data, or a
compound deleted before the t64 delete-guard existed) render fine in the annotator canvas
legend (from `label_snapshot`/bare `label`) but are invisible to the `/projects/:id/labels`
editor because they match no compound in `classes_json`.

This migration folds each ORPHANED painted label into a new INVALID compound (see
`webapp.taxonomy.fold_orphans` — the pure transform this upgrade wraps), so it becomes
visible in the editor's/annotator's `broken` surface (t109 read-side) without changing
what any lesion renders: the synthetic compound's name+color equal the prior effective
label+snapshot colour, so live resolution (`compounds_by_id`/`resolve_compound_snapshot`)
stays byte-identical.

Data-only, per project, idempotent (re-running finds nothing left to fold — a label
already covered by a compound is skipped by `fold_orphans`).

Downgrade: no-op (best-effort data backfill, like 0009 — the synthetic compounds are
data, not schema; reverting the schema doesn't need to unwind them).
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = '0012_orphan_labels'
down_revision: Union[str, None] = '0011_annotation_bbox'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Deferred import — the webapp package is only needed here, at migration run time
    # (mirrors the pattern in 0009_annotation_compound_id.py).
    from webapp import taxonomy as _taxonomy

    conn = op.get_bind()
    projects = conn.execute(sa.text('SELECT id, classes_json FROM project')).fetchall()
    for project_id, classes_json in projects:
        rows = conn.execute(
            sa.text('''SELECT id, label, label_snapshot, compound_id FROM annotation
                       WHERE project_id = :pid AND deleted_at IS NULL'''),
            {'pid': project_id},
        ).fetchall()
        painted = []
        for ann_id, label, label_snapshot, compound_id in rows:
            snapshot = None
            if label_snapshot:
                try:
                    snapshot = json.loads(label_snapshot)
                except (TypeError, ValueError):
                    snapshot = None
            painted.append({
                'id': ann_id, 'label': label, 'snapshot': snapshot,
                'compound_id': compound_id,
            })
        if not painted:
            continue
        result = _taxonomy.fold_orphans(classes_json, painted)
        repoint = result['repoint']
        if not repoint:
            continue
        conn.execute(
            sa.text('UPDATE project SET classes_json = :cj WHERE id = :pid'),
            {'cj': result['classes_json'], 'pid': project_id},
        )
        for ann_id, new_compound_id in repoint.items():
            conn.execute(
                sa.text('UPDATE annotation SET compound_id = :cid WHERE id = :aid'),
                {'cid': new_compound_id, 'aid': ann_id},
            )


def downgrade() -> None:
    # Best-effort data backfill, like 0009 — no-op (synthetic compounds are data, not
    # schema; nothing to unwind).
    pass
