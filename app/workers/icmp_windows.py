import asyncio
import ctypes
import ctypes.wintypes as wt
import functools
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

icmp = ctypes.windll.iphlpapi

_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()


def _executor() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ThreadPoolExecutor(max_workers=64, thread_name_prefix="icmp")
    return _pool


class _IP_OPTION_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Ttl", ctypes.c_ubyte),
        ("Tos", ctypes.c_ubyte),
        ("Flags", ctypes.c_ubyte),
        ("OptionsSize", ctypes.c_ubyte),
        ("OptionsData", ctypes.c_void_p),
    ]


class _ICMP_ECHO_REPLY(ctypes.Structure):
    _fields_ = [
        ("Address", ctypes.c_ulong),
        ("Status", ctypes.c_ulong),
        ("RoundTripTime", ctypes.c_ulong),
        ("DataSize", ctypes.c_ushort),
        ("Reserved", ctypes.c_ushort),
        ("Data", ctypes.c_void_p),
        ("Options", _IP_OPTION_INFORMATION),
    ]


IP_SUCCESS = 0
IP_REQ_TIMED_OUT = 11010

icmp.IcmpCreateFile.restype = wt.HANDLE
icmp.IcmpCloseHandle.argtypes = [wt.HANDLE]
icmp.IcmpSendEcho.argtypes = [
    wt.HANDLE,
    ctypes.c_ulong,
    ctypes.c_void_p,
    ctypes.c_ushort,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_ulong,
    ctypes.c_ulong,
]

_local = threading.local()

REPLY_EXTRA = 512


def _handle():
    h = getattr(_local, "icmp_h", None)
    if h is None:
        h = icmp.IcmpCreateFile()
        _local.icmp_h = h
    return h


@functools.lru_cache(maxsize=4096)
def _ip_int(host: str) -> int:
    addr = socket.gethostbyname(host)
    return int.from_bytes(socket.inet_aton(addr), "little")


def _ping_sync(handle: Any, ip: int, timeout_ms: int) -> float | None:
    ping_payload = b"bloodraven-ping"
    payload = ctypes.create_string_buffer(ping_payload, len(ping_payload) + 1)
    buffer = (ctypes.c_char * (ctypes.sizeof(_ICMP_ECHO_REPLY) + REPLY_EXTRA))()
    res = icmp.IcmpSendEcho(
        handle, ip, payload, len(ping_payload), None, buffer, ctypes.sizeof(buffer), timeout_ms
    )
    if res == 0:
        return None
    reply = _ICMP_ECHO_REPLY.from_buffer(buffer)
    if reply.Status != IP_SUCCESS:
        return None
    return float(reply.RoundTripTime)


def ping_sync(host: str, timeout_ms: int) -> float | None:
    """RTT en ms o None si no responde. Sin permisos admin (iphlpapi)."""
    return _ping_sync(_handle(), _ip_int(host), timeout_ms)


async def ping_async(
    host: str, timeout_ms: int, sem: asyncio.Semaphore | None = None
) -> dict[str, Any]:
    """ICMP desde un executor; semaforo opcional para limitar concurrencia."""
    from datetime import datetime, timezone

    if sem is not None:
        async with sem:
            rtt = await asyncio.get_running_loop().run_in_executor(
                _executor(), ping_sync, host, timeout_ms
            )
    else:
        rtt = await asyncio.get_running_loop().run_in_executor(
            _executor(), ping_sync, host, timeout_ms
        )
    return {"ok": rtt is not None, "rtt_ms": rtt, "ts": datetime.now(timezone.utc)}
