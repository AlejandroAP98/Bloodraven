"""chequeos multiproto y reglas

Revision ID: a1c3d5e7f901
Revises: 592d1dd66ff2
Create Date: 2026-10-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision: str = 'a1c3d5e7f901'
down_revision: Union[str, None] = '592d1dd66ff2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('dispositivos', sa.Column('tipo', sa.String(10), nullable=False, server_default="'icmp'"))
    op.add_column('dispositivos', sa.Column('puerto', sa.Integer(), nullable=True))
    op.add_column('dispositivos', sa.Column('texto_buscado', sa.String(200), nullable=True))
    op.add_column('dispositivos', sa.Column('dns_servidor', sa.String(100), nullable=True))
    op.add_column('dispositivos', sa.Column('silencio_hasta', sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        'reglas_alerta',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('device_id', UUID(as_uuid=True), sa.ForeignKey('dispositivos.id', ondelete='CASCADE'), nullable=False),
        sa.Column('tipo', sa.String(20), nullable=False),
        sa.Column('umbral', sa.Float(), nullable=False),
        sa.Column('ventana_min', sa.Integer(), nullable=False, server_default='5'),
        sa.Column('activo', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.UniqueConstraint('device_id', 'tipo', name='uq_regla_device_tipo'),
    )

    op.create_table(
        'cambios_ruta',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('device_id', UUID(as_uuid=True), sa.ForeignKey('dispositivos.id', ondelete='CASCADE'), nullable=False),
        sa.Column('ts', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('resumen', sa.String(255), nullable=False),
        sa.Column('hops', JSONB(), nullable=True),
    )
    op.create_index('idx_cambios_ruta_device_ts', 'cambios_ruta', ['device_id', 'ts'])


def downgrade() -> None:
    op.drop_index('idx_cambios_ruta_device_ts', table_name='cambios_ruta')
    op.drop_table('cambios_ruta')
    op.drop_table('reglas_alerta')
    op.drop_column('dispositivos', 'silencio_hasta')
    op.drop_column('dispositivos', 'dns_servidor')
    op.drop_column('dispositivos', 'texto_buscado')
    op.drop_column('dispositivos', 'puerto')
    op.drop_column('dispositivos', 'tipo')
