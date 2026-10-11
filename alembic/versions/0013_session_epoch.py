"""per-user session epoch — a password change invalidates that user's active sessions (t124)

Revision ID: 0013_session_epoch
Revises: 0012_orphan_labels
Create Date: 2026-07-22

Christian, t124: a password change must log the user out EVERYWHERE (choice B — including the
device that made the change). Mechanism: a per-user `session_epoch` counter, stamped into the
Flask session at login and bumped on every password write; `login_required`/`admin_required`
re-validate it per request (see webapp/auth.py `_require_session`).

NOTE: a parallel branch (t-batch-member) also revises 0012 as `0013_batch_member` — Opus will
merge the two heads at integration time.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = '0013_session_epoch'
down_revision: Union[str, None] = '0012_orphan_labels'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0')


def downgrade() -> None:
    op.execute('ALTER TABLE users DROP COLUMN session_epoch')
