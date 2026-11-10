from logging.config import fileConfig
from typing import Any
import asyncio

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.database import Base, get_engine
from app.models import Dispositivo, HopHost, HopSample, MuestraPing, Outage  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=get_engine().url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    asyncio.run(_async_migrar())


async def _async_migrar() -> None:
    import asyncio

    connectable = get_engine()
    async with connectable.connect() as connection:
        await connection.run_sync(_migrar_sync)
    await connectable.dispose()


def _migrar_sync(connection: Any) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
