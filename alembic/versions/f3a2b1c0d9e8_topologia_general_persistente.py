"""topologia general persistent: grafo guardado

Revision ID: f3a2b1c0d9e8
Revises: d8e1f2a3b4c5
Create Date: 2026-11-08 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = 'f3a2b1c0d9e8'
down_revision: Union[str, None] = 'd8e1f2a3b4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'topologia_nodos',
        sa.Column('ip', sa.String(45), primary_key=True),
        sa.Column('nombre', sa.String(100), nullable=True),
        sa.Column('rol', sa.String(60), nullable=True),
        sa.Column('vistos', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('rtt_avg_ms', sa.Float(), nullable=True),
        sa.Column('primera', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ultima', sa.DateTime(timezone=True), nullable=True),
        sa.Column('dispositivos', JSONB(), nullable=False, server_default='[]'),
    )
    op.create_table(
        'topologia_aristas',
        sa.Column('de', sa.String(45), primary_key=True),
        sa.Column('a', sa.String(45), primary_key=True),
        sa.Column('n_scans', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('dispositivos_n', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('delta_avg_ms', sa.Float(), nullable=True),
        sa.Column('primera', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ultima', sa.DateTime(timezone=True), nullable=True),
        sa.Column('dispositivos', JSONB(), nullable=False, server_default='[]'),
    )


def downgrade() -> None:
    op.drop_table('topologia_aristas')
    op.drop_table('topologia_nodos')
