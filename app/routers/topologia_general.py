"""Topología general PERSISTENTE — registro incremental de la red.

La intención del mapa: IR REGISTRANDO POCO A POCO TODA LA TOPOLOGÍA de la
red. Lo que entra, queda:

- Cada dispositivo añadido (Dispositivo.en_topologia) se REGISTRA como nodo
  en `topologia_nodos` con su identidad (name/host/alta). Permanece aunque
  deje de observarse, se desmarque o luego sea eliminado del monitoreo (si
  el dispositivo ya no existe en el sistema, su nombre/host quedan
  congelados como se registraron).
- Los nodos y aristas avistados por traceroute de los dispositivos incluidos
  también se almacenan y NO se retiran nunca automáticamente: solo salen
  por acción manual (quitar nodo del dispositivo o "reasentar").

Por cada consulta:
1. GRAFO FRESCO: escaneos de la ventana `horas` para los dispositivos
   marcados; sus números actualizan lo persistido.
2. REGISTRO: se asegura la entrada de cada dispositivo marcado y se fusiona
   el grafo fresco con el guardado (union de propietarios históricos).
3. VISTA: BFS sobre el grafo COMPLETO persistido; lo sin escaneos recientes
   sale marcado `inactiva` para que el frontend lo dibuje atenuado.

`POST /reasentar` borra lo guardado y lo rehace con la selección actual.
"""

import ipaddress
import uuid
from collections import Counter, defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Dispositivo, EquipoRed, HopSample, TopoAristaGuardada, TopoNodoGuardado

router = APIRouter(prefix="/api/topologia_general", tags=["topologia"])


def _tz(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _oct(a: str) -> tuple:
    # octetos ordenables; entradas no-ip (raro) caen al final sin romper
    p = a.split(".")
    if len(p) == 4:
        try:
            return (int(p[0]) or 0, int(p[1]) or 0, int(p[2]) or 0, int(p[3]) or 0, "")
        except ValueError:
            pass
    return (999, 999, 999, 999, a)


def cmp_ip(a: str, b: str) -> int:
    oa, ob = _oct(a), _oct(b)
    return (oa > ob) - (oa < ob)


async def get_db() -> AsyncSession:
    from app.database import SesionLocal

    async with SesionLocal() as sesion:
        yield sesion


async def _sincronizar(db: AsyncSession, horas: float) -> dict[str, Any]:
    """Fusiona el grafo fresco con el persistido y devuelve la vista completa."""
    desde = _tz(datetime.now(timezone.utc)) - timedelta(hours=horas)

    resd = await db.execute(select(Dispositivo).order_by(Dispositivo.nombre))
    todos = list(resd.scalars().all())
    vivos = {str(d.id): d for d in todos}
    seleccion = [
        {"id": str(d.id), "nombre": d.nombre, "host": d.host, "incluido": bool(d.en_topologia)}
        for d in todos
    ]
    # dispositivos marcados: únicos alimentadores del grafo fresco
    dispositivos = {str(d.id): d for d in todos if d.en_topologia}
    marcados = set(dispositivos)

    rescat = await db.execute(select(EquipoRed))
    cat = {e.ip.lower(): e for e in rescat.scalars().all()}

    # dispositivo VIVO cuya IP monitoreada cae en el mapa (etiqueta + identidad)
    destino_de: dict[str, tuple[str, str]] = {}
    for d in vivos.values():
        try:
            host_ip = str(ipaddress.ip_address((d.host or "").strip()))
        except ValueError:
            continue
        destino_de[host_ip.lower()] = (str(d.id), d.nombre)

    # ── 1. grafo fresco desde los hop_samples de los marcados ──
    nodos_f: dict[str, dict[str, Any]] = {}
    aristas_f: dict[tuple[str, str], dict[str, Any]] = {}
    primer_hops: Counter[str] = Counter()
    n_scans = 0

    if dispositivos:
        res = await db.execute(
            select(HopSample.device_id, HopSample.ts, HopSample.ttl, HopSample.ip, HopSample.rtt_ms, HopSample.ok)
            .where(HopSample.ts >= desde, HopSample.device_id.in_(marcados))
            .order_by(HopSample.device_id, HopSample.ts, HopSample.ttl)
        )
        filas = res.all()

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
        n_scans = len(scans)

        def touch(ip: str) -> dict[str, Any]:
            return nodos_f.setdefault(
                ip, {"vistos": 0, "rtts": [], "primera": None, "ultima": None, "dispositivos": set()}
            )

        for (device_id, ts), scan in scans.items():
            vivos_scan = sorted((ttl, h) for ttl, h in scan.items() if h["ip"])
            if vivos_scan:
                primer_hops[vivos_scan[0][1]["ip"]] += 1
            de: str | None = None
            rtt_de: float | None = None
            for i, (_ttl, h) in enumerate(vivos_scan):
                ip_a = h["ip"]
                n = touch(ip_a)
                n["vistos"] += 1
                n["dispositivos"].add(device_id)
                n["primera"] = ts if n["primera"] is None else min(n["primera"], ts)
                n["ultima"] = ts if n["ultima"] is None else max(n["ultima"], ts)
                if h["rtt"] is not None:
                    n["rtts"].append(h["rtt"])
                if de is not None and ip_a != de:
                    e = aristas_f.setdefault(
                        (de, ip_a),
                        {"n_scans": 0, "deltas": [], "primera": None, "ultima": None, "dispositivos": set()},
                    )
                    e["n_scans"] += 1
                    e["dispositivos"].add(device_id)
                    e["primera"] = ts if e["primera"] is None else min(e["primera"], ts)
                    e["ultima"] = ts if e["ultima"] is None else max(e["ultima"], ts)
                    if rtt_de is not None and h["rtt"] is not None:
                        d_ = h["rtt"] - rtt_de
                        if 0 <= d_ < 500:  # descarta outliers de la ruta
                            e["deltas"].append(d_)
                de, rtt_de = ip_a, h["rtt"]

    # ── 2. REGISTRO / fusión con el grafo persistido ──
    resng = await db.execute(select(TopoNodoGuardado))
    nodos_g = list(resng.scalars().all())
    # asyncpg devuelve device_id como UUID: normaliza a string para los cruces
    for g in nodos_g:
        if g.device_id and not isinstance(g.device_id, str):
            g.device_id = str(g.device_id)
    resag = await db.execute(select(TopoAristaGuardada))
    aristas_g = list(resag.scalars().all())

    # nodo persistente de cada dispositivo marcado: identidad congelable,
    # emparejada a su ip monitoreada. Si el host no es ip, aparece luego
    # cuando el traceroute lo aviste (aunque el marcaje identifica al nodo)
    for d in dispositivos.values():
        try:
            ip_dev = str(ipaddress.ip_address((d.host or "").strip())).lower()
        except ValueError:
            continue
        g = next((x for x in nodos_g if x.ip == ip_dev), None)
        if g is None:
            g = TopoNodoGuardado(
                ip=ip_dev,
                nombre=d.nombre,
                rol=None,
                device_id=d.id,
                host=d.host,
                dispositivos=[str(d.id)],
            )
            db.add(g)
            nodos_g.append(g)
        else:
            if not g.device_id:
                g.device_id = d.id
            ent = cat.get(ip_dev)
            g.nombre = ent.nombre if ent else d.nombre
            g.host = d.host or g.host
            if str(d.id) not in g.dispositivos:
                g.dispositivos = [*g.dispositivos, str(d.id)]

    for ip, f in nodos_f.items():
        ent = cat.get(ip)
        dest = destino_de.get(ip)
        g = next((x for x in nodos_g if x.ip == ip), None)
        if g is None:
            g = TopoNodoGuardado(
                ip=ip,
                nombre=ent.nombre if ent else (dest[1] if dest else None),
                rol=ent.rol if ent else None,
                vistos=f["vistos"],
                rtt_avg_ms=round(sum(f["rtts"]) / len(f["rtts"]), 1) if f["rtts"] else None,
                primera=f["primera"],
                ultima=f["ultima"],
                dispositivos=sorted(f["dispositivos"]),
            )
            db.add(g)
            nodos_g.append(g)
        else:
            if not (ent or g.device_id):
                g.nombre = dest[1] if dest else g.nombre
            g.vistos = f["vistos"]
            g.rtt_avg_ms = round(sum(f["rtts"]) / len(f["rtts"]), 1) if f["rtts"] else g.rtt_avg_ms
            g.ultima = max(g.ultima, f["ultima"]) if g.ultima else f["ultima"]
            g.dispositivos = sorted(set(g.dispositivos) | f["dispositivos"])

    for (de, a), f in aristas_f.items():
        g = next((x for x in aristas_g if x.de == de and x.a == a), None)
        if g is None:
            g = TopoAristaGuardada(
                de=de,
                a=a,
                n_scans=f["n_scans"],
                dispositivos_n=len(f["dispositivos"]),
                delta_avg_ms=round(sum(f["deltas"]) / len(f["deltas"]), 1) if f["deltas"] else None,
                primera=f["primera"],
                ultima=f["ultima"],
                dispositivos=sorted(f["dispositivos"]),
            )
            db.add(g)
            aristas_g.append(g)
        else:
            g.n_scans = f["n_scans"]
            g.dispositivos_n = len(f["dispositivos"])
            g.delta_avg_ms = round(sum(f["deltas"]) / len(f["deltas"]), 1) if f["deltas"] else g.delta_avg_ms
            g.ultima = max(g.ultima, f["ultima"]) if g.ultima else f["ultima"]
            g.dispositivos = sorted(set(g.dispositivos) | f["dispositivos"])

    await db.commit()  # lo integrado queda; nada se retira automáticamente

    # ── 3. vista completa: capas por BFS sobre el grafo COMPLETO guardado ──
    if not nodos_g:
        return {
            "horas": horas,
            "n_scans": n_scans,
            "raiz": None,
            "nodos": [],
            "aristas": [],
            "seleccion": seleccion,
        }

    ips_g = {g.ip for g in nodos_g}
    if primer_hops:
        raiz = primer_hops.most_common(1)[0][0]
        if raiz not in ips_g:  # gateway no registrado aún (solo salió en escaneos viejos)
            raiz = None
    else:
        raiz = None  # sin ttl=1 fresco: se decide abajo

    if raiz is None:
        # sin escaneos frescos: la raíz más verosímil es el gateway declarado
        # en el catálogo; si no hay, la de más entrada acumulada, y si no, la
        # ip más baja registrada
        gw_roles = ("gateway local", "router/agregador", "borde público")
        gw = None
        for rol in gw_roles:
            gw = next(
                (
                    g
                    for g in sorted(nodos_g, key=lambda x: _oct(x.ip))
                    if (cat.get(g.ip) is not None and cat[g.ip].rol == rol)
                ),
                None,
            )
            if gw is not None:
                break
        if gw is not None:
            raiz = gw.ip
        else:
            entradas: Counter[str] = Counter()
            for g in aristas_g:
                entradas[g.a] += g.n_scans
            nueva = entradas.most_common(1)[0][0] if entradas else sorted(ips_g, key=cmp_ip)[0]
            raiz = nueva if nueva in ips_g else sorted(ips_g, key=cmp_ip)[0]

    hijos: dict[str, list[str]] = defaultdict(list)
    for g in sorted(aristas_g, key=lambda x: (cmp_ip(x.de, x.a), cmp_ip(x.a, x.de))):
        if g.a not in hijos[g.de]:
            hijos[g.de].append(g.a)
    rango: dict[str, int] = {raiz: 0}
    cola: deque[str] = deque([raiz])
    while cola:
        u = cola.popleft()
        for v in hijos[u]:
            if v not in rango:
                rango[v] = rango[u] + 1
                cola.append(v)
    max_r = max(rango.values(), default=0)
    for g in nodos_g:  # islas: sin camino conectado desde la raíz
        if g.ip not in rango:
            rango[g.ip] = max_r + 1

    ips_f = set(nodos_f)

    lista_nodos = []
    for g in sorted(nodos_g, key=lambda x: (rango.get(x.ip, 99), _oct(x.ip))):
        ent = cat.get(g.ip)
        dest = destino_de.get(g.ip)
        dev = vivos.get(g.device_id) if g.device_id else None
        lista_nodos.append(
            {
                "ip": g.ip,
                "nombre": ent.nombre if ent else (dev.nombre if dev else g.nombre),
                "rol": ent.rol if ent else g.rol,
                "catalogado": ent is not None,
                "monitoreado": dest[0] if dest else None,
                "device_id": g.device_id,
                "host": dev.host if dev else g.host,
                "vigilado": dev is not None,  # el dispositivo registrado aún existe en el monitoreo
                "rango": rango.get(g.ip, max_r + 1),
                "isla": rango.get(g.ip, max_r + 1) > max_r,
                "vistos": g.vistos,
                "dispositivos_n": len(g.dispositivos),
                "rtt_avg_ms": g.rtt_avg_ms,
                "primera": _tz(g.primera).isoformat() if g.primera else None,
                "alta": _tz(g.alta).isoformat() if g.alta else None,
                "ultima": _tz(g.ultima).isoformat() if g.ultima else None,
                "inactiva": g.ip not in ips_f,  # sin escaneos recientes: persiste atenuado
            }
        )

    rnd = {x["ip"]: x["rango"] for x in lista_nodos}
    lista_aristas = []
    for g in sorted(
        aristas_g, key=lambda x: (rnd.get(x.de, 99), cmp_ip(x.de, x.a), cmp_ip(x.a, x.de))
    ):
        lista_aristas.append(
            {
                "de": g.de,
                "a": g.a,
                "n_scans": g.n_scans,
                "dispositivos_n": g.dispositivos_n,
                "delta_avg_ms": g.delta_avg_ms,
                "ultima": _tz(g.ultima).isoformat() if g.ultima else None,
                "de_rango": rnd.get(g.de, 99),
                "a_rango": rnd.get(g.a, 99),
                "subida": rnd.get(g.a, 99) <= rnd.get(g.de, 99),  # regreso / loop
                "inactiva": (g.de, g.a) not in aristas_f,
            }
        )

    return {
        "horas": horas,
        "n_scans": n_scans,
        "raiz": raiz,
        "nodos": lista_nodos,
        "aristas": lista_aristas,
        "seleccion": seleccion,
    }


@router.get("")
async def get_topologia_general(
    horas: float = Query(default=24, gt=0, le=24),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Grafo general PERSISTENTE: lo registrado permanece aunque los
    dispositivos dejen de observarse, se desmarquen o dejen de vigilarse."""
    return await _sincronizar(db, horas)


@router.delete("/nodos/{ip}")
async def quitar_nodo(
    ip: str, db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """Quita manualmente un nodo del mapa persistido (y los enlaces que toca
    su ip). Sirve sobre todo para entradas registradas cuyo dispositivo ya no
    existe en el monitoreo: la persistencia nunca las retira sola. Si el
    dispositivo asociado sigue vivo, se desmarcha para que no se re-registre."""
    res = await db.execute(select(TopoNodoGuardado).where(TopoNodoGuardado.ip == ip))
    g = res.scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Nodo no registrado en el mapa")
    if g.device_id:
        try:
            dev_id = g.device_id if isinstance(g.device_id, uuid.UUID) else uuid.UUID(str(g.device_id))
            dev = await db.get(Dispositivo, dev_id)
            if dev:
                dev.en_topologia = False
        except ValueError:
            pass
    await db.execute(delete(TopoAristaGuardada).where(TopoAristaGuardada.de == g.ip))
    await db.execute(delete(TopoAristaGuardada).where(TopoAristaGuardada.a == g.ip))
    await db.delete(g)
    await db.commit()
    return await _sincronizar(db, 24)


@router.post("/reasentar")
async def reasentar(
    horas: float = Query(default=24, gt=0, le=24),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Borra el grafo persistido y lo rehace únicamente con los escaneos
    recientes de los dispositivos marcados para la topología general."""
    await db.execute(delete(TopoAristaGuardada))
    await db.execute(delete(TopoNodoGuardado))
    await db.commit()
    return await _sincronizar(db, horas)
