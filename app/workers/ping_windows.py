import asyncio
import re
from datetime import datetime, timezone
from typing import Any


async def ping_host(host: str, timeout_ms: int) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        "ping",
        "-n",
        "1",
        "-w",
        str(timeout_ms),
        host,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_ms / 1000 + 3)
    except TimeoutError:
        proc.kill()
        return {"ok": False, "rtt_ms": None, "ts": datetime.now(timezone.utc)}

    salida = stdout.decode("cp850", errors="replace")
    if "TTL=" not in salida and "TTL " not in salida:
        return {"ok": False, "rtt_ms": None, "ts": datetime.now(timezone.utc)}

    m = re.search(r"[=<]\s?(\d+)ms", salida)
    rtt = int(m.group(1)) if m else None
    return {"ok": True, "rtt_ms": float(rtt) if rtt is not None else None, "ts": datetime.now(timezone.utc)}


async def ping_cmd_linea(host: str, timeout_ms: int) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        "ping", "-n", "1", "-w", str(timeout_ms), host,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_ms / 1000 + 3)
    except TimeoutError:
        proc.kill()
        return {"ok": False, "rtt_ms": None, "linea": "Tiempo de espera agotado para esta solicitud."}
    salida = stdout.decode("cp850", errors="replace")
    ttl = re.search(r"TTL[=:\s]+(\d+)", salida)
    m = re.search(r"[=<]\s?(\d+)ms", salida)
    if not ttl:
        if "host inaccesible" in salida.lower() or "unreachable" in salida.lower():
            return {"ok": False, "rtt_ms": None, "linea": "Host inaccesible."}
        return {"ok": False, "rtt_ms": None, "linea": "Tiempo de espera agotado para esta solicitud."}
    linea = f"Respuesta desde {host}: bytes=32 tiempo={int(m.group(1)) if m else 0}ms TTL={ttl.group(1)}"
    return {"ok": True, "rtt_ms": float(m.group(1)) if m else None, "linea": linea}
