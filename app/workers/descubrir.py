import asyncio
import ipaddress

from app.config import get_settings
from app.workers.icmp_windows import _executor, ping_sync


def _orden_ip(ip: str) -> tuple[int, int, int, int]:
    p = ip.split(".")
    return tuple(int(x) for x in p) if len(p) == 4 else (0, 0, 0, 999)


async def descubrir_red(
    cidr: str, timeout_ms: int = 700, max_hosts: int = 1024
) -> dict[str, object]:
    """Barrido ICMP de una subred: devuelve los hosts escaneados, los que
    responden (con rtt) y el mapa {ip: rtt} de los éxitos."""
    red = ipaddress.ip_network(cidr, strict=False)
    hosts = [str(h) for h in red.hosts()][:max_hosts]
    if not hosts:
        return {"vivos": [], "todos": [], "rtt_ms": {}}

    sem = asyncio.Semaphore(get_settings().max_pings_concurrentes)

    async def _uno(ip: str) -> tuple[str, float | None]:
        try:
            async with sem:
                rtt = await asyncio.get_running_loop().run_in_executor(
                    _executor(), ping_sync, ip, timeout_ms
                )
        except Exception:
            return ip, None
        return ip, rtt

    res = await asyncio.gather(*[_uno(h) for h in hosts])
    rtts = {ip: rtt for ip, rtt in res if rtt is not None}
    vivos = [
        {"ip": ip, "rtt_ms": round(rtt, 1)}
        for ip, rtt in sorted(rtts.items(), key=lambda x: _orden_ip(x[0]))
    ]
    return {"vivos": vivos, "todos": hosts, "rtt_ms": rtts}


async def reverificar(
    ips: list[str], timeout_ms: int = 1500, max_conc: int = 32
) -> set[str]:
    """Re-ping con timeout largo de IPs que no respondieron al barrido:
    evita declarar libre una ip ocupada que tarda en contestar."""
    if not ips:
        return set()

    sem = asyncio.Semaphore(max_conc)

    async def _uno(ip: str) -> str | None:
        try:
            async with sem:
                rtt = await asyncio.get_running_loop().run_in_executor(
                    _executor(), ping_sync, ip, timeout_ms
                )
        except Exception:
            return None
        return ip if rtt is not None else None

    res = await asyncio.gather(*[_uno(ip) for ip in ips])
    return {ip for ip in res if ip}
