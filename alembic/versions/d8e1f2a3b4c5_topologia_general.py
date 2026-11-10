"""topologia general: flag en dispositivos

Revision ID: d8e1f2a3b4c5
Revises: b7e2a4c08d51
Create Date: 2026-11-08 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd8e1f2a3b4c5'
down_revision: Union[str, None] = 'b7e2a4c08d51'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'dispositivos',
        sa.Column('en_topologia', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    )


def downgrade() -> None:
    op.drop_column('dispositivos', 'en_topologia')
