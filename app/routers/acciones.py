"""Acciones sobre equipos (despacho por marca de la credencial): credenciales
por equipo (cifradas con Fernet), ficha informativa, ciclo PoE y reinicio en
MikroTik; ficha y reinicio en Ubiquiti airMAX (aireOS) por SSH.

La marca se detecta al guardar la credencial (RouterOS REST/API primero, SSH
aireOS como alternativa) y se guarda en credenciales_equipo.marca. Las
destructivas (poe_cycle, reboot) exigen confirmar=true; antes de ejecutarlas
calculan los dispositivos afectados (el propio equipo y los que lo tienen como
hop reciente) y aplican el silencio de silencio_hasta para no pintar falsos
outages. Toda acción queda en acciones_log."""

import asyncio
import ipaddress
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.credenciales import cifrar, descifrar
from app.models import AccionLog, CredencialEquipo, Dispositivo, HopSample
from app.routers.datos import _host_a_ip
from app.routers.devices import get_db
from app.workers.mikrotik import (
    CaminoInexistente,
    CredencialInvalida,
    EquipoNoAccesible,
    comando_puntual,
    ficha as ficha_mikrotik,
    leer_coleccion,
    limpiar as limpiar_mikrotik,
    poe_cycle,
    poe_menu,
    reboot as reboot_mikrotik,
)
from app.workers.ubiquiti import (
    ficha as ficha_ubiquiti,
    limpiar as limpiar_ubiquiti,
    reboot as reboot_ubiquiti,
    wireless as wireless_ubiquiti,
)


async def _limpiar_equipo(ip: str) -> None:
    """Sesiones y cache de lecturas de la ip: credencial cambiada o borrada."""
    await limpiar_mikrotik(ip)
    await limpiar_ubiquiti(ip)

router = APIRouter(prefix="/api/acciones", tags=["acciones"])

# acción mayormente destructiva → ventana de reintegro del silencio (min)
_SILENCIO_MIN = {"poe_cycle": 10, "reboot": 15}
# exclusión mutua por equipo: pocas colas simultáneas hacia la misma ip
_bloqueos: dict[str, asyncio.Lock] = {}
# récord de la última acción aplicada por ip: golpee-airbag anti doble clic
_ultima_accion: dict[str, float] = {}
_RE_ID_PUERTO = re.compile(r"^\*?[0-9A-Fa-f]{1,8}$")
_RE_NOMBRE_PUERTO = re.compile(r"^[A-Za-z0-9_.\-]{1,32}$")


async def _credencial(db: AsyncSession, ip: str) -> tuple[str, str, str]:
    """(usuario, password, marca) de la credencial guardada; 404 si no hay.
    Credenciales previas a la marca se asumen mikrotik: la marca se fija
    de nuevo al guardar la credencial (validación contra el equipo)."""
    res = await db.execute(select(CredencialEquipo).where(CredencialEquipo.ip == ip))
    cred = res.scalars().first()
    if cred is None:
        raise HTTPException(404, f"sin credencial guardada para {ip}: regístrala en el panel")
    try:
        return cred.usuario, descifrar(cred.password_cifrada), cred.marca or "mikrotik"
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


def _valida_ip(ip: str) -> str:
    try:
        return str(ipaddress.ip_address(ip.strip()))
    except ValueError:
        raise HTTPException(400, "ip inválida")


def _normaliza_error(exc: Exception) -> HTTPException:
    if isinstance(exc, CaminoInexistente):
        return HTTPException(404, f"el equipo no tiene ese menú: {exc}")
    if isinstance(exc, CredencialInvalida):
        return HTTPException(502, f"el equipo rechazó las credenciales: {exc}")
    if isinstance(exc, EquipoNoAccesible):
        return HTTPException(502, f"equipo no accesible: {exc}")
    return HTTPException(502, f"acción falló: {exc}")


async def _afectados(db: AsyncSession, ip: str) -> list[dict[str, Any]]:
    """Dispositivos cuyo servicio puede interrumpirse: el propio equipo
    (host == ip) y los que lo avistaron como hop en su ruta reciente """
    res = await db.execute(select(Dispositivo.id, Dispositivo.nombre, Dispositivo.host))
    nombres: dict[str, str] = {}
    ids: set[str] = set()
    for did, nombre, host in res.all():
        nombres[did] = nombre
        if _host_a_ip(host) == ip:
            ids.add(did)
    frm = datetime.now(timezone.utc) - timedelta(hours=24)
    resh = await db.execute(
        select(HopSample.device_id).where(HopSample.ip == ip, HopSample.ts >= frm).distinct()
    )
    for (did,) in resh.all():
        if did in nombres:
            ids.add(did)
    return [{"id": d, "nombre": nombres[d]} for d in sorted(ids, key=lambda x: nombres.get(x, ""))]


async def _silenciar(db: AsyncSession, afectados: list[dict[str, Any]], minutos: int) -> list[dict[str, Any]]:
    if not afectados:
        return []
    hasta = datetime.now(timezone.utc) + timedelta(minutes=minutos)
    for a in afectados:
        await db.execute(
            update(Dispositivo)
            .where(Dispositivo.id == a["id"])
            .values(silencio_hasta=hasta)
        )
    await db.commit()
    return [{"id": a["id"], "nombre": a["nombre"], "silencio_hasta": hasta.isoformat()} for a in afectados]


async def _registrar(
    db: AsyncSession,
    ip: str,
    accion: str,
    parametros: dict[str, Any] | None,
    resultado: str | None,
    ok: bool,
) -> None:
    db.add(AccionLog(ip=ip, accion=accion, parametros=parametros, resultado=(resultado or "")[:255], ok=ok))
    await db.commit()


# ------------------------------------------------------------ credenciales

@router.get("/{ip}/credencial")
async def credencial_estado(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    ip = _valida_ip(ip)
    res = await db.execute(select(CredencialEquipo).where(CredencialEquipo.ip == ip))
    cred = res.scalars().first()
    return {
        "ip": ip,
        "existe": cred is not None,
        "usuario": cred.usuario if cred else None,
        "marca": cred.marca if cred else None,
    }


@router.put("/{ip}/credencial")
async def guardar_credencial(ip: str, datos: dict[str, Any], db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Guarda la credencial tras validarla de verdad contra el equipo (solo
    lectura de la ficha: ninguna acción destructiva en la validación). Detecta
    la marca: RouterOS REST/API primero; si en esa IP no vive un MikroTik,
    prueba SSH (airMAX/aireOS)."""
    ip = _valida_ip(ip)
    usuario = str(datos.get("usuario") or "").strip()
    password = str(datos.get("password") or "")
    if not usuario:
        # la contraseña puede quedar VACÍA: hay equipos sin password (mala
        # práctica, pero reales) — el login va con password en blanco
        raise HTTPException(400, "usuario requerido (la contraseña puede quedar vacía)")
    marca: str
    try:
        f = await ficha_mikrotik(ip, usuario, password)
        marca = "mikrotik"
    except (CredencialInvalida,) as e:
        raise HTTPException(401, f"el equipo rechazó las credenciales ({e})")
    except EquipoNoAccesible as e_mt:
        # no hay RouterOS al otro lado: probar la familia aireOS (SSH)
        try:
            f = await ficha_ubiquiti(ip, usuario, password)
            marca = "ubiquiti"
        except (CredencialInvalida,) as e_u:
            raise HTTPException(401, f"el equipo rechazó las credenciales ({e_u})")
        except EquipoNoAccesible as e_u:
            raise HTTPException(
                502,
                f"equipo no accesible (RouterOS: {e_mt} · SSH aireOS: {e_u})",
            )

    res = await db.execute(select(CredencialEquipo).where(CredencialEquipo.ip == ip))
    cred = res.scalars().first()
    if cred is None:
        cred = CredencialEquipo(ip=ip, usuario=usuario, password_cifrada=cifrar(password), marca=marca)
        db.add(cred)
    else:
        cred.usuario = usuario
        cred.password_cifrada = cifrar(password)
        cred.marca = marca
    await db.commit()
    await _registrar(db, ip, "credencial", None, f"credencial guardada ({marca}, transporte {f.get('transporte')})", True)
    # sesiones/caches de la ip se sueltan: la credencial pudo cambiar
    await _limpiar_equipo(ip)
    return {
        "ok": True,
        "ip": ip,
        "usuario": usuario,
        "marca": marca,
        "transporte": f.get("transporte"),
        "version": f.get("version"),
    }


@router.delete("/{ip}/credencial")
async def borrar_credencial(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    ip = _valida_ip(ip)
    res = await db.execute(select(CredencialEquipo).where(CredencialEquipo.ip == ip))
    cred = res.scalars().first()
    if cred is None:
        raise HTTPException(404, "no había credencial para esta ip")
    await db.delete(cred)
    await db.commit()
    await _registrar(db, ip, "credencial_borrada", None, None, True)
    await _limpiar_equipo(ip)
    return {"ok": True}


# -------------------------------------------------------------- ficha / poe

@router.get("/{ip}/info")
async def info(
    ip: str, forzar: bool = False, db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """Ficha del equipo según su marca: MikroTik (identity, versión, board,
    serie, firmware, salud + puertos PoE) o Ubiquiti airMAX (version, board,
    señal, CCQ, estaciones). forzar=1 salta la memoria de 20 s (el ⟳ del
    panel la usa para reconsultar al equipo de verdad)."""
    ip = _valida_ip(ip)
    usuario, password, marca = await _credencial(db, ip)
    try:
        if marca == "ubiquiti":
            f = await ficha_ubiquiti(ip, usuario, password, forzar=forzar)
            return {
                "ip": ip,
                "marca": marca,
                "ficha": f,
                "poe_puertos": [],
                "poe_menu_existe": False,
            }
        f = await ficha_mikrotik(ip, usuario, password, forzar=forzar)
        puertos, existe = await poe_menu(ip, usuario, password, forzar=forzar)
    except Exception as e:
        raise _normaliza_error(e)
    return {"ip": ip, "marca": "mikrotik", "ficha": f, "poe_puertos": puertos, "poe_menu_existe": existe}


@router.get("/{ip}/afectados")
async def afectados(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Dispositivos que pueden quedarse sin camino si se actúa sobre esta ip
    (el propio equipo y los que la avistaron como hop reciente). Lectura de
    BD; no contacta al equipo."""
    ip = _valida_ip(ip)
    lista = await _afectados(db, ip)
    return {"ip": ip, "afectados": lista}


@router.get("/{ip}/log")
async def log(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    ip = _valida_ip(ip)
    res = await db.execute(
        select(AccionLog).where(AccionLog.ip == ip).order_by(AccionLog.ts.desc()).limit(20)
    )
    return {
        "ip": ip,
        "acciones": [
            {
                "ts": a.ts.isoformat(),
                "accion": a.accion,
                "parametros": a.parametros,
                "resultado": a.resultado,
                "ok": a.ok,
            }
            for a in res.scalars().all()
        ],
    }


# ---------------------------------------------------------- lecturas del panel

def _fila_limpia(fila: dict[str, Any], campos: tuple[str, ...]) -> dict[str, Any]:
    """Imprime numérico (monitor) en bools de trabajo."""
    salida = {}
    for c in campos:
        v = fila.get(c)
        if isinstance(v, str) and v.lower() in ("true", "false"):
            salida[c] = v.lower() == "true"
        else:
            salida[c] = v
    return salida


def _anidado(d: dict[str, Any], *rutas: tuple[str, ...]) -> str | None:
    """Extrae un valor probando varias rutas (planas o anidadas, p.ej. la wifi
    v7 guarda el ssid en configuration.ssid). Devuelve str o None."""
    for ruta in rutas:
        v: Any = d
        ok = True
        for k in ruta:
            if isinstance(v, dict) and k in v:
                v = v[k]
            else:
                ok = False
                break
        if ok and v not in (None, ""):
            return v if isinstance(v, str) else str(v)
    return None


@router.get("/{ip}/wireless")
async def wireless(ip: str, forzar: bool = False, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Clientes conectados al radio (registration-table), radios (ssid
    configurado por wlan) e instantánea del canal (frecuencia).
    Autodetecta el esquema: wireless clásico (pre 7.13) o wifi (7.13+).
    forzar=1 salta la memoria de 20 s (el ⟳ del panel)."""
    ip = _valida_ip(ip)
    usuario, password, marca = await _credencial(db, ip)
    if marca == "ubiquiti":
        # aireOS: wstalist (equivalente de registration-table) vía SSH
        return await wireless_ubiquiti(ip, usuario, password, forzar=forzar)
    if marca != "mikrotik":
        raise HTTPException(400, "esta lectura solo está disponible en equipos mikrotik")
    esquema = "nada"
    registros: list[dict[str, Any]] = []
    canal: dict[str, Any] | None = None
    radios: list[dict[str, Any]] = []
    # traducciones exactas de los traps de "menú no existe" por esquema: sirve
    # para diagnosticar placas con variantes del paquete wireless (wireless-fp)
    motivos: list[str] = []
    try:
        for esq, rlist, rtabla, rmon in (
            (
                "classic",
                "interface/wireless",
                "interface/wireless/registration-table",
                "interface/wireless/monitor",
            ),
            (
                "classic-fp",
                "interface/wireless-fp",
                "interface/wireless-fp/registration-table",
                "interface/wireless-fp/monitor",
            ),
            (
                "wifi-v7",
                "interface/wifi",
                "interface/wifi/registration-table",
                "interface/wifi/monitor",
            ),
        ):
            try:
                registros = await leer_coleccion(ip, usuario, password, rtabla)
            except CaminoInexistente as exc:
                motivos.append(str(exc))
                continue  # este equipo no tiene ese menú: probar el siguiente
            esquema = esq

            # radios configurados: ssid de cada wlan del equipo, estado
            try:
                radio_filas = await leer_coleccion(ip, usuario, password, rlist)
            except (CaminoInexistente, EquipoNoAccesible, CredencialInvalida):
                radio_filas = []
            radios = [
                {
                    "nombre": str(f.get("name", "") or ""),
                    "ssid": _anidado(f, ("ssid",), ("configuration", "ssid")),
                    "banda": _anidado(f, ("band",), ("configuration", "configuration-mode")),
                    "corriendo": str(f.get("running", "") or "").lower() == "true",
                    "deshabilitada": str(f.get("disabled", "") or "").lower() == "true",
                }
                for f in radio_filas
            ]

            # instantánea del canal: probamos el nombre real de la interfaz (un
            # "0" genérico a veces no cuela por REST) y contamos con el ssid del
            # canal si el monitor lo trae
            numero = str(registros[0].get("interface", "") or "0") if registros else "0"
            try:
                mon = await comando_puntual(ip, usuario, password, rmon, {"once": "", "numbers": numero})
                canal = next((f for f in mon if isinstance(f, dict)), None)
            except (CaminoInexistente, EquipoNoAccesible, CredencialInvalida):
                pass  # canal complementario: sin él se muestra la tabla igual
            break
    except Exception as e:
        raise _normaliza_error(e)
    detalle = " · ".join(motivos) if (esquema == "nada" and motivos) else None
    return {
        "ip": ip,
        "esquema": esquema,
        "registros": registros,
        "canal": canal,
        "radios": radios,
        "detalle": detalle,
    }


@router.get("/{ip}/interfaces")
async def interfaces(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Interfaces con estado, y una instantánea del monitor de ethernet
    (velocidad de enlace, SFP rx/tx) fusionada a cada puerto."""
    ip = _valida_ip(ip)
    usuario, password, marca = await _credencial(db, ip)
    if marca != "mikrotik":
        raise HTTPException(400, "esta lectura solo está disponible en equipos mikrotik")
    try:
        filas = await leer_coleccion(ip, usuario, password, "interface")
    except Exception as e:
        raise _normaliza_error(e)
    out = [
        {
            "id": str(f.get(".id", "") or ""),
            "nombre": str(f.get("name", "") or ""),
            "tipo": str(f.get("type", "") or ""),
            "corriendo": str(f.get("running", "") or "").lower() == "true",
            "deshabilitada": str(f.get("disabled", "") or "").lower() == "true",
            "mtu": str(f.get("actual-mtu", "") or f.get("mtu", "") or "") or None,
            "mac": str(f.get("mac-address", "") or "") or None,
        }
        for f in filas
    ]
    nombres_ether = [d["nombre"] for d in out if d["tipo"] == "ether"]
    if nombres_ether:
        try:
            mon = await comando_puntual(
                ip,
                usuario,
                password,
                "interface/ethernet/monitor",
                {"once": "", "numbers": ",".join(nombres_ether)},
            )
            por_nombre = {str(m.get("name", "")): m for m in mon if isinstance(m, dict)}
            for d in out:
                m = por_nombre.get(d["nombre"])
                if m:
                    d.update(_fila_limpia(m, ("rate", "full-duplex", "sfp-rx-power", "sfp-tx-power", "sfp-rx-loss")))
        except (EquipoNoAccesible, CredencialInvalida):
            pass  # sin instantánea, la lista de interfaces sigue útil
    return {"ip": ip, "interfaces": out}


@router.get("/{ip}/red")
async def red(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Resumen de red del equipo: leases DHCP (con nombre y mac), direcciones
    propias, colas simple y (si se puede) el conteo de conexiones del firewall.
    Solo lectura; números acotados para no agotar el equipo."""
    ip = _valida_ip(ip)
    usuario, password, marca = await _credencial(db, ip)
    if marca != "mikrotik":
        raise HTTPException(400, "esta lectura solo está disponible en equipos mikrotik")

    async def seccion(ruta: str) -> list[dict[str, Any]] | None:
        try:
            return await leer_coleccion(ip, usuario, password, ruta)
        except CaminoInexistente:
            return None

    try:
        leases, direcciones, colas = await asyncio.gather(
            seccion("ip/dhcp-server/lease"),
            seccion("ip/address"),
            seccion("queue/simple"),
        )
        conexiones_n: int | None = None
        try:
            filas = await comando_puntual(
                ip, usuario, password, "ip/firewall/connection/print", {"count-only": ""}
            )
            for f in filas:
                if isinstance(f, dict) and "ret" in f:
                    try:
                        conexiones_n = int(float(str(f["ret"])))
                        break
                    except (TypeError, ValueError):
                        pass
        except (CaminoInexistente, EquipoNoAccesible, CredencialInvalida):
            pass  # el conteo es opcional
    except Exception as e:
        raise _normaliza_error(e)
    return {
        "ip": ip,
        "leases": (leases or [])[:200],
        "direcciones": (direcciones or [])[:50],
        "colas": (colas or [])[:100],
        "conexiones_n": conexiones_n,
    }


@router.get("/{ip}/log_router")
async def log_router(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Últimas ~50 líneas del log interno del RouterOS (no confundir con la
    bitácora de acciones del módulo)."""
    ip = _valida_ip(ip)
    usuario, password, marca = await _credencial(db, ip)
    if marca != "mikrotik":
        raise HTTPException(400, "esta lectura solo está disponible en equipos mikrotik")
    try:
        filas = await leer_coleccion(ip, usuario, password, "log")
    except Exception as e:
        raise _normaliza_error(e)
    lineas = [
        {
            "hora": str(f.get("time", "") or "") or None,
            "temas": f.get("topics"),
            "mensaje": str(f.get("message", "") or "") or None,
        }
        for f in list(reversed(filas))[:50]
    ]
    return {"ip": ip, "lineas": lineas}


# --------------------------------------------------------------- destructivas

@router.post("/{ip}/poe_cycle")
async def ciclo_poe(ip: str, datos: dict[str, Any], db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Power-cycle del PoE de un puerto: corta el dispositivo conectado el
    tiempo de su reinicio. Requiere confirmar=true (la UI pide escribir el
    nombre del puerto); silencia las alertas de los afectados."""
    return await _ejecutar(db, ip, "poe_cycle", datos)


@router.post("/{ip}/reboot")
async def reinicio(ip: str, datos: dict[str, Any], db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Reinicia el equipo (2-4 min). Requiere confirmar=true."""
    return await _ejecutar(db, ip, "reboot", datos)


async def _ejecutar(db: AsyncSession, ip: str, accion: str, datos: dict[str, Any]) -> dict[str, Any]:
    ip = _valida_ip(ip)
    if datos.get("confirmar") is not True:
        raise HTTPException(400, f"{accion} requiere confirmar=true (acción interrumpida de servicio)")

    usuario, password, marca = await _credencial(db, ip)
    puerto = str(datos.get("puerto") or "").strip()
    silenciar = datos.get("silenciar", True) is not False

    if accion == "poe_cycle" and marca != "mikrotik":
        raise HTTPException(400, "poe_cycle solo aplica a equipos mikrotik (esta ip quedó registrada como ubiquiti)")

    lock = _bloqueos.setdefault(ip, asyncio.Lock())
    if lock.locked():
        raise HTTPException(409, f"ya hay una acción en curso sobre {ip}")

    import time as _time

    if _time.monotonic() - _ultima_accion.get(ip, 0.0) < 60:
        transcurrido = int(60 - (_time.monotonic() - _ultima_accion[ip]))
        raise HTTPException(429, f"una acción acaba de ejecutarse; espera {transcurrido} s")

    async with lock:
        fila: dict[str, Any] | None = None
        if accion == "poe_cycle":
            if not _RE_NOMBRE_PUERTO.match(puerto):
                raise HTTPException(400, "nombre de puerto inválido (ej. ether5, sfp-sfpplus1)")
            try:
                puertos, existe = await poe_menu(ip, usuario, password)
            except Exception as e:
                raise _normaliza_error(e)
            fila = next((p for p in puertos if p["nombre"] == puerto), None)
            if fila is None:
                raise HTTPException(
                    404,
                    f"el equipo no tiene un puerto PoE llamado «{puerto}»"
                    + ("" if existe else " (el menú poe no existe en este equipo)"),
                )
            duracion = int(datos.get("duracion", 5))
            if not 1 <= duracion <= 30:
                raise HTTPException(400, "duracion fuera de rango (1..30 s)")
        else:
            duracion = 0

        afectados = await _afectados(db, ip)
        silenciados = await _silenciar(db, afectados, _SILENCIO_MIN[accion]) if silenciar else []

        try:
            if accion == "poe_cycle":
                resultado = await poe_cycle(ip, usuario, password, fila["id"], duracion)
            elif marca == "ubiquiti":
                resultado = await reboot_ubiquiti(ip, usuario, password)
            else:
                resultado = await reboot_mikrotik(ip, usuario, password)
        except Exception as e:
            await _registrar(
                db,
                ip,
                accion,
                {"puerto": puerto, "duracion": duracion, "transporte": None},
                str(e)[:255],
                False,
            )
            raise _normaliza_error(e)

        _ultima_accion[ip] = _time.monotonic()
        await _registrar(
            db,
            ip,
            accion,
            {"puerto": puerto, "duracion": duracion, "transporte": resultado.get("transporte")},
            resultado.get("detalle"),
            True,
        )
        return {
            "ok": True,
            "ip": ip,
            "accion": accion,
            "resultado": resultado.get("detalle"),
            "transporte": resultado.get("transporte"),
            "silenciados": silenciados,
            "en_ruta_de": [a["nombre"] for a in afectados],
        }