"""Topología de la red inferida de las rutas observadas por Bloodraven.

Agrupa los hop_samples por (device, ts) igual que el diagnóstico de ruta,
construye adyacencias (ip del ttl n-1 → ip del ttl n dentro DEL MISMO
escaneo) y las agrega: cada arista sabe cuántos escaneos y dispositivos la
avistaron y el delta promedio de latencia del tramo. Asigna capas por BFS
desde el gateway más común para que el frontend solo dibuje.
"""

import ipaddress
from collections import Counter, defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Dispositivo, EquipoRed, HopSample

router = APIRouter(prefix="/api/topologia", tags=["topologia"])


def _tz(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def cmp_ip(a: str, b: str) -> int:
    oa, ob = a.split("."), b.split(".")
    for i in range(4):
        x, y = int(oa[i] or 0), int(ob[i] or 0)
        if x != y:
            return x - y
    return (a > b) - (a < b)


async def get_db() -> AsyncSession:
    from app.database import SesionLocal

    async with SesionLocal() as sesion:
        yield sesion


@router.get("")
async def get_topologia(
    horas: float = Query(default=24, gt=0, le=24),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Grafo de la red: nodos (IPs avistadas en las rutas) y aristas
    (tramos consecutivos del mismo escaneo), con identidad del catálogo."""
    desde = _tz(datetime.now(timezone.utc)) - timedelta(hours=horas)
    res = await db.execute(
        select(HopSample.device_id, HopSample.ts, HopSample.ttl, HopSample.ip, HopSample.rtt_ms, HopSample.ok)
        .where(HopSample.ts >= desde)
        .order_by(HopSample.device_id, HopSample.ts, HopSample.ttl)
    )
    filas = res.all()

    resd = await db.execute(select(Dispositivo))
    dispositivos = {str(d.id): d for d in resd.scalars().all()}

    # escaneos del mismo ciclo comparten ts: agrupa (device, ts) -> ttl -> salto
    scans: dict[tuple[str, datetime], dict[int, dict[str, Any]]] = defaultdict(dict)
    for device_id, ts, ttl, ip, rtt, ok in filas:
        key = (str(device_id), _tz(ts))
        previo = scans[key]
        ma = previo.get(int(ttl))
        if ma and ma["ip"]:
            continue  # dentro del mismo escaneo ya hay respuesta en este ttl
        previo[int(ttl)] = {
            "ip": str(ip).lower() if ip else None,
            "rtt": float(rtt) if rtt is not None else None,
            "ok": bool(ok),
        }

    nodos: dict[str, dict[str, Any]] = {}
    aristas: dict[tuple[str, str], dict[str, Any]] = {}
    primer_hops: Counter[str] = Counter()  # ip del ttl=1 de cada escaneo (para la raíz)

    def touch(ip: str) -> dict[str, Any]:
        return nodos.setdefault(
            ip, {"vistos": 0, "dispositivos": set(), "rtts": [], "primera": None, "ultima": None}
        )

    for (device_id, ts), scan in scans.items():
        if device_id not in dispositivos:
            continue  # dispositivo borrado: su historial ya no interesa
        vivos = sorted((ttl, h) for ttl, h in scan.items() if h["ip"])
        if vivos:
            primer_hops[vivos[0][1]["ip"]] += 1
        de: str | None = None
        rtt_de: float | None = None
        for i, (_ttl, h) in enumerate(vivos):
            ip_a = h["ip"]
            n = touch(ip_a)
            n["vistos"] += 1
            n["dispositivos"].add(device_id)
            n["primera"] = ts if n["primera"] is None else min(n["primera"], ts)
            n["ultima"] = ts if n["ultima"] is None else max(n["ultima"], ts)
            if h["rtt"] is not None:
                n["rtts"].append(h["rtt"])
            if de is not None and ip_a != de:
                e = aristas.setdefault(
                    (de, ip_a),
                    {"n_scans": 0, "dispositivos": set(), "deltas": [], "ultima": None},
                )
                e["n_scans"] += 1
                e["dispositivos"].add(device_id)
                e["ultima"] = ts if e["ultima"] is None else max(e["ultima"], ts)
                if rtt_de is not None and h["rtt"] is not None:
                    d_ = h["rtt"] - rtt_de
                    if 0 <= d_ < 500:  # descarta outliers de la ruta
                        e["deltas"].append(d_)
            de, rtt_de = ip_a, h["rtt"]

    if not nodos:
        return {"horas": horas, "n_scans": len(scans), "raiz": None, "nodos": [], "aristas": []}

    rescat = await db.execute(select(EquipoRed))
    cat = {e.ip.lower(): e for e in rescat.scalars().all()}

    # dispositivo cuya IP monitoreada corresponde a una ip del grafo (objetivo)
    destino_de: dict[str, tuple[str, str]] = {}
    for d in dispositivos.values():
        try:
            host_ip = str(ipaddress.ip_address((d.host or "").strip()))
        except ValueError:
            continue
        if host_ip.lower() in nodos:
            destino_de[host_ip.lower()] = (str(d.id), d.nombre)

    # raíz: gateway modal — la ip que aparece como primer salto (ttl=1)
    # en más escaneos; sin escaneos válidos, cae a la de más aristas entrantes
    if primer_hops:
        raiz = primer_hops.most_common(1)[0][0]
    else:
        entradas: Counter[str] = Counter()
        for (_de, a), v in aristas.items():
            entradas[a] += v["n_scans"]
        raiz = entradas.most_common(1)[0][0] if entradas else sorted(nodos, key=cmp_ip)[0]

    # capas por BFS desde la raíz
    hijos: dict[str, list[str]] = defaultdict(list)
    for de, a in sorted(aristas, key=lambda k: (cmp_ip(k[0], k[1]), cmp_ip(k[1], k[0]))):
        if a not in hijos[de]:
            hijos[de].append(a)
    rango: dict[str, int] = {raiz: 0}
    cola: deque[str] = deque([raiz])
    while cola:
        u = cola.popleft()
        for v in hijos[u]:
            if v not in rango:
                rango[v] = rango[u] + 1
                cola.append(v)
    max_r = max(rango.values(), default=0)
    for ip in nodos:  # islas: sin camino conectado desde la raíz
        if ip not in rango:
            rango[ip] = max_r + 1

    lista_nodos = []
    for ip, n in nodos.items():
        ent = cat.get(ip)
        dest = destino_de.get(ip)
        lista_nodos.append(
            {
                "ip": ip,
                "nombre": ent.nombre if ent else (dest[1] if dest else None),
                "rol": ent.rol if ent else None,
                "catalogado": ent is not None,
                "monitoreado": dest[0] if dest else None,
                "rango": rango[ip],
                "isla": rango[ip] > max_r,
                "vistos": n["vistos"],
                "dispositivos_n": len(n["dispositivos"]),
                "rtt_avg_ms": round(sum(n["rtts"]) / len(n["rtts"]), 1) if n["rtts"] else None,
                "primera": _tz(n["primera"]).isoformat() if n["primera"] else None,
                "ultima": _tz(n["ultima"]).isoformat() if n["ultima"] else None,
            }
        )
    lista_nodos.sort(key=lambda x: (x["rango"], tuple(int(o) for o in x["ip"].split("."))))

    rnd = {x["ip"]: x["rango"] for x in lista_nodos}
    lista_aristas = []
    for (de, a), v in aristas.items():
        lista_aristas.append(
            {
                "de": de,
                "a": a,
                "n_scans": v["n_scans"],
                "dispositivos_n": len(v["dispositivos"]),
                "delta_avg_ms": round(sum(v["deltas"]) / len(v["deltas"]), 1) if v["deltas"] else None,
                "ultima": _tz(v["ultima"]).isoformat() if v["ultima"] else None,
                "de_rango": rnd.get(de, 99),
                "a_rango": rnd.get(a, 99),
                "subida": rnd.get(a, 99) <= rnd.get(de, 99),  # regreso / loop
            }
        )
    lista_aristas.sort(key=lambda x: (x["de_rango"], cmp_ip(x["de"], x["a"]), cmp_ip(x["a"], x["de"])))

    return {
        "horas": horas,
        "n_scans": len(scans),
        "raiz": raiz,
        "nodos": lista_nodos,
        "aristas": lista_aristas,
    }
