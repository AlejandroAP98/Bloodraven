import ipaddress
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, desc, extract, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AggDia, AggHora, AggMin, Dispositivo, EquipoRed, HopSample, MuestraPing, Outage
from app.routers.devices import get_db
from app.workers.probes import scheduler

router = APIRouter(prefix="/api", tags=["datos"])

BUCKET_S = 30


def _tz(t: datetime) -> datetime:
    return t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t


def _pctl(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    k = q * (len(s) - 1)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def _redondea(v: float | None, dec: int = 2) -> float | None:
    return round(v, dec) if v is not None else None


def _es_ip_interna(ip: str) -> bool:
    partes = ip.split(".")
    if len(partes) != 4:
        return True  # v6/u otras: tratar como entorno interno por defecto
    try:
        o = [int(p) for p in partes]
    except ValueError:
        return False
    if any(x < 0 or x > 255 for x in o):
        return False
    if o[0] == 10:
        return True
    if o[0] == 172 and 16 <= o[1] <= 31:
        return True
    if o[0] == 192 and o[1] == 168:
        return True
    if o[0] == 169 and o[1] == 254:  # link-local
        return True
    if o[0] == 100 and 64 <= o[1] <= 127:  # CGNAT/radio móvil
        return True
    if o[0] == 127:
        return True
    return False


def _pista_hostname(hostname: str | None) -> str | None:
    """Adivina el papel del equipo por patrones típicos del hostname."""
    if not hostname:
        return None
    tokens = {t for t in hostname.lower().replace("/", "-").replace("_", "-").split("-") if t}
    if tokens & {"radio", "ant", "antena", "celda", "bts", "enb", "gnb", "rnc", "bsc", "ubnt", "ubiquiti", "mikrotik", "mikro", "epmp", "eptp", "ptp", "torre", "tower", "wisp"}:
        return "posible equipo de radio/antena"
    if tokens & {"gw", "gateway", "rtr", "router", "core", "agg", "agregacion", "borde", "border"}:
        return "hostname sugiere router/núcleo"
    if tokens & {"sw", "switch"}:
        return "hostname sugiere switch"
    if tokens & {"cam", "camara", "dvr", "nvr", "cctv"}:
        return "hostname sugiere cámara/DVR"
    if tokens & {"pc", "ws", "workstation", "desktop", "escritorio"}:
        return "hostname sugiere PC"
    return None


async def _device(db: AsyncSession, device_id: uuid.UUID) -> Dispositivo:
    d = await db.get(Dispositivo, device_id)
    if not d:
        raise HTTPException(404, "Dispositivo no encontrado")
    return d


def _rango(desde: datetime | None, hasta: datetime | None) -> tuple[datetime, datetime]:
    to = hasta or datetime.now(timezone.utc)
    frm = desde or to - timedelta(hours=24)
    if frm.tzinfo is None:
        frm = frm.replace(tzinfo=timezone.utc)
    if to.tzinfo is None:
        to = to.replace(tzinfo=timezone.utc)
    return frm, to


# cola viva del camino agg: los últimos 5 min se recomputan desde raw
_TAIL_S = 300
_COLSAS = {"1m": AggMin, "1h": AggHora, "1d": AggDia}


def _punto_agg(b: datetime, n: int, ok_n: int, avg: Any, mn: Any, mx: Any, p95: Any) -> dict[str, Any]:
    return {
        "ts": b.isoformat(),
        "avg_ms": round(float(avg), 2) if avg is not None else None,
        "min_ms": mn,
        "max_ms": mx,
        "p95_ms": round(float(p95), 2) if p95 is not None else None,
        "std_ms": None,
        "perdida_pct": round(100 * (n - (ok_n or 0)) / n, 1) if n else None,
    }


async def _samples_agg(
    db: AsyncSession, device_id: uuid.UUID, frm: datetime, to: datetime, resolucion: str
) -> list[dict[str, Any]]:
    """Puntos desde las tablas agg (consolidadas incrementalmente cada minuto)."""
    modelo = _COLSAS[resolucion]
    res = await db.execute(
        select(modelo.bucket, modelo.n, modelo.ok_n, modelo.avg_ms, modelo.min_ms, modelo.max_ms, modelo.p95_ms)
        .where(modelo.device_id == device_id, modelo.bucket >= frm, modelo.bucket <= to)
        .order_by(modelo.bucket)
    )
    combinado: dict[str, dict[str, Any]] = {
        p["ts"]: p
        for p in (
            _punto_agg(b, n, ok_n, avg, mn, mx, p95)
            for b, n, ok_n, avg, mn, mx, p95 in res.all()
        )
    }

    # cola viva (solo 1m): el último tramo desde raw para no depender del tick del consolidador
    if resolucion == "1m":
        corte = to - timedelta(seconds=_TAIL_S)
        colas = await db.execute(
            select(
                MuestraPing.ts,
                MuestraPing.n,
                MuestraPing.ok_n,
                MuestraPing.rtt_ms,
                MuestraPing.rtt_min_ms,
                MuestraPing.rtt_max_ms,
                MuestraPing.rtt_p95_ms,
            )
            .where(MuestraPing.device_id == device_id, MuestraPing.ts > corte, MuestraPing.ts <= to)
            .order_by(MuestraPing.ts)
        )
        por_minuto: dict[datetime, dict[str, Any]] = {}
        for ts, n, ok_n, rtt, mn_r, mx_r, p95_r in colas.all():
            m = _tz(ts).replace(second=0, microsecond=0)
            e = por_minuto.setdefault(m, {"w": [], "n": 0, "ok_n": 0, "mins": [], "maxs": [], "p95": []})
            e["n"] += int(n or 0)
            e["ok_n"] += int(ok_n or 0)
            if rtt is not None:
                e["w"].append((float(rtt), int(n or 1)))
            if mn_r is not None:
                e["mins"].append(mn_r)
            if mx_r is not None:
                e["maxs"].append(mx_r)
            if p95_r is not None:
                e["p95"].append(p95_r)
        for m, e in por_minuto.items():
            avg = (
                sum(v * w for v, w in e["w"]) / sum(w for _, w in e["w"])
                if e["w"]
                else None
            )
            combinado[m.isoformat()] = {
                "ts": m.isoformat(),
                "avg_ms": round(avg, 2) if avg is not None else None,
                "min_ms": min(e["mins"]) if e["mins"] else None,
                "max_ms": max(e["maxs"]) if e["maxs"] else None,
                "p95_ms": round(max(e["p95"]), 2) if e["p95"] else None,
                "std_ms": None,
                "perdida_pct": round(100 * (e["n"] - e["ok_n"]) / e["n"], 1) if e["n"] else None,
            }

    return [combinado[k] for k in sorted(combinado)]


@router.get("/status")
async def status() -> dict[str, Any]:
    return {"dispositivos": scheduler.estado_actual(), "version": scheduler.estado_version}


@router.get("/devices/{device_id}/ping_ahora")
async def ping_ahora(
    device_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    d = await _device(db, device_id)
    from app.config import get_settings
    from app.workers.chequeos import ejecutar_chequeo

    s = get_settings()
    r = await ejecutar_chequeo(
        d.host, d.tipo or "icmp", s.ping_timeout_ms, None, d.puerto, d.texto_buscado, d.dns_servidor
    )
    rtt = r.get("rtt_ms")
    if r.get("ok") and rtt is not None:
        linea = f"OK {d.tipo or 'icmp'} {d.host} — {rtt:.1f} ms"
    else:
        linea = f"SIN RESPUESTA {d.tipo or 'icmp'} {d.host} (timeout {s.ping_timeout_ms} ms)"
    return {"ok": bool(r.get("ok")), "linea": linea, "rtt_ms": rtt}


def settings_ping_timeout() -> int:
    from app.config import get_settings

    return get_settings().ping_timeout_ms


@router.get("/devices/{device_id}/samples")
async def samples(
    device_id: uuid.UUID,
    desde: datetime | None = None,
    hasta: datetime | None = None,
    resolucion: str = Query(default="raw", pattern="^(raw|1m|1h|1d)$"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await _device(db, device_id)
    frm, to = _rango(desde, hasta)

    if resolucion == "raw":
        res = await db.execute(
            select(
                MuestraPing.ts,
                MuestraPing.rtt_ms,
                MuestraPing.ok,
                MuestraPing.n,
                MuestraPing.rtt_min_ms,
                MuestraPing.rtt_max_ms,
                MuestraPing.rtt_median_ms,
                MuestraPing.rtt_p95_ms,
                MuestraPing.rtt_std_ms,
                case(
                    (
                        MuestraPing.n > 0,
                        (MuestraPing.n - MuestraPing.ok_n) * 100.0 / MuestraPing.n,
                    ),
                    else_=0.0,
                ).label("perdida"),
            )
            .where(
                MuestraPing.device_id == device_id,
                MuestraPing.ts >= frm,
                MuestraPing.ts <= to,
            )
            .order_by(MuestraPing.ts)
            .limit(50000)
        )
        filas = [
            {
                "ts": r[0].isoformat(),
                "rtt_ms": r[1],
                "ok": r[2],
                "n": r[3],
                "rtt_min_ms": r[4],
                "rtt_max_ms": r[5],
                "rtt_median_ms": r[6],
                "rtt_p95_ms": r[7],
                "rtt_std_ms": r[8],
                "perdida_pct": r[9],
            }
            for r in res.all()
        ]
        return {"resolucion": "raw", "puntos": filas}

    partes = {"1m": 60, "1h": 3600, "1d": 86400}[resolucion]

    # ventanas largas se sirven desde las tablas agg (el consolidador incremental
    # las deja actualizadas al minuto); corto o sin agg → camino raw como siempre
    vent_h = (to - frm).total_seconds() / 3600.0
    usar_agg = (
        (resolucion == "1m" and vent_h > 2)
        or (resolucion == "1h" and vent_h >= 48)
        or (resolucion == "1d")
    )
    if usar_agg:
        puntos = await _samples_agg(db, device_id, frm, to, resolucion)
        if puntos:
            return {"resolucion": resolucion, "puntos": puntos}

    bucket = func.to_timestamp(
        func.floor(func.extract("epoch", MuestraPing.ts) / partes) * partes
    ).label("bucket")
    res = await db.execute(
        select(
            bucket,
            func.sum(MuestraPing.n).label("n"),
            func.sum(MuestraPing.ok_n).label("ok_n"),
            func.sum(MuestraPing.rtt_ms * MuestraPing.n) / func.sum(MuestraPing.n).label("avg_p"),
            func.min(MuestraPing.rtt_min_ms).label("mn"),
            func.max(MuestraPing.rtt_max_ms).label("mx"),
            func.max(MuestraPing.rtt_p95_ms).label("p95"),
            func.sum(
                MuestraPing.n * (
                    func.coalesce(MuestraPing.rtt_std_ms, 0) * func.coalesce(MuestraPing.rtt_std_ms, 0)
                    + func.coalesce(MuestraPing.rtt_ms, 0) * func.coalesce(MuestraPing.rtt_ms, 0)
                )
            ).label("ssq"),
        )
        .where(
            MuestraPing.device_id == device_id,
            MuestraPing.ts >= frm,
            MuestraPing.ts <= to,
        )
        .group_by("bucket")
        .order_by("bucket")
    )
    puntos = []
    for b, n, ok_n, avg_p, mn, mx, p95, ssq in res.all():
        avg = float(avg_p) if avg_p is not None else None
        std = None
        if avg is not None and ssq is not None and n:
            var = float(ssq) / n - avg ** 2
            std = var ** 0.5 if var > 0 else None
        puntos.append(
            {
                "ts": b.isoformat() if hasattr(b, "isoformat") else str(b),
                "avg_ms": round(avg, 2) if avg is not None else None,
                "min_ms": mn,
                "max_ms": mx,
                "p95_ms": round(float(p95), 2) if p95 is not None else None,
                "std_ms": round(std, 2) if std is not None else None,
                "perdida_pct": round(100 * (n - (ok_n or 0)) / n, 1) if n else None,
            }
        )
    return {"resolucion": resolucion, "puntos": puntos}


def _corte_str(
    hay: bool, hay_ok: bool, ttl_ultimo: Any, ttl_max: Any, quien: Any
) -> str:
    """Clasifica dónde murió una caída: espejo de clasificarCorte() del frontend."""
    if not hay:
        return "sin trazado de ruta"
    if not hay_ok:
        return "sin respuesta ni del gateway: corte en la red local"
    ultimo_ttl = int(ttl_ultimo or 0)
    max_ttl = int(ttl_max or 0)
    etiqueta = quien or f"hop {ultimo_ttl}"
    if ultimo_ttl == max_ttl:
        return f"la ruta completa respondió: {etiqueta} (destino) no contesta al ping"
    return f"corte aguas abajo del hop {ultimo_ttl} ({etiqueta})"


@router.get("/devices/{device_id}/outages")
async def outages(
    device_id: uuid.UUID,
    desde: datetime | None = None,
    hasta: datetime | None = None,
    limite: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    await _device(db, device_id)
    frm, to = _rango(desde, hasta)
    # listado sin el JSONB: la clasificación del corte se calcula dentro de
    # Postgres (el snapshot completo lo sirve GET /api/outages/{id} para "ver")
    res = await db.execute(
        text(
            """
            SELECT o.id, o.inicio, o.fin, o.causa,
                   EXISTS (SELECT 1 FROM jsonb_array_elements(o.hops_snapshot) h) AS hay_hops,
                   EXISTS (SELECT 1 FROM jsonb_array_elements(o.hops_snapshot) h
                            WHERE (h->>'ok')::bool) AS hay_ok,
                   (SELECT max((h->>'ttl')::int)
                      FROM jsonb_array_elements(o.hops_snapshot) h
                     WHERE (h->>'ok')::bool) AS ttl_ultimo,
                   (SELECT max((h->>'ttl')::int)
                      FROM jsonb_array_elements(o.hops_snapshot) h) AS ttl_max,
                   (SELECT coalesce(h->>'hostname', h->>'ip')
                      FROM jsonb_array_elements(o.hops_snapshot) h
                     ORDER BY CASE WHEN (h->>'ok')::bool THEN (h->>'ttl')::int ELSE -1 END DESC
                     LIMIT 1) AS quien
            FROM outages o
            WHERE o.device_id = :device_id AND o.inicio >= :frm AND o.inicio <= :to
            ORDER BY o.inicio DESC
            LIMIT :limite
            """
        ),
        {"device_id": device_id, "frm": frm, "to": to, "limite": limite},
    )
    ahora = datetime.now(timezone.utc)
    salida = []
    for rid, inicio, fin, causa, hay, hay_ok, ttl_ultimo, ttl_max, quien in res.all():
        salida.append(
            {
                "id": str(rid),
                "inicio": inicio.isoformat(),
                "fin": fin.isoformat() if fin else None,
                "duracion_s": ((fin or ahora) - inicio).total_seconds(),
                "activa": fin is None,
                "causa": causa,
                "corte": _corte_str(hay, hay_ok, ttl_ultimo, ttl_max, quien),
                "tiene_ruta": bool(hay),
            }
        )
    return salida


@router.get("/devices/{device_id}/cobertura")
async def cobertura(
    device_id: uuid.UUID,
    horas: float = Query(default=24, gt=0, le=720),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    d = await _device(db, device_id)
    to = datetime.now(timezone.utc)
    frm = to - timedelta(hours=horas)

    umbral = d.umbral_degradado_ms

    # agregado todo en SQL: antes traía TODAS las filas crudas de la ventana a
    # Python (~8 500 para 720 h) para hacer sums y contar degradado aquí
    res = await db.execute(
        select(
            func.min(MuestraPing.ts),
            func.max(MuestraPing.ts),
            func.count(),
            func.sum(MuestraPing.n),
            func.sum(MuestraPing.ok_n),
            func.count().filter(MuestraPing.rtt_p95_ms > umbral),
        ).where(MuestraPing.device_id == device_id, MuestraPing.ts >= frm, MuestraPing.ts <= to)
    )
    primero_raw, ultimo_raw, n_filas, pings, pings_ok, degradado_n = res.one()

    if not n_filas:
        return {
            "vigilado_desde": None,
            "vigilado_hasta": to.isoformat(),
            "vigilado_s": 0,
            "pings": 0,
            "pings_ok": 0,
            "cobertura_pct": 0.0,
            "n_huecos": 0,
            "huecos": [],
            "caidas_n": 0,
            "caidas_s_acum": 0.0,
            "caida_max_s": 0.0,
            "disponibilidad_pct": None,
            "degradado_s": 0,
        }

    primero = _tz(primero_raw)
    ultimo = _tz(ultimo_raw)
    # la vigilancia se considera activa si el último bucket es reciente
    hasta = to if (to - ultimo).total_seconds() < 120 else ultimo
    vigilado_s = max(0.0, (hasta - primero).total_seconds())

    pings = int(pings or 0)
    pings_ok = int(pings_ok or 0)

    # buckets esperados hasta el último bucket CERRADO (el bucket en curso no existe aún)
    esperados = max(1, round((ultimo - primero).total_seconds() / BUCKET_S) + 1)
    cobertura = n_filas / esperados * 100.0

    # huecos con LAG en SQL (el window fn no va en WHERE: subconsulta y filtro afuera);
    # a Python solo llega un par de timestamps por hueco, no toda la ventana
    bases = (
        select(
            MuestraPing.ts.label("ts"),
            func.lag(MuestraPing.ts).over(order_by=MuestraPing.ts).label("prev"),
        )
        .where(MuestraPing.device_id == device_id, MuestraPing.ts >= frm, MuestraPing.ts <= to)
        .subquery()
    )
    gres = await db.execute(
        select(bases.c.ts, bases.c.prev)
        .where(extract("epoch", bases.c.ts - bases.c.prev) > 90)
        .order_by(bases.c.ts)
    )
    huecos: list[dict[str, Any]] = [
        {
            "inicio": (_tz(prev) + timedelta(seconds=BUCKET_S)).isoformat(),
            "duracion_s": round((_tz(ts) - _tz(prev)).total_seconds() - BUCKET_S),
        }
        for ts, prev in gres.all()
    ]

    ores = await db.execute(
        select(Outage.inicio, Outage.fin, Outage.id)
        .where(
            Outage.device_id == device_id,
            Outage.inicio <= hasta,
            or_(Outage.fin >= primero, Outage.fin.is_(None)),
        )
        .order_by(Outage.inicio)
    )
    caidas_n = 0
    acum = 0.0
    max_s = 0.0
    for parte, fin, _oid in ores.all():
        i0 = max(_tz(parte), primero)
        f0 = min(_tz(fin) if fin else hasta, hasta)
        if f0 > i0:
            durada = (f0 - i0).total_seconds()
            acum += durada
            max_s = max(max_s, durada)
        if primero <= _tz(parte) <= hasta:
            caidas_n += 1

    degradado_s = int(degradado_n or 0) * BUCKET_S

    disponibilidad = (
        max(0.0, (vigilado_s - acum) / vigilado_s * 100.0) if vigilado_s > 0 else None
    )

    return {
        "vigilado_desde": primero.isoformat(),
        "vigilado_hasta": hasta.isoformat(),
        "vigilado_s": round(vigilado_s),
        "pings": pings,
        "pings_ok": pings_ok,
        "cobertura_pct": round(cobertura, 1),
        "n_huecos": len(huecos),
        "huecos": huecos,
        "caidas_n": caidas_n,
        "caidas_s_acum": round(acum),
        "caida_max_s": round(max_s),
        "disponibilidad_pct": round(disponibilidad, 2) if disponibilidad is not None else None,
        "degradado_s": degradado_s,
    }


@router.get("/disponibilidad")
async def disponibilidad(
    horas: float = Query(default=24, gt=0, le=720),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Resumen de caídas y disponibilidad por dispositivo en las últimas N horas."""
    to = datetime.now(timezone.utc)
    frm = to - timedelta(hours=horas)

    resolver = await db.execute(
        select(MuestraPing.device_id, func.min(MuestraPing.ts).label("primero"))
        .where(MuestraPing.ts >= frm)
        .group_by(MuestraPing.device_id)
    )
    primeros = {str(dev): _tz(pri) for dev, pri in resolver.all()}

    res = await db.execute(
        select(Outage.device_id, Outage.inicio, Outage.fin).where(Outage.inicio >= frm)
    )
    agg: dict[str, dict[str, Any]] = {}
    for device_id, parte, piece_fin in res.all():
        vid = str(device_id)
        a = _tz(parte)
        f = _tz(piece_fin) if piece_fin else to
        f = min(f, to)
        if f <= a:
            continue
        e = agg.setdefault(
            vid, {"device_id": vid, "caidas_n": 0, "caidas_s_acum": 0.0, "caida_max_s": 0.0}
        )
        e["caidas_n"] += 1
        durada = (f - a).total_seconds()
        e["caidas_s_acum"] += durada
        e["caida_max_s"] = max(float(e["caida_max_s"]), durada)

    salida: list[dict[str, Any]] = []
    for vid, primero in primeros.items():
        e = agg.get(vid, {"device_id": vid, "caidas_n": 0, "caidas_s_acum": 0.0, "caida_max_s": 0.0})
        vigilado_s = max(0.0, (to - max(primero, frm)).total_seconds())
        caidas_s = min(float(e["caidas_s_acum"]), vigilado_s) if vigilado_s else 0.0
        disponibilidad = (
            max(0.0, (vigilado_s - caidas_s) / vigilado_s * 100.0) if vigilado_s > 0 else None
        )
        salida.append(
            {
                "device_id": vid,
                "caidas_n": e["caidas_n"],
                "caidas_s_acum": round(float(e["caidas_s_acum"])),
                "disponibilidad_pct": round(disponibilidad, 2) if disponibilidad is not None else None,
            }
        )
    return salida


@router.get("/devices/{device_id}/cambios_ruta")
async def cambios_ruta(
    device_id: uuid.UUID,
    limite: int = Query(default=50, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Historial de cambios de ruta detectados por diff de hops."""
    await _device(db, device_id)
    from app.models import CambioRuta

    res = await db.execute(
        select(CambioRuta)
        .where(CambioRuta.device_id == device_id)
        .order_by(desc(CambioRuta.ts))
        .limit(limite)
    )
    return [
        {
            "ts": c.ts.isoformat(),
            "resumen": c.resumen,
            "hops": c.hops,
        }
        for c in res.scalars().all()
    ]


@router.get("/devices/{device_id}/ruta_referencia")
async def ruta_referencia(
    device_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Primer escaneo de ruta registrado: la referencia contra la que el
    panel de cambios de ruta compara (se muestra siempre, aunque no haya cambios)."""
    await _device(db, device_id)
    from app.models import HopSample

    res = await db.execute(select(func.min(HopSample.ts)).where(HopSample.device_id == device_id))
    ts0 = res.scalar()
    if ts0 is None:
        return {"ts": None, "hops": []}
    res2 = await db.execute(
        select(HopSample)
        .where(HopSample.device_id == device_id, HopSample.ts == ts0)
        .order_by(HopSample.ttl)
    )
    return {
        "ts": ts0.isoformat(),
        "hops": [
            {"ttl": h.ttl, "ip": h.ip, "hostname": h.hostname, "rtt_ms": h.rtt_ms, "ok": h.ok}
            for h in res2.scalars().all()
        ],
    }


@router.get("/devices/{device_id}/diagnostico")
async def diagnostico(
    device_id: uuid.UUID,
    horas: float = Query(default=24, gt=0, le=720),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Diagnóstico de red con hop_samples de la ventana: latencia por hop,
    atribución de latencia por tramo y alcance de los sondeos de ruta."""
    d = await _device(db, device_id)
    frm = _tz(datetime.now(timezone.utc)) - timedelta(hours=horas)
    # cap de scans (720 ≈ 5 días de hop-scan): la agregación recorre el escaneo
    # completo; con 720 h sin cap serían ~60 000 filas de hops para lo mismo
    res = await db.execute(
        select(HopSample.ts)
        .where(HopSample.device_id == device_id, HopSample.ts >= frm)
        .group_by(HopSample.ts)
        .order_by(desc(HopSample.ts))
        .limit(720)
    )
    scans_ts = [_tz(t) for (t,) in res.all()]
    if not scans_ts:
        return {
            "horas": horas,
            "n_scans": 0,
            "ecos_destino": 0,
            "destino_alcanzado_pct": None,
            "hasta_ttl": [],
            "hops": [],
            "tramos": [],
        }
    res = await db.execute(
        select(
            HopSample.ts,
            HopSample.ttl,
            HopSample.ip,
            HopSample.hostname,
            HopSample.rtt_ms,
            HopSample.ok,
        )
        .where(HopSample.device_id == device_id, HopSample.ts >= min(scans_ts) - timedelta(seconds=1))
        .order_by(HopSample.ts, HopSample.ttl)
    )
    filas = res.all()

    # los scans comparten ts: agrupa (ts -> ttl -> hop)
    # ecos del destino: hop consecutivo con la MISMA IP (dualidad router/host de los
    # equipos de borde: Time Exceeded en TTL n + Echo Reply en n+1) se colapsa al primero
    scans: dict[datetime, dict[int, tuple[str | None, str | None, float | None, bool]]] = {}
    ecos_destino = 0
    scan: dict[int, tuple[str | None, str | None, float | None, bool]] = {}
    ultima_ip: str | None = None
    for ts, ttl, ip, hostname, rtt, ok in filas:
        t = _tz(ts)
        if t not in scans:
            scans[t] = {}
            scan = scans[t]
            ultima_ip = None
        # eco del destino: hop consecutivo con la MISMA IP (dualidad router/host de
        # los equipos de borde: Time Exceeded en TTL n + Echo Reply en n+1) se colapsa
        if ip and ultima_ip and ultima_ip == str(ip).lower():
            ecos_destino += 1
            continue
        if ip:
            ultima_ip = str(ip).lower()
        scan[int(ttl)] = (ip, hostname, float(rtt) if rtt is not None else None, bool(ok))
    n_scans = len(scans)
    if not n_scans:
        return {
            "horas": horas,
            "n_scans": 0,
            "ecos_destino": 0,
            "destino_alcanzado_pct": None,
            "hasta_ttl": [],
            "hops": [],
            "tramos": [],
        }

    # agregados por hop y moda de ip/hostname (la ruta puede variar entre scans)
    por_ttl: dict[int, dict[str, Any]] = {}
    ips_ttl: dict[int, Counter[str]] = {}
    host_ttl: dict[int, Counter[str]] = {}
    for scan in scans.values():
        for ttl, (ip, hostname, rtt, ok) in scan.items():
            a = por_ttl.setdefault(ttl, {"n": 0, "ok_n": 0, "rtts": []})
            a["n"] += 1
            if ok:
                a["ok_n"] += 1
                if rtt is not None:
                    a["rtts"].append(rtt)
            if ip:
                ips_ttl.setdefault(ttl, Counter())[ip] += 1
            if hostname:
                host_ttl.setdefault(ttl, Counter())[hostname] += 1

    # destino como IP (si el host del dispositivo es una IP): para detectar el salto objetivo
    try:
        host_ip = str(ipaddress.ip_address(d.host.strip()))
    except ValueError:
        host_ip = None

    hops = []
    for ttl in sorted(por_ttl):
        a = por_ttl[ttl]
        rtts: list[float] = a["rtts"]
        hops.append(
            {
                "ttl": ttl,
                "ip": ips_ttl[ttl].most_common(1)[0][0] if ttl in ips_ttl else None,
                "hostname": host_ttl[ttl].most_common(1)[0][0] if ttl in host_ttl else None,
                "muestras": a["n"],
                "ok_pct": round(100 * a["ok_n"] / a["n"], 1),
                "rtt_avg_ms": _redondea(sum(rtts) / len(rtts)) if rtts else None,
                "rtt_p95_ms": _redondea(_pctl(rtts, 0.95)),
                "rtt_max_ms": _redondea(max(rtts)) if rtts else None,
            }
        )

    # catálogo manual: lo declarado por el usuario tiene prioridad sobre la inferencia
    cat: dict[str, EquipoRed] = {}
    res_cat = await db.execute(select(EquipoRed))
    for e in res_cat.scalars().all():
        cat[e.ip.lower()] = e

    # tipo inferido por hop: posición + tipo de IP + pista del hostname
    # si la IP está en el catálogo manual, tipo = rol declarado y se marca manual
    total_hops = len(hops)
    for h in hops:
        ip = h["ip"]
        if not ip:
            h["tipo"], h["pista"], h["manual"] = "sin respuesta", None, False
            continue
        entrada = cat.get(ip.lower())
        if entrada:
            h["tipo"] = entrada.rol
            h["manual"] = True
            h["pista"] = f"catálogo: {entrada.nombre} — {entrada.notas}" if entrada.notas else f"catálogo: {entrada.nombre}"
            continue
        pista = _pista_hostname(h["hostname"])
        h["manual"] = False
        if host_ip and ip.lower() == host_ip:
            h["tipo"], h["pista"] = "equipo objetivo", pista
        elif h["ttl"] == 1:
            h["tipo"], h["pista"] = "gateway local", pista
        elif h["ttl"] == total_hops:
            h["tipo"], h["pista"] = "último salto", pista
        elif not _es_ip_interna(ip):
            h["tipo"], h["pista"] = "borde público", pista
        else:
            h["tipo"], h["pista"] = "router/agregador interno", pista

    # atribución por tramo: delta entre hops consecutivos respondidos en el MISMO scan
    tramos_acc: dict[int, list[float]] = {}
    for scan in scans.values():
        for ttl in sorted(scan):
            sig = scan.get(ttl + 1)
            if not sig:
                continue
            _, _, r0, ok0 = scan[ttl]
            _, _, r1, ok1 = sig
            if ok0 and ok1 and r0 is not None and r1 is not None:
                tramos_acc.setdefault(ttl, []).append(r1 - r0)
    tramos = []
    for de_ttl in sorted(tramos_acc):
        deltas = tramos_acc[de_ttl]
        sig_ip = ips_ttl[de_ttl + 1].most_common(1)[0][0] if (de_ttl + 1) in ips_ttl else None
        sig_host = host_ttl[de_ttl + 1].most_common(1)[0][0] if (de_ttl + 1) in host_ttl else None
        tramos.append(
            {
                "de_ttl": de_ttl,
                "a_ttl": de_ttl + 1,
                "a_ip": sig_ip,
                "a_hostname": sig_host,
                "n": len(deltas),
                "delta_avg_ms": _redondea(sum(deltas) / len(deltas)),
                "delta_p95_ms": _redondea(_pctl(deltas, 0.95)),
                "delta_max_ms": _redondea(max(deltas)),
            }
        )

    # alcance: hasta dónde llegan los sondeos y cuántos alcanzaron el destino
    hasta_ttl: Counter[int] = Counter()
    alcanzados = 0
    for scan in scans.values():
        oks = [ttl for ttl, (_, _, _, ok) in scan.items() if ok]
        hasta_ttl[max(oks) if oks else 0] += 1
        if host_ip and any(ok and ip == host_ip for ip, _, _, ok in scan.values()):
            alcanzados += 1

    return {
        "horas": horas,
        "n_scans": n_scans,
        "ecos_destino": ecos_destino,
        "destino_alcanzado_pct": round(100 * alcanzados / n_scans, 1) if host_ip else None,
        "hasta_ttl": [{"ttl": ttl, "scans": n} for ttl, n in sorted(hasta_ttl.items())],
        "hops": hops,
        "tramos": tramos,
    }


def _host_a_ip(host: str | None) -> str | None:
    """Extrae la IP literal de un host de dispositivo (podría venir como
    https://1.2.3.4/ o con puerto)."""
    texto = str(host or "").replace("https://", "").replace("http://", "")
    texto = texto.split("/")[0].split(":")[0].strip()
    try:
        return str(ipaddress.ip_address(texto))
    except ValueError:
        return None


def _vecindad_arp(ip: str, arp_ips: list[str], radio: int = 2) -> bool:
    """Hay entradas arp a corta distancia numérica: si un vecino responde, esta
    ip puede estar ocupada aunque no conteste al primer barrido."""
    try:
        destino = int(ipaddress.ip_address(ip))
    except ValueError:
        return False
    vecinos = []
    for o in arp_ips:
        try:
            vecinos.append(int(ipaddress.ip_address(o)))
        except ValueError:
            continue
    return any(abs(destino - n) <= radio for n in vecinos)


@router.post("/descubrir")
async def descubrir(w: dict[str, Any], db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    import asyncio

    from app.workers.descubrir import descubrir_red, reverificar

    cidr = str(w.get("cidr") or "").strip()
    if not cidr:
        raise HTTPException(400, "cidr requerido (ej. 192.168.1.0/24)")
    try:
        red = ipaddress.ip_network(cidr, strict=False)
    except ValueError as e:
        raise HTTPException(400, f"CIDR inválido: {e}")
    if red.num_addresses > 1024:
        raise HTTPException(400, "Subred demasiado grande (máx /22)")

    r = await descubrir_red(cidr)
    vivos: list[dict[str, Any]] = list(r["vivos"])  # type: ignore[arg-type]
    todos: list[str] = list(r["todos"])  # type: ignore[arg-type]
    ip_vivas = {str(v["ip"]) for v in vivos}

    # IPs conocidas en la subred: catálogo de equipos (aunque estén apagadas)
    ip_catalogo: set[str] = set()
    rescat = await db.execute(select(EquipoRed.ip))
    for (ip,) in rescat.all():
        if (a := _host_a_ip(ip)) and ipaddress.ip_address(a) in red:
            ip_catalogo.add(a)

    # y hosts de dispositivos monitoreados (mismo cleanup que hace el frontend)
    ip_monitoreado: set[str] = set()
    resdev = await db.execute(select(Dispositivo.host))
    for (host,) in resdev.all():
        if (a := _host_a_ip(host)) and ipaddress.ip_address(a) in red:
            ip_monitoreado.add(a)

    # tabla ARP: presencias que no responden al icmp (firewall) en subred on-link
    from app.workers.arp_windows import tabla_arp

    arp_en_red: list[str] = []
    try:
        for ip, _tipo in (await tabla_arp()).items():
            if ipaddress.ip_address(ip) in red:
                arp_en_red.append(ip)
    except ValueError:
        pass

    # clasificación de las que no respondieron al barrido
    candidatos: list[str] = []
    ocupadas_s: list[dict[str, Any]] = []
    for ip in todos:
        if ip in ip_vivas:
            continue
        evid: list[str] = []
        if ip in arp_en_red:
            evid.append("arp")
        if ip in ip_catalogo:
            evid.append("catalogo")
        if ip in ip_monitoreado:
            evid.append("monitoreado")
        if evid:
            ocupadas_s.append({"ip": ip, "evidencia": evid})
        else:
            candidatos.append(ip)

    # re-ping largo a los candidatos con vecindad arp activa: si aparece
    # respuesta, estaba viva y el barrido la perdió
    revividos = await reverificar([ip for ip in candidatos if _vecindad_arp(ip, arp_en_red)])
    for ip in revividos:
        ip_vivas.add(ip)
        vivos.append({"ip": ip, "rtt_ms": None})
    libres = [{"ip": ip} for ip in candidatos if ip not in revividos]

    def _key(v: dict[str, Any]) -> tuple[int, int, int, int]:
        p = str(v["ip"]).split(".")
        return tuple(int(x) for x in p) if len(p) == 4 else (0, 0, 0, 999)

    vivos = [{"ip": v["ip"], "rtt_ms": v.get("rtt_ms")} for v in sorted(vivos, key=_key)]

    return {
        "cidr": cidr,
        "n_hosts": red.num_addresses,
        "n_escaneados": len(todos),
        "vivos": vivos,
        "libres": libres,
        "ocupadas_silenciosas": ocupadas_s,
    }


@router.post("/identificar")
async def identificar(w: dict[str, Any], db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Sondeo de puertos TCP + banners de las IPs del descubrimiento: sugiere
    el rol por firma (cámara/DVR/RouterOS/PC…) y cruza con el catálogo para
    marcar las que ya tienen nombre y rol declarado a mano."""
    from app.workers.puertos import sondear

    crudas = w.get("ips") or []
    if not isinstance(crudas, list):
        raise HTTPException(400, "ips debe ser una lista de strings")
    ips: list[str] = []
    for x in crudas[:24]:
        try:
            ips.append(str(ipaddress.ip_address(str(x).strip())))
        except ValueError:
            continue
    ips = list(dict.fromkeys(ips))
    if not ips:
        raise HTTPException(400, "sin ips válidas que identificar")

    resultados = await sondear(ips)

    rescat = await db.execute(select(EquipoRed).where(EquipoRed.ip.in_(ips)))
    cat = {e.ip: e for e in rescat.scalars().all()}
    for r in resultados:
        e = cat.get(str(r["ip"]))
        r["catalogo_nombre"] = e.nombre if e else None
        r["catalogo_rol"] = e.rol if e else None
    return {"resultados": resultados}


@router.get("/devices/{device_id}/sondeo_ruta")
async def sondeo_ruta(
    device_id: uuid.UUID,
    horas: float = Query(default=24, gt=0, le=720),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Sondeo de puertos TCP de las IPs vistas en la ruta del dispositivo:
    identifica por firma qué es cada hop (PC, cámara/DVR, equipo gestionable)."""
    d = await _device(db, device_id)
    frm = _tz(datetime.now(timezone.utc)) - timedelta(hours=horas)
    res = await db.execute(
        select(HopSample.ip).where(HopSample.device_id == device_id, HopSample.ts >= frm).distinct()
    )
    ips = [str(i) for (i,) in res.all() if i]
    # el propio destino, si su host es una IP literal
    host = d.host.strip()
    if host and host not in ips:
        try:
            import ipaddress as _ipaddress

            if host not in ips:
                ips.append(str(_ipaddress.ip_address(host)))
        except ValueError:
            pass
    from app.workers.puertos import sondear

    resultados = await sondear(ips)
    return {"horas": horas, "resultados": resultados}


@router.get("/outages/{outage_id}")
async def outage_detalle(
    outage_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    o = await db.get(Outage, outage_id)
    if not o:
        raise HTTPException(404, "Outage no encontrado")
    fin = o.fin or datetime.now(timezone.utc)
    return {
        "id": str(o.id),
        "device_id": str(o.device_id),
        "inicio": o.inicio.isoformat(),
        "fin": o.fin.isoformat() if o.fin else None,
        "duracion_s": (fin - o.inicio).total_seconds(),
        "activa": o.fin is None,
        "causa": o.causa,
        "hops_snapshot": o.hops_snapshot,
    }


@router.get("/devices/{device_id}/hops")
async def hops(
    device_id: uuid.UUID,
    ts: datetime | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    await _device(db, device_id)
    if ts is None:
        res = await db.execute(
            select(HopSample.ts)
            .where(HopSample.device_id == device_id)
            .order_by(desc(HopSample.ts))
            .limit(1)
        )
        ultimo = res.scalar_one_or_none()
        if not ultimo:
            return []
        ts = ultimo
    elif ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)

    res = await db.execute(
        select(HopSample)
        .where(HopSample.device_id == device_id, HopSample.ts == ts)
        .order_by(HopSample.ttl)
    )
    return [
        {
            "ttl": h.ttl,
            "ip": h.ip,
            "hostname": h.hostname,
            "rtt_ms": h.rtt_ms,
            "ok": h.ok,
        }
        for h in res.scalars().all()
    ]
