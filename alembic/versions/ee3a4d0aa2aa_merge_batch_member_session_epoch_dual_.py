"""merge batch_member + session_epoch (dual 0013 head)

Revision ID: ee3a4d0aa2aa
Revises: 0013_batch_member, 0013_session_epoch
Create Date: 2026-07-22 12:50:55.162635

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ee3a4d0aa2aa'
down_revision: Union[str, Sequence[str], None] = ('0013_batch_member', '0013_session_epoch')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
