from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_name: str = "Bloodraven"
    database_url: str = "postgresql+asyncpg://redmon:redmon@localhost:5432/redmon"
    host: str = "127.0.0.1"
    port: int = 8080

    ping_timeout_ms: int = 1000
    max_pings_concurrentes: int = 50
    max_tracerts_concurrentes: int = 4
    hop_scan_interval_min: int = 10
    n_fallos_down: int = 3
    n_muestras_degradado: int = 4

    retencion_raw_dias: int = 30
    retencion_1min_dias: int = 180
    consolidador_hora: int = 3
    bandeja: bool = True

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    webhook_url: str = ""

    # clave Fernet para cifrar credenciales de equipos (opcional: si no está,
    # se genera y guarda en credencial_clave.key fuera de git)
    credencial_clave: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
