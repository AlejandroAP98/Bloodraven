"""módulo acciones: credenciales de equipos + auditoría de acciones

Revision ID: h3j4k5l6m7n8
Revises: g6f7a8b9c0d1
Create Date: 2026-11-09 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = 'h3j4k5l6m7n8'
down_revision: Union[str, None] = 'g6f7a8b9c0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'credenciales_equipo',
        sa.Column('ip', sa.String(45), primary_key=True),
        sa.Column('usuario', sa.String(100), nullable=False),
        sa.Column('password_cifrada', sa.String(255), nullable=False),
        sa.Column('actualizado_en', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
    )
    op.create_table(
        'acciones_log',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('ts', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('ip', sa.String(45), nullable=False),
        sa.Column('accion', sa.String(30), nullable=False),
        sa.Column('parametros', JSONB, nullable=True),
        sa.Column('resultado', sa.String(255), nullable=True),
        sa.Column('ok', sa.Boolean(), nullable=False, server_default=sa.text('true')),
    )
    op.create_index('idx_acciones_ip_ts', 'acciones_log', ['ip', 'ts'])


def downgrade() -> None:
    op.drop_index('idx_acciones_ip_ts', table_name='acciones_log')
    op.drop_table('acciones_log')
    op.drop_table('credenciales_equipo')
