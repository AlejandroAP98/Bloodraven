import asyncio
import random
import socket
import struct
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.workers.icmp_windows import ping_async

# cliente http compartido entre chequeos: conserva conexiones y pool TLS —
# antes se negociaba una conexión nueva (y TLS de cero) en cada ping http
_http_cli: httpx.AsyncClient | None = None


def http_cliente() -> httpx.AsyncClient:
    global _http_cli
    if _http_cli is None:
        _http_cli = httpx.AsyncClient(follow_redirects=True)
    return _http_cli


async def cerrar_http() -> None:
    """Cierra el cliente compartido: llamar al apagar la app (lifespan)."""
    global _http_cli
    if _http_cli is not None:
        await _http_cli.aclose()
        _http_cli = None


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def host_para_tracert(host: str) -> str:
    """Limpia lo especifico de un chequeo http para poder trazar la ruta."""
    limpio = host
    if "://" in limpio:
        limpio = limpio.split("://", 1)[1]
    return limpio.split("/", 1)[0]


async def chequeo_tcp(
    host: str, puerto: int, timeout_ms: int, sem: asyncio.Semaphore | None = None
) -> dict[str, Any]:
    """Apriete de mano TCP: puerto abierto y latencia de conexión."""

    async def _abrir() -> Any:
        return await asyncio.wait_for(
            asyncio.open_connection(host, puerto), timeout=timeout_ms / 1000
        )

    inicio = time.monotonic()
    try:
        if sem is not None:
            async with sem:
                _, writer = await _abrir()
        else:
            _, writer = await _abrir()
        rtt = (time.monotonic() - inicio) * 1000
        writer.close()
        return {"ok": True, "rtt_ms": rtt, "ts": _ahora()}
    except (OSError, TimeoutError):
        return {"ok": False, "rtt_ms": None, "ts": _ahora()}


def _url_de(host: str, puerto: int | None) -> str:
    """URL de chequeo: host con http(s):// pasa tal cual (+puerto si falta), sin esquema → http://."""
    if "://" in host:
        partes = urlsplit(host)
        if puerto and partes.port is None:
            net = partes.netloc
            resto = ""
            # única adición al final del netloc limpio (la ruta queda separada)
            corte = host.find("/", host.find("://") + 3)
            if corte == -1:
                return f"{host}:{puerto}"
            return f"{host[:corte]}:{puerto}{host[corte:]}" if net else host
        return host
    base = f"http://{host}"
    if puerto:
        base += f":{puerto}"
    return base


async def chequeo_http(
    host: str,
    puerto: int | None,
    texto_buscado: str | None,
    timeout_ms: int,
    sem: asyncio.Semaphore | None = None,
) -> dict[str, Any]:
    """GET http(s): ok con 2xx-3xx y, opcionalmente, si el cuerpo contiene el texto."""
    base = _url_de(host, puerto)
    if base.startswith("http://") and puerto == 443:
        base = "https://" + base[len("http://") :]
    try:
        async def _get() -> Any:
            # el timeout es por petición: el cliente vive compartido
            r = await http_cliente().get(base, timeout=timeout_ms / 1000)
            return r, r.text

        if sem is not None:
            async with sem:
                r, cuerpo = await _get()
        else:
            r, cuerpo = await _get()
        ok = 200 <= r.status_code < 400
        if ok and texto_buscado:
            ok = texto_buscado.casefold() in cuerpo.casefold()
        return {"ok": ok, "rtt_ms": r.elapsed.total_seconds() * 1000, "ts": _ahora()}
    except (httpx.HTTPError, OSError):
        return {"ok": False, "rtt_ms": None, "ts": _ahora()}

def _dns_consulta_sync(host: str, servidor: str, timeout_s: float) -> bool:
    """Consulta A cruda por UDP al servidor dado: ok si RCODE=0 y hay respuesta."""
    tid = random.getrandbits(16)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in host.split(".") if p) + b"\x00"
    paquete = (
        struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)  # RD, QD=1
        + qname
        + struct.pack(">HH", 1, 1)  # QTYPE=A, QCLASS=IN
    )
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout_s)
    try:
        s.sendto(paquete, (servidor, 53))
        r = s.recv(1500)
        rcode = r[3] & 0x0F
        ancount = struct.unpack(">H", r[6:8])[0]
        return rcode == 0 and ancount > 0
    finally:
        s.close()


async def chequeo_dns(
    host: str, dns_servidor: str | None, timeout_ms: int, sem: asyncio.Semaphore | None = None
) -> dict[str, Any]:
    """Resolución del dominio: con servidor específico (UDP 53) o con el del sistema."""
    dominio = host_para_tracert(host)
    inicio = time.monotonic()

    async def _resolver() -> bool:
        if dns_servidor:
            return await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(
                    None, _dns_consulta_sync, dominio, dns_servidor, timeout_ms / 1000 + 0.5
                ),
                timeout=timeout_ms / 1000 + 1.0,
            )
        # resolv-edor del sistema
        return await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(
                None, lambda: bool(socket.getaddrinfo(dominio, None))
            ),
            timeout=timeout_ms / 1000,
        )

    try:
        if sem is not None:
            async with sem:
                ok = await _resolver()
        else:
            ok = await _resolver()
        rtt = (time.monotonic() - inicio) * 1000
        return {"ok": ok, "rtt_ms": rtt if ok else None, "ts": _ahora()}
    except (OSError, TimeoutError):
        return {"ok": False, "rtt_ms": None, "ts": _ahora()}


async def ejecutar_chequeo(
    host: str,
    tipo: str,
    timeout_ms: int,
    sem: asyncio.Semaphore | None = None,
    puerto: int | None = None,
    texto_buscado: str | None = None,
    dns_servidor: str | None = None,
) -> dict[str, Any]:
    """Despachador único: mismo contrato {ok, rtt_ms, ts} que el ping ICMP."""
    if tipo == "tcp":
        return await chequeo_tcp(host, puerto or 80, timeout_ms, sem)
    if tipo == "http":
        return await chequeo_http(host, puerto, texto_buscado, timeout_ms, sem)
    if tipo == "dns":
        return await chequeo_dns(host, dns_servidor, timeout_ms, sem)
    return await ping_async(host, timeout_ms, sem)
