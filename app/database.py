import re
from typing import Any

from sqlalchemy.ext.asyncio import (
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()

_engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=5)


def get_engine() -> Any:
    return _engine


SesionLocal = async_sessionmaker(_engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def extraer_db_url_sync() -> str:
    url = settings.database_url.replace("+asyncpg", "+psycopg2")
    return url
