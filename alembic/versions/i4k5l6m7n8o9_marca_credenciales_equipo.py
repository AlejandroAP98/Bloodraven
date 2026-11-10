"""credenciales de equipos: marca detectada (mikrotik | ubiquiti aireOS)

El acceso a equipos deja de ser exclusivo de MikroTik: al guardar una
credencial se valida contra el equipo por RouterOS (REST/API) o por SSH
(airMAX/aireOS) y se fija la marca para despachar futuras fichas/acciones.

Revision ID: i4k5l6m7n8o9
Revises: h3j4k5l6m7n8
Create Date: 2026-11-10 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'i4k5l6m7n8o9'
down_revision: Union[str, None] = 'h3j4k5l6m7n8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('credenciales_equipo', sa.Column('marca', sa.String(20), nullable=True))


def downgrade() -> None:
    op.drop_column('credenciales_equipo', 'marca')
