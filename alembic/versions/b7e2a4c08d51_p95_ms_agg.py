"""p95_ms en tablas agg

Revision ID: b7e2a4c08d51
Revises: c3d84e91f7a2
Create Date: 2026-11-06 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7e2a4c08d51'
down_revision: Union[str, None] = 'c3d84e91f7a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # el consolidador recalcula los últimos 2 días completos desde raw:
    # el p95 reaparece solo en la pasada nocturna/repuesta
    op.add_column('agg_1min', sa.Column('p95_ms', sa.Float(), nullable=True))
    op.add_column('agg_1h', sa.Column('p95_ms', sa.Float(), nullable=True))
    op.add_column('agg_1d', sa.Column('p95_ms', sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column('agg_1d', 'p95_ms')
    op.drop_column('agg_1h', 'p95_ms')
    op.drop_column('agg_1min', 'p95_ms')
