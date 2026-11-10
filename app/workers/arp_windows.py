"""Tabla ARP de Windows vía GetIpNetTable (iphlpapi): evidencia de hosts
presentes en la subred aunque el ICMP esté bloqueado por su firewall.
No requiere permisos de admin (mismo enfoque que icmp_windows.py)."""

import asyncio
import ctypes
import ctypes.wintypes as wt
import socket
import struct

MAXLEN_PHYSADDR = 8

TIPO_ARP = {1: "otro", 2: "invalida", 3: "dinamica", 4: "estatica"}


class _MIB_IPNETROW(ctypes.Structure):
    _fields_ = [
        ("dwIndex", wt.DWORD),
        ("dwPhysAddrLen", wt.DWORD),
        ("bPhysAddr", ctypes.c_ubyte * MAXLEN_PHYSADDR),
        ("dwAddr", wt.DWORD),
        ("dwType", wt.DWORD),
    ]


_arp = ctypes.windll.iphlpapi
_arp.GetIpNetTable.restype = wt.ULONG
_arp.GetIpNetTable.argtypes = [ctypes.c_void_p, ctypes.POINTER(wt.ULONG), wt.BOOL]


def _tabla_arp_sync() -> dict[str, str]:
    """Devuelve {ip: tipo} de las entradas ARP vigentes ('dinamica'/'estatica'/'otro')."""
    n = wt.ULONG(0)
    # primera llamada solo para pedir el tamaño del buffer (ERROR_INSUFFICIENT_BUFFER)
    if _arp.GetIpNetTable(None, ctypes.byref(n), True) != 122:
        return {}
    buf = (ctypes.c_ubyte * n.value)()
    if _arp.GetIpNetTable(buf, ctypes.byref(n), True) != 0:
        return {}
    total = wt.ULONG.from_buffer(buf, 0).value
    filas = (_MIB_IPNETROW * total).from_buffer(buf, ctypes.sizeof(wt.ULONG))
    out: dict[str, str] = {}
    for r in filas:
        if r.dwType == 2 or r.dwPhysAddrLen == 0:  # entrada invalida / sin mac
            continue
        ip = socket.inet_ntoa(struct.pack("<I", r.dwAddr))
        out[ip] = TIPO_ARP.get(r.dwType, "otro")
    return out


async def tabla_arp() -> dict[str, str]:
    """{ip: tipo_de_entrada} de la tabla ARP; {} si falla (no es crítico)."""
    try:
        return await asyncio.get_running_loop().run_in_executor(None, _tabla_arp_sync)
    except Exception:
        return {}
