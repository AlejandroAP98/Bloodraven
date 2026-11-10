import httpx

from app.config import get_settings


async def notificar_telegram(mensaje: str) -> None:
    s = get_settings()
    if not s.telegram_bot_token or not s.telegram_chat_id:
        return
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(
                f"https://api.telegram.org/bot{s.telegram_bot_token}/sendMessage",
                json={
                    "chat_id": s.telegram_chat_id,
                    "text": mensaje,
                    "parse_mode": "HTML",
                },
            )
        except httpx.HTTPError:
            pass


async def notificar_webhook(mensaje: str, datos: dict | None = None) -> None:
    s = get_settings()
    if not s.webhook_url:
        return
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(s.webhook_url, json={"texto": mensaje, **(datos or {})})
        except httpx.HTTPError:
            pass


# canal unificado: telegram + webhook genérico
async def notificar(mensaje: str, datos: dict | None = None) -> None:
    await notificar_telegram(mensaje)
    await notificar_webhook(mensaje, datos)
