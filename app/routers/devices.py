import ipaddress
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SesionLocal
from app.models import AggDia, AggHora, AggMin, CambioRuta, Dispositivo, HopSample, MuestraPing, Outage, ReglaAlerta, TopoAristaGuardada, TopoNodoGuardado
from app.schemas import DispositivoIn, DispositivoOut, ReglaIn, SilencioIn, TopologiaIn, dispositivo_out
from app.workers.probes import notificar_cambio, reiniciar_estado_device

router = APIRouter(prefix="/api/devices", tags=["dispositivos"])


async def get_db() -> AsyncSession:
    async with SesionLocal() as sesion:
        yield sesion


@router.get("", response_model=list[DispositivoOut])
async def listar(db: AsyncSession = Depends(get_db)) -> list[DispositivoOut]:
    res = await db.execute(select(Dispositivo).order_by(Dispositivo.nombre))
    return [dispositivo_out(d) for d in res.scalars().all()]


@router.post("", response_model=DispositivoOut, status_code=201)
async def crear(
    data: DispositivoIn, db: AsyncSession = Depends(get_db)
) -> DispositivoOut:
    res = await db.execute(
        select(Dispositivo).where(Dispositivo.nombre == data.nombre)
    )
    if res.scalar_one_or_none():
        raise HTTPException(409, "Ya existe un dispositivo con ese nombre")
    d = Dispositivo(**data.model_dump())
    db.add(d)
    await db.commit()
    await db.refresh(d)
    await notificar_cambio()
    return dispositivo_out(d)


@router.get("/{device_id}", response_model=DispositivoOut)
async def obtener(
    device_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> DispositivoOut:
    d = await db.get(Dispositivo, device_id)
    if not d:
        raise HTTPException(404, "Dispositivo no encontrado")
    return dispositivo_out(d)


@router.put("/{device_id}", response_model=DispositivoOut)
async def actualizar(
    device_id: uuid.UUID,
    data: DispositivoIn,
    db: AsyncSession = Depends(get_db),
) -> DispositivoOut:
    d = await db.get(Dispositivo, device_id)
    if not d:
        raise HTTPException(404, "Dispositivo no encontrado")
    res = await db.execute(
        select(Dispositivo).where(
            Dispositivo.nombre == data.nombre, Dispositivo.id != device_id
        )
    )
    if res.scalar_one_or_none():
        raise HTTPException(409, "Ya existe un dispositivo con ese nombre")
    host_cambio = d.host != data.host
    for campo, valor in data.model_dump().items():
        setattr(d, campo, valor)
    if host_cambio:
        await cerrar_outages_abiertos(db, device_id)
    await db.commit()
    await db.refresh(d)
    await notificar_cambio()
    return dispositivo_out(d)


async def cerrar_outages_abiertos(db: AsyncSession, device_id: uuid.UUID) -> None:
    await db.execute(
        update(Outage)
        .where(Outage.device_id == device_id, Outage.fin.is_(None))
        .values(fin=func.now())
    )


@router.delete("/{device_id}", status_code=204)
async def eliminar(
    device_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> None:
    d = await db.get(Dispositivo, device_id)
    if not d:
        raise HTTPException(404, "Dispositivo no encontrado")
    await db.execute(delete(Outage).where(Outage.device_id == device_id))
    await db.delete(d)
    await db.commit()
    await notificar_cambio()


@router.post("/{device_id}/reiniciar", status_code=204)
async def reiniciar_historial(
    device_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> None:
    """Borra muestras, hops, outages, cambios de ruta y agregados del dispositivo,
    reinicia su estado en memoria y retoma la supervisión desde cero."""
    await _obtener(db, device_id)
    for modelo in (MuestraPing, HopSample, Outage, CambioRuta, AggMin, AggHora, AggDia):
        await db.execute(delete(modelo).where(modelo.device_id == device_id))
    await db.commit()
    await reiniciar_estado_device(str(device_id))


@router.get("/{device_id}/reglas")
async def listar_reglas(
    device_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    await _obtener(db, device_id)
    res = await db.execute(
        select(ReglaAlerta).where(ReglaAlerta.device_id == device_id).order_by(ReglaAlerta.tipo)
    )
    return [
        {
            "id": str(r.id),
            "tipo": r.tipo,
            "umbral": r.umbral,
            "ventana_min": r.ventana_min,
            "activo": r.activo,
        }
        for r in res.scalars().all()
    ]


@router.put("/{device_id}/reglas")
async def guardar_reglas(
    device_id: uuid.UUID,
    reglas: list[ReglaIn],
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Reemplazo completo de las reglas del dispositivo (una por tipo)."""
    await _obtener(db, device_id)
    await db.execute(delete(ReglaAlerta).where(ReglaAlerta.device_id == device_id))
    for r in reglas:
        db.add(ReglaAlerta(device_id=device_id, **r.model_dump()))
    await db.commit()
    await notificar_cambio()
    return await listar_reglas(device_id, db)


@router.post("/{device_id}/silencio")
async def silenciar(
    device_id: uuid.UUID, data: SilencioIn, db: AsyncSession = Depends(get_db)
) -> DispositivoOut:
    d = await _obtener(db, device_id)
    if data.horas <= 0:
        d.silencio_hasta = None
    else:
        d.silencio_hasta = datetime.now(timezone.utc) + timedelta(hours=data.horas)
    await db.commit()
    await db.refresh(d)
    await notificar_cambio()
    return dispositivo_out(d)


@router.put("/{device_id}/topologia")
async def cambiar_topologia(
    device_id: uuid.UUID, data: TopologiaIn, db: AsyncSession = Depends(get_db)
) -> DispositivoOut:
    """Marca (o desmarca) el dispositivo como alimentador de la topología
    general. Al incluirlo, su nodo queda REGISTRADO de forma permanente en el
    grafo (nombre, host, alta): sigue en el mapa aunque deje de observarse,
    se desmarque o luego sea eliminado del monitoreo."""
    d = await _obtener(db, device_id)
    d.en_topologia = data.incluir
    if data.incluir:
        try:
            ip_dev = str(ipaddress.ip_address((d.host or "").strip())).lower()
        except ValueError:
            ip_dev = None  # host por nombre: el nodo llega cuando el traceroute lo aviste
        if ip_dev:
            res = await db.execute(
                select(TopoNodoGuardado).where(TopoNodoGuardado.ip == ip_dev)
            )
            g = res.scalar_one_or_none()
            if g is None:
                db.add(
                    TopoNodoGuardado(
                        ip=ip_dev,
                        nombre=d.nombre,
                        host=d.host,
                        device_id=d.id,
                        dispositivos=[str(d.id)],
                    )
                )
            elif not g.device_id:
                # ya era una ip avistada por hops: se le da identidad de dispositivo
                g.device_id = d.id
                g.host = d.host
                g.dispositivos = sorted(set(g.dispositivos) | {str(d.id)})
    await db.commit()
    await db.refresh(d)
    await notificar_cambio()
    return dispositivo_out(d)


@router.delete("/{device_id}/topologia", status_code=204)
async def quitar_topologia(
    device_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> None:
    """Quita del mapa persistido el nodo del dispositivo (y los enlaces que
    toca su ip). Solo acción manual: la persistencia no lo retira nunca."""
    d = await _obtener(db, device_id)
    d.en_topologia = False
    res = await db.execute(select(TopoNodoGuardado).where(TopoNodoGuardado.device_id == d.id))
    g = res.scalar_one_or_none()
    if g:
        await db.execute(delete(TopoAristaGuardada).where(TopoAristaGuardada.de == g.ip))
        await db.execute(delete(TopoAristaGuardada).where(TopoAristaGuardada.a == g.ip))
        await db.delete(g)
    await db.commit()
    await notificar_cambio()


async def _obtener(db: AsyncSession, device_id: uuid.UUID) -> Dispositivo:
    d = await db.get(Dispositivo, device_id)
    if not d:
        raise HTTPException(404, "Dispositivo no encontrado")
    return d
