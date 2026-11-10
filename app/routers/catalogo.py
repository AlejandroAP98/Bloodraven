import asyncio
import logging
import uuid
from typing import Any

import ipaddress
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import EquipoRed
from app.schemas import ROLES_RED, EquipoRedIn
from app.workers.dude import MAX_BODY, importar_dude

_log = logging.getLogger("app.catalogo")

def _normaliza_ip(ip: str) -> str:
    try:
        return str(ipaddress.ip_address(ip.strip()))
    except ValueError as e:
        raise HTTPException(400, f"IP inválida: {ip!r} ({e})")


def _out(e: EquipoRed) -> dict[str, Any]:
    return {
        "id": str(e.id),
        "ip": e.ip,
        "nombre": e.nombre,
        "rol": e.rol,
        "notas": e.notas,
        "actualizado_en": e.actualizado_en,
    }


router = APIRouter(prefix="/api/equipos_red", tags=["equipos_red"])


async def get_db() -> AsyncSession:
    from app.database import SesionLocal

    async with SesionLocal() as sesion:
        yield sesion


@router.get("")
async def listar(db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    """Catálogo completo de equipos de red ordenado por IP."""
    res = await db.execute(select(EquipoRed).order_by(EquipoRed.ip))
    return [_out(e) for e in res.scalars().all()]


@router.get("/{ip}")
async def buscar(ip: str, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Devuelve el equipo del catálogo por IP (404 si no está)."""
    res = await db.execute(select(EquipoRed).where(EquipoRed.ip == _normaliza_ip(ip)))
    e = res.scalar_one_or_none()
    if not e:
        raise HTTPException(404, f"La IP {ip} no está en el catálogo")
    return _out(e)


@router.post("", status_code=201)
async def crear(data: EquipoRedIn, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    _log.info("alta en catálogo: %r", data.model_dump())
    try:
        ip = _normaliza_ip(data.ip)
        res = await db.execute(select(EquipoRed).where(EquipoRed.ip == ip))
        if res.scalar_one_or_none():
            raise HTTPException(409, f"La IP {ip} ya está en el catálogo")
        e = EquipoRed(ip=ip, nombre=data.nombre, rol=data.rol, notas=data.notas)
        db.add(e)
        try:
            await db.commit()
        except IntegrityError:
            # doble envío rápido del mismo formulario: el SELECT de arriba pasó y
            # otro INSERT ganó la carrera por la restricción UNIQUE de `ip`
            await db.rollback()
            raise HTTPException(409, f"La IP {ip} ya está en el catálogo")
        await db.refresh(e)
        return _out(e)
    except HTTPException:
        raise
    except Exception:
        _log.exception("alta en catálogo falló: %r", data.model_dump())
        raise


@router.put("/{ip}")
async def actualizar(
    ip: str, data: EquipoRedIn, db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    res = await db.execute(select(EquipoRed).where(EquipoRed.ip == _normaliza_ip(ip)))
    e = res.scalar_one_or_none()
    if not e:
        raise HTTPException(404, f"La IP {ip} no está en el catálogo")
    nueva = _normaliza_ip(data.ip)
    if nueva != e.ip:
        res = await db.execute(select(EquipoRed).where(EquipoRed.ip == nueva))
        if res.scalar_one_or_none():
            raise HTTPException(409, f"La IP {nueva} ya está en el catálogo")
        await db.delete(e)
        await db.flush()
        e = EquipoRed(ip=nueva, nombre=data.nombre, rol=data.rol, notas=data.notas)
        db.add(e)
    else:
        e.nombre = data.nombre
        e.rol = data.rol
        e.notas = data.notas
    try:
        await db.commit()
    except IntegrityError:
        # otra petición insertó/renombró la misma IP a la vez: 409 limpio
        await db.rollback()
        raise HTTPException(409, f"La IP {nueva} ya está en el catálogo")
    await db.refresh(e)
    return _out(e)


@router.delete("/{ip}", status_code=204)
async def eliminar(ip: str, db: AsyncSession = Depends(get_db)) -> None:
    res = await db.execute(select(EquipoRed).where(EquipoRed.ip == _normaliza_ip(ip)))
    e = res.scalar_one_or_none()
    if not e:
        raise HTTPException(404, f"La IP {ip} no está en el catálogo")
    await db.delete(e)
    await db.commit()


@router.post("/exportacion")
async def importar_exportacion(
    request: Request,
    modo: str = "combinar",
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Importa el JSON exportado por este panel desde el botón «exportar catálogo».

    modo=combinar (por omisión): agrega solo las IPs que no están en el catálogo.
    modo=reemplazar: además sobrescribe nombre/rol/notas de las IPs existentes.
    Desajustes del archivo (IP inválida, rol desconocido) se reportan en el
    resumen en vez de abortar el lote completo.
    """
    if modo not in {"combinar", "reemplazar"}:
        raise HTTPException(400, f"modo inválido: {modo!r} (combinar | reemplazar)")

    try:
        documento = await request.json()
        bruto = documento["equipos"]
        if not isinstance(bruto, list):
            raise TypeError("equipos no es una lista")
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, f"JSON inválido (¿es un export de catálogo de Bloodraven?): {e}")

    existentes: dict[str, EquipoRed] = {}
    res = await db.execute(select(EquipoRed))
    for e in res.scalars().all():
        existentes[e.ip] = e

    insertadas: list[EquipoRed] = []
    actualizadas = 0
    omitidas = 0
    ip_invalida = 0
    rol_invalido = 0
    sin_nombre = 0
    por_rol: dict[str, int] = {}
    for e in bruto:
        if not isinstance(e, dict):
            ip_invalida += 1
            continue
        nombre = str(e.get("nombre", "")).strip()
        if not nombre or nombre == "None":
            sin_nombre += 1
            continue
        try:
            ip = _normaliza_ip(str(e.get("ip", "")))
        except HTTPException:
            ip_invalida += 1
            continue
        rol = str(e.get("rol", "")).strip()
        if rol not in ROLES_RED:
            rol_invalido += 1
            continue
        notas_raw = e.get("notas")
        notas = str(notas_raw).strip() or None if notas_raw not in (None, "") else None
        if notas:
            notas = notas[:255]

        hecho = existentes.get(ip)
        if hecho:
            if modo == "reemplazar":
                hecho.nombre = nombre
                hecho.rol = rol
                hecho.notas = notas
                actualizadas += 1
                por_rol[rol] = por_rol.get(rol, 0) + 1
            else:
                omitidas += 1
            continue
        nuevo = EquipoRed(ip=ip, nombre=nombre, rol=rol, notas=notas)
        existentes[ip] = nuevo
        insertadas.append(nuevo)
        por_rol[rol] = por_rol.get(rol, 0) + 1

    db.add_all(insertadas)
    await db.commit()

    return {
        "n_archivo": len(bruto),
        "insertadas": len(insertadas),
        "actualizadas": actualizadas,
        "omitidas": omitidas,
        "ip_invalida": ip_invalida,
        "rol_invalido": rol_invalido,
        "sin_nombre": sin_nombre,
        "por_rol": por_rol,
    }


@router.post("/importado")
async def importar(request: Request, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Importa el XML exportado de The Dude al catálogo.

    Agrega las IPs que NO están catalogadas (si la IP ya existe, prevalece
    lo que tú definiste a mano y se omite). Devuelve un resumen del lote.
    """
    data = await request.body()
    if len(data) > MAX_BODY:
        raise HTTPException(400, "XML demasiado grande (máx 300 MB)")
    if not data.lstrip()[:5].startswith(b"<?xml"):
        raise HTTPException(400, "El archivo no empieza con <?xml (¿es el export de The Dude?)")

    # el parseo es CPU (archivo ~100 MB): fuera del event loop
    lote = await asyncio.get_running_loop().run_in_executor(None, importar_dude, data)
    equipos: list[dict[str, str]] = lote["equipos"]  # type: ignore[assignment]

    existentes: dict[str, EquipoRed] = {}
    res = await db.execute(select(EquipoRed))
    for e in res.scalars().all():
        existentes[e.ip] = e

    insertadas = []
    omitidas = 0
    malas = []
    for e in equipos:
        try:
            ip = _normaliza_ip(e["ip"])
        except HTTPException:
            malas.append(e["ip"])
            continue
        if ip in existentes:
            omitidas += 1
            continue
        existentes[ip] = EquipoRed(ip=ip, nombre=e["nombre"], rol=e["rol"], notas=e.get("notas"))
        insertadas.append(ip)

    db.add_all([existentes[ip] for ip in insertadas])
    await db.commit()

    return {
        "n_xml": lote["n_xml"],
        "insertadas": len(insertadas),
        "omitidas": omitidas,
        "duplicados_xml": lote["duplicados_xml"],
        "sin_ip": lote["sin_ip"],
        "ip_invalida": lote["ip_invalida"],
        "por_rol": lote["por_rol"],
    }
