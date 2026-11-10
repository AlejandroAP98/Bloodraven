"""catálogo editable equipos_red

Revision ID: c3d84e91f7a2
Revises: a1c3d5e7f901
Create Date: 2026-11-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = 'c3d84e91f7a2'
down_revision: Union[str, None] = 'a1c3d5e7f901'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'equipos_red',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('ip', sa.String(45), nullable=False, unique=True),
        sa.Column('nombre', sa.String(100), nullable=False),
        sa.Column('rol', sa.String(30), nullable=False, server_default="'otro'"),
        sa.Column('notas', sa.String(255), nullable=True),
        sa.Column('actualizado_en', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
    )


def downgrade() -> None:
    op.drop_table('equipos_red')
