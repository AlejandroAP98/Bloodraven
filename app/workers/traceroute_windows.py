import asyncio
import re
from datetime import datetime, timezone
from typing import Any

IP_RE = re.compile(r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})")


def _parsear_tracert(salida: str, max_hops: int) -> list[dict[str, Any]]:
    hops: list[dict[str, Any]] = []
    for linea in salida.splitlines():
        linea = linea.strip()
        m = re.match(r"^\s*(\d+)\s+(\S.*)$", linea)
        if not m:
            continue
        ttl = int(m.group(1))
        if ttl > max_hops:
            break
        resto = m.group(2)
        ips = IP_RE.findall(resto)
        rtts = re.findall(r"[<>]?\s?(\d+)\s*ms", resto)
        timeout_line = "excedido" in resto.lower() or "*" in resto

        hop: dict[str, Any] = {"ttl": ttl, "ip": None, "hostname": None, "rtt_ms": None, "ok": False}
        if ips:
            hop["ip"] = ips[-1]
            host_match = re.match(r"^([^\[\s]+)\s*\[", resto.split("ms")[-1] if "ms" in resto else resto)
            es_timeout = len(rtts) == 0 and "*" in resto
            hop["ok"] = not es_timeout
            if hop["ok"] and rtts:
                valores = [int(v) for v in rtts]
                hop["rtt_ms"] = float(sum(valores) / len(valores))
        elif timeout_line:
            hop["ok"] = False
        hops.append(hop)
    return hops


async def traceroute_host(
    host: str, timeout_ms: int = 800, max_hops: int = 15, max_intentos: int = 1
) -> list[dict[str, Any]]:
    proc = await asyncio.create_subprocess_exec(
        "tracert",
        "-d",
        "-w",
        str(timeout_ms),
        "-h",
        str(max_hops),
        "-4",
        host,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(),
            timeout=max_hops * (timeout_ms / 1000 + 0.5) + 15,
        )
    except TimeoutError:
        proc.kill()
        return [{"ttl": 0, "ip": None, "hostname": None, "rtt_ms": None, "ok": False, "error": "timeout probe"}]

    salida = stdout.decode("cp850", errors="replace")
    return _parsear_tracert(salida, max_hops)


def asociar_hostnames(hops: list[dict[str, Any]], host_cache: dict[str, str | None]) -> None:
    for h in hops:
        ip = h.get("ip")
        if ip:
            h["hostname"] = host_cache.get(ip)
