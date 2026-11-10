"""Pruebas rápidas ad-hoc: ping y traceroute a una IP/host dado el usuario.

No toca la BD ni crea dispositivos: es una herramienta de diagnóstico puntual
(subproceso ping/tracert de Windows, igual que usa la vigilancia).
"""

from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/api/prueba", tags=["prueba"])


def _valida(host: str) -> str:
    h = (host or "").strip()
    if not h:
        raise HTTPException(400, "Indica una IP o host")
    if len(h) > 255 or any(c in h for c in "<>|&\"'"):
        raise HTTPException(400, "Host inválido")
    return h


@router.get("/ping")
async def ping(host: str = Query(min_length=1, max_length=255)) -> dict[str, object]:
    """Un ping único (devuelve la línea tal cual la de la consola de un nodo)."""
    from app.config import get_settings
    from app.workers.ping_windows import ping_cmd_linea

    h = _valida(host)
    s = get_settings()
    r = await ping_cmd_linea(h, s.ping_timeout_ms)
    return {
        "host": h,
        "ok": bool(r.get("ok")),
        "rtt_ms": r.get("rtt_ms"),
        "linea": r.get("linea") or "Sin respuesta.",
    }


@router.get("/ruta")
async def ruta(host: str = Query(min_length=1, max_length=255)) -> dict[str, object]:
    """Traceroute puntual al host (los hops en vivo, sin historial)."""
    import asyncio

    from app.workers.traceroute_windows import traceroute_host

    h = _valida(host)
    # el tracert puede tardar ~1 min si el destino está caído: presupuesto duro
    hops = await asyncio.wait_for(
        traceroute_host(h, timeout_ms=800, max_hops=15), timeout=90
    )
    return {"host": h, "hops": hops}
