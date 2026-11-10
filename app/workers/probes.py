import asyncio
import contextlib
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import get_settings
from app.database import SesionLocal
from app.models import CambioRuta, Dispositivo, HopHost, HopSample, MuestraPing, Outage, ReglaAlerta
from app.services.alertas import notificar
from app.workers.chequeos import ejecutar_chequeo, host_para_tracert
from app.workers.traceroute_windows import asociar_hostnames, traceroute_host

settings = get_settings()
BUCKET_S = 30


def _percentil(rtts: list[float], q: float) -> float | None:
    if not rtts:
        return None
    s = sorted(rtts)
    k = q * (len(s) - 1)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def _desv(rtts: list[float]) -> float | None:
    if len(rtts) < 2:
        return None
    media = sum(rtts) / len(rtts)
    return (sum((x - media) ** 2 for x in rtts) / len(rtts)) ** 0.5


class EstadoDevice:
    def __init__(self, d: Dispositivo) -> None:
        self.id = str(d.id)
        self.nombre = d.nombre
        self.host = d.host
        self.tipo = d.tipo or "icmp"
        self.puerto = d.puerto
        self.texto_buscado = d.texto_buscado
        self.dns_servidor = d.dns_servidor
        self.intervalo_ping_s = d.intervalo_ping_s
        self.hop_scan_interval_min = d.hop_scan_interval_min
        self.umbral_degradado_ms = d.umbral_degradado_ms
        self.n_fallos_down = d.n_fallos_down
        self.silencio_hasta = d.silencio_hasta
        self.reglas: list[dict[str, Any]] = []
        self.fallos_consecutivos = 0
        self.ultimo_rtt: float | None = None
        self.degradado = False
        self.outage_abierto: str | None = None
        self.next_hop_scan: float = 0.0
        self.force_hop: bool = False
        self.ruta_fp: tuple[str | None, ...] | None = None

    def estado(self) -> str:
        if self.outage_abierto:
            return "down"
        if self.degradado:
            return "degradado"
        return "ok"


class SchedulerMono:
    def __init__(self) -> None:
        self.estados: dict[str, EstadoDevice] = {}
        self.tareas: dict[str, asyncio.Task[None]] = {}
        self._reload_event = asyncio.Event()
        self._host_cache: dict[str, str | None] = {}
        self._sem_tracert = asyncio.Semaphore(settings.max_tracerts_concurrentes)
        self._sem_icmp = asyncio.Semaphore(settings.max_pings_concurrentes)
        self.ultimo_aviso: dict[str, float] = {}
        self.estado_version = 0

    def estado_actual(self) -> list[dict[str, Any]]:
        return [
            {
                "device_id": e.id,
                "nombre": e.nombre,
                "host": e.host,
                "tipo": e.tipo,
                "estado": e.estado(),
                "ultimo_rtt_ms": e.ultimo_rtt,
                "fallos_consecutivos": e.fallos_consecutivos,
                "outage_id": e.outage_abierto,
            }
            for e in self.estados.values()
        ]

    async def notificar_cambio(self) -> None:
        self._reload_event.set()

    async def _recargar(self) -> None:
        async with SesionLocal() as db:
            res = await db.execute(select(Dispositivo).where(Dispositivo.activo.is_(True)))
            dispositivos = res.scalars().all()
            res_reglas = await db.execute(select(ReglaAlerta).where(ReglaAlerta.activo.is_(True)))

        reglas_por_device: dict[str, list[dict[str, Any]]] = {}
        for r in res_reglas.scalars():
            reglas_por_device.setdefault(str(r.device_id), []).append(
                {
                    "tipo": r.tipo,
                    "umbral": r.umbral,
                    "ventana_min": r.ventana_min,
                    "activo": r.activo,
                }
            )

        vivos = set()
        for d in dispositivos:
            vid = str(d.id)
            vivos.add(vid)
            state = self.estados.get(vid)
            if state is None:
                state = EstadoDevice(d)
                state.reglas = reglas_por_device.get(vid, [])
                state.force_hop = True
                self.estados[vid] = state
                self.tareas[vid] = asyncio.create_task(self._loop_device(state))
            else:
                host_cambio = state.host != d.host
                state.nombre = d.nombre
                state.host = d.host
                state.tipo = d.tipo or "icmp"
                state.puerto = d.puerto
                state.texto_buscado = d.texto_buscado
                state.dns_servidor = d.dns_servidor
                state.intervalo_ping_s = d.intervalo_ping_s
                state.hop_scan_interval_min = d.hop_scan_interval_min
                state.umbral_degradado_ms = d.umbral_degradado_ms
                state.n_fallos_down = d.n_fallos_down
                state.silencio_hasta = d.silencio_hasta
                state.reglas = reglas_por_device.get(vid, [])
                if host_cambio:
                    state.force_hop = True

        for vid in set(self.estados.keys()) - vivos:
            self.estados.pop(vid, None)
            t = self.tareas.pop(vid, None)
            if t:
                t.cancel()
        self.estado_version += 1

    def reiniciar_estado(self, device_id: str) -> None:
        """Limpia el estado en memoria del dispositivo: la supervisión empieza de cero."""
        state = self.estados.get(device_id)
        if state is None:
            return
        state.fallos_consecutivos = 0
        state.ultimo_rtt = None
        state.degradado = False
        state.outage_abierto = None
        state.ruta_fp = None
        state.force_hop = True

    # --- ayudas de alertas ---
    def silencio_activo(self, state: EstadoDevice) -> bool:
        h = state.silencio_hasta
        if h is None:
            return False
        if h.tzinfo is None:
            h = h.replace(tzinfo=timezone.utc)
        return h > datetime.now(timezone.utc)

    def cooldown(self, state: EstadoDevice, tipo: str, ventana_seg: float) -> bool:
        """True si pasó el cooldown para notificar ese tipo de evento en el dispositivo."""
        k = f"{state.id}:{tipo}"
        ahora = time.monotonic()
        if ahora - self.ultimo_aviso.get(k, -1e12) < ventana_seg:
            return False
        self.ultimo_aviso[k] = ahora
        return True

    async def _evaluar_reglas(self, state: EstadoDevice) -> None:
        """Evalúa las reglas activas de latencia/pérdida sobre la ventana reciente."""
        activas = [r for r in state.reglas if r["activo"] and r["tipo"] in ("latencia", "perdida")]
        if not activas:
            return
        # una sola sesión para todas las reglas del ciclo (antes abría una por regla)
        async with SesionLocal() as db:
            for regla in activas:
                ventana: int = int(regla["ventana_min"])
                umbral: float = float(regla["umbral"])
                desde = datetime.now(timezone.utc) - timedelta(minutes=ventana)
                res = await db.execute(
                    select(
                        func.count(MuestraPing.id).label("n"),
                        func.sum(case((MuestraPing.rtt_ms > umbral, 1), else_=0)).label("altos"),
                        func.sum(MuestraPing.n).label("total_n"),
                        func.sum(MuestraPing.ok_n).label("total_ok"),
                    ).where(MuestraPing.device_id == state.id, MuestraPing.ts >= desde)
                )
                n, altos, total_n, total_ok = res.one()
                min_muestras = max(2, int(ventana * (60 / BUCKET_S) * 0.6))
                if not n or int(n) < min_muestras:
                    continue
                dispara = False
                detalle = ""
                if regla["tipo"] == "latencia":
                    if int(altos or 0) >= int(n):
                        dispara = True
                        detalle = f"latencia sobre {umbral:.0f} ms durante todo el intervalo de {ventana} min"
                else:
                    total_n = int(total_n or 0)
                    total_ok = int(total_ok or 0)
                    perd = 100.0 * (total_n - total_ok) / max(total_n, 1)
                    if perd >= umbral:
                        dispara = True
                        detalle = f"{perd:.1f}% de pérdida en los últimos {ventana} min (umbral {umbral:.0f}%)"
                if not dispara or self.silencio_activo(state):
                    continue
                if not self.cooldown(state, regla["tipo"], max(ventana * 60, 1800)):
                    continue
                icono = "🐢" if regla["tipo"] == "latencia" else "📉"
                await notificar(
                    f"{icono} {regla['tipo'].upper()}: <b>{state.nombre}</b> ({state.host}) - {detalle}",
                    {"dispositivo": state.nombre, "evento": regla["tipo"], "detalle": detalle},
                )

    async def _slim_hop_scan(self, state: EstadoDevice, db: Any) -> None:
        async with self._sem_tracert:
            hops = await traceroute_host(host_para_tracert(state.host))
        now = datetime.now(timezone.utc)
        asociar_hostnames(hops, self._host_cache)
        await self._resolver_hostnames(hops)
        filas = [
            HopSample(
                device_id=state.id,
                ts=now,
                ttl=int(h["ttl"]),
                ip=h.get("ip"),
                hostname=h.get("hostname"),
                rtt_ms=h.get("rtt_ms"),
                ok=h.get("ok", False),
            )
            for h in hops
        ]
        if filas:
            db.add_all(filas)
        await self._chequear_cambio_ruta(state, db, hops, now)
        if state.outage_abierto:
            await db.execute(
                update(Outage)
                .where(Outage.id == state.outage_abierto)
                .values(hops_snapshot=hops)
            )

    async def _chequear_cambio_ruta(
        self, state: EstadoDevice, db: Any, hops: list[dict[str, Any]], now: datetime
    ) -> None:
        """Compara la ruta actual contra la última conocida y registra el cambio."""
        fp = tuple(h.get("ip") for h in hops)
        if not any(fp):
            return
        if state.ruta_fp is None:
            state.ruta_fp = fp  # línea base: primer escaneo de una sesión limpia
            return
        if fp == state.ruta_fp:
            return
        anterior = state.ruta_fp
        state.ruta_fp = fp
        resumen = "ruta cambiada"
        for i in range(max(len(anterior), len(fp))):
            a = anterior[i] if i < len(anterior) else None
            b = fp[i] if i < len(fp) else None
            if a != b:
                resumen = f"hop {i + 1}: {a or '—'} → {b or '—'}"
                break
        db.add(CambioRuta(device_id=state.id, ts=now, resumen=resumen[:255], hops=hops))
        regla = next((r for r in state.reglas if r["tipo"] == "ruta"), None)
        if regla and not self.silencio_activo(state) and self.cooldown(state, "ruta", max(regla["ventana_min"] * 60, 1800)):
            await notificar(
                f"🛣️ CAMBIO DE RUTA: <b>{state.nombre}</b> ({state.host}) — {resumen}",
                {"dispositivo": state.nombre, "evento": "cambio_ruta", "resumen": resumen},
            )

    async def _resolver_hostnames(self, hops: list[dict[str, Any]]) -> None:
        pendientes = sorted({h["ip"] for h in hops if h.get("ip") and h["ip"] not in self._host_cache})
        if not pendientes:
            return
        import socket

        def _res(ip_addr: str) -> str | None:
            try:
                return socket.gethostbyaddr(ip_addr)[0]
            except (socket.herror, OSError):
                return None

        # DNS en paralelo (antes era secuencial) y persistencia en UNA
        # transacción (antes: sesión + commit por cada IP nueva de un hop)
        loop = asyncio.get_running_loop()
        nombres = await asyncio.gather(
            *(loop.run_in_executor(None, _res, ip) for ip in pendientes)
        )
        self._host_cache.update(zip(pendientes, nombres))
        async with SesionLocal() as db:
            await db.execute(
                pg_insert(HopHost)
                .values(
                    [
                        {"ip": ip, "hostname": nombre}
                        for ip, nombre in zip(pendientes, nombres)
                    ]
                )
                .on_conflict_do_nothing(index_elements=["ip"])
            )
            await db.commit()

    async def _loop_device(self, state: EstadoDevice) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            try:
                await self._loop_ping(state)
            except Exception:
                import traceback

                traceback.print_exc()

    async def _loop_ping(self, state: EstadoDevice) -> None:
        next_hop_scan = 0.0
        sem = self._sem_icmp
        buf: list[dict[str, Any]] = []
        ventana_inicio = time.monotonic()
        with contextlib.suppress(asyncio.CancelledError):
            while True:
                # pausa de supervisión real mientras dure el silencio: sin
                # pings, sin muestras, sin escaneo de ruta ni reglas (el
                # estado en memoria se refresca con la recarga del scheduler)
                if scheduler.silencio_activo(state):
                    if buf:
                        await self._flush_bucket(state, buf)
                        buf = []
                        ventana_inicio = time.monotonic()
                    await asyncio.sleep(15.0)
                    continue
                inicio = time.monotonic()
                resultado = await ejecutar_chequeo(
                    state.host,
                    state.tipo,
                    settings.ping_timeout_ms,
                    sem,
                    state.puerto,
                    state.texto_buscado,
                    state.dns_servidor,
                )
                buf.append(resultado)
                await self._procesar_ping(state, resultado)
                if time.monotonic() - ventana_inicio >= BUCKET_S:
                    await self._flush_bucket(state, buf)
                    buf = []
                    ventana_inicio = time.monotonic()
                    await self._evaluar_reglas(state)
                if state.force_hop or time.monotonic() >= next_hop_scan:
                    state.force_hop = False
                    next_hop_scan = time.monotonic() + state.hop_scan_interval_min * 60
                    async with SesionLocal() as db:
                        await self._slim_hop_scan(state, db)
                        await db.commit()
                espera = state.intervalo_ping_s - (time.monotonic() - inicio)
                await asyncio.sleep(max(espera, 0.05))

    @staticmethod
    async def _flush_bucket(state: EstadoDevice, buf: list[dict[str, Any]]) -> None:
        if not buf:
            return
        n = len(buf)
        ok_n = sum(1 for r in buf if r["ok"])
        rtts = [r["rtt_ms"] for r in buf if r["ok"] and r["rtt_ms"] is not None]
        async with SesionLocal() as db:
            db.add(
                MuestraPing(
                    device_id=state.id,
                    ts=datetime.now(timezone.utc).replace(microsecond=0),
                    rtt_ms=(sum(rtts) / len(rtts)) if rtts else None,
                    ok=ok_n > 0,
                    n=n,
                    ok_n=ok_n,
                    rtt_min_ms=min(rtts) if rtts else None,
                    rtt_max_ms=max(rtts) if rtts else None,
                    rtt_median_ms=_percentil(rtts, 0.5),
                    rtt_p95_ms=_percentil(rtts, 0.95),
                    rtt_std_ms=_desv(rtts),
                )
            )
            await db.commit()

    async def _procesar_ping(self, state: EstadoDevice, resultado: dict[str, Any]) -> None:
        now = resultado["ts"]
        ok = resultado["ok"]
        rtt = resultado["rtt_ms"]
        # pings: el estado vivo (fallos, rtt, degradado) va en memoria y SOLO se
        # toca la BD cuando cambia algo real (abrir/cerrar outage): sin commits
        # vacíos en cada ciclo de sondeo
        if ok:
            state.fallos_consecutivos = 0
            state.ultimo_rtt = rtt
            state.degradado = rtt is not None and rtt > state.umbral_degradado_ms
            outage_id = state.outage_abierto
            if not outage_id:
                return  # ping OK normal: nada que escribir
            state.outage_abierto = None
            async with SesionLocal() as db:
                await db.execute(
                    update(Outage).where(Outage.id == outage_id).values(fin=now)
                )
                await db.flush()
                outage = await db.get(Outage, outage_id)
                durada = (
                    (outage.fin - outage.inicio).total_seconds()
                    if outage and outage.fin
                    else 0
                )
                await db.commit()
            if not scheduler.silencio_activo(state):
                await notificar(
                    f"🟢 RECUPERADO: <b>{state.nombre}</b> ({state.host}) - caída de {durada:.0f}s",
                    {"dispositivo": state.nombre, "evento": "recuperado"},
                )
        else:
            state.fallos_consecutivos += 1
            state.ultimo_rtt = None
            if state.fallos_consecutivos < state.n_fallos_down or state.outage_abierto:
                return  # fallo sin umbral o outage ya abierto: nada que escribir
            nuevo = Outage(device_id=state.id, inicio=now, causa="timeout")
            async with SesionLocal() as db:
                db.add(nuevo)
                await db.flush()
                state.outage_abierto = str(nuevo.id)
                await db.commit()
            await self._hop_scan_urgente(state)
            if not scheduler.silencio_activo(state):
                await notificar(
                    f"🔴 DOWN: <b>{state.nombre}</b> ({state.host}) - {state.fallos_consecutivos} pings fallidos",
                    {"dispositivo": state.nombre, "evento": "down"},
                )

    async def _hop_scan_urgente(self, state: EstadoDevice) -> None:
        start = time.monotonic()
        with contextlib.suppress(Exception):
            async with SesionLocal() as db:
                async with self._sem_tracert:
                    hops = await traceroute_host(host_para_tracert(state.host), timeout_ms=500, max_hops=12)
                asociar_hostnames(hops, self._host_cache)
                if hops and state.outage_abierto:
                    await db.execute(
                        update(Outage)
                        .where(Outage.id == state.outage_abierto)
                        .values(hops_snapshot=hops)
                    )
                filas = [
                    HopSample(
                        device_id=state.id,
                        ts=datetime.now(timezone.utc),
                        ttl=int(h["ttl"]),
                        ip=h.get("ip"),
                        hostname=h.get("hostname"),
                        rtt_ms=h.get("rtt_ms"),
                        ok=h.get("ok", False),
                    )
                    for h in hops
                ]
                if filas:
                    db.add_all(filas)
                await db.commit()


scheduler = SchedulerMono()


async def notificar_cambio() -> None:
    await scheduler.notificar_cambio()


async def reiniciar_estado_device(device_id: str) -> None:
    """Resetea la supervisión en memoria de un dispositivo tras borrar su historial."""
    scheduler.reiniciar_estado(device_id)
    await scheduler.notificar_cambio()


async def correr_scheduler() -> None:
    await scheduler._recargar()
    while True:
        await scheduler._reload_event.wait()
        scheduler._reload_event.clear()
        await scheduler._recargar()


async def detener_scheduler() -> None:
    for t in scheduler.tareas.values():
        t.cancel()
    scheduler.tareas.clear()
    scheduler.estados.clear()
