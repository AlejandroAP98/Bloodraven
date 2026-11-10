"""topologia general: registro persistente de dispositivos

Revision ID: g6f7a8b9c0d1
Revises: f3a2b1c0d9e8
Create Date: 2026-11-08 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = 'g6f7a8b9c0d1'
down_revision: Union[str, None] = 'f3a2b1c0d9e8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('topologia_nodos', sa.Column('device_id', UUID(as_uuid=True), nullable=True))
    op.add_column('topologia_nodos', sa.Column('host', sa.String(255), nullable=True))
    op.add_column(
        'topologia_nodos',
        sa.Column('alta', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('topologia_nodos', 'alta')
    op.drop_column('topologia_nodos', 'host')
    op.drop_column('topologia_nodos', 'device_id')
