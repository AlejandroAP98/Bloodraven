import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models import Dispositivo


def _sin_nul(dato: str) -> str:
    # Postgres rechaza el carácter NUL (0x00) en texto: si un string
    # con \x00 llega al INSERT, el endpoint responde 500 en vez de 400
    return dato.replace("\x00", "")


class DispositivoIn(BaseModel):
    nombre: str = Field(min_length=1, max_length=100)
    host: str = Field(min_length=1, max_length=255)
    tipo: str = Field(default="icmp", pattern="^(icmp|tcp|http|dns)$")
    puerto: int | None = Field(default=None, ge=1, le=65535)
    texto_buscado: str | None = Field(default=None, max_length=200)
    dns_servidor: str | None = Field(default=None, max_length=100)
    intervalo_ping_s: int = Field(default=30, ge=1, le=3600)
    hop_scan_interval_min: int = Field(default=10, ge=1, le=1440)
    umbral_degradado_ms: int = Field(default=150, ge=10, le=10000)
    n_fallos_down: int = Field(default=3, ge=1, le=30)
    activo: bool = True


class TopologiaIn(BaseModel):
    incluir: bool


class DispositivoOut(BaseModel):
    id: str
    nombre: str
    host: str
    tipo: str
    puerto: int | None
    texto_buscado: str | None
    dns_servidor: str | None
    intervalo_ping_s: int
    hop_scan_interval_min: int
    umbral_degradado_ms: int
    n_fallos_down: int
    silencio_hasta: datetime | None
    activo: bool
    en_topologia: bool
    creado_en: datetime

    model_config = {"from_attributes": True}


ROLES_RED = (
    "gateway local",
    "router/agregador",
    "switch",
    "radio/antena",
    "celda",
    "borde público",
    "cámara",
    "DVR",
    "PC",
    "servidor",
    "equipo objetivo",
    "otro",
)


class EquipoRedIn(BaseModel):
    ip: str = Field(min_length=7, max_length=45)
    nombre: str = Field(min_length=1, max_length=100)
    rol: str = Field(pattern="^(" + "|".join(ROLES_RED) + ")$")
    notas: str | None = Field(default=None, max_length=255)

    # nombre/notas también pueden venir de firmas de banner del sondeo: sanear
    @field_validator("nombre", "notas")
    @classmethod
    def sin_nul(cls, dato: str | None) -> str | None:
        if isinstance(dato, str):
            return _sin_nul(dato)
        return dato

class EquipoRedOut(BaseModel):
    id: str
    ip: str
    nombre: str
    rol: str
    notas: str | None
    actualizado_en: datetime


class ReglaIn(BaseModel):
    tipo: str = Field(pattern="^(latencia|perdida|ruta)$")
    umbral: float = Field(gt=0, le=100000)
    ventana_min: int = Field(default=5, ge=1, le=720)
    activo: bool = True


class SilencioIn(BaseModel):
    horas: int = Field(ge=0, le=720)


def dispositivo_out(d: Dispositivo) -> DispositivoOut:
    return DispositivoOut(
        id=str(d.id),
        nombre=d.nombre,
        host=d.host,
        tipo=d.tipo or "icmp",
        puerto=d.puerto,
        texto_buscado=d.texto_buscado,
        dns_servidor=d.dns_servidor,
        intervalo_ping_s=d.intervalo_ping_s,
        hop_scan_interval_min=d.hop_scan_interval_min,
        umbral_degradado_ms=d.umbral_degradado_ms,
        n_fallos_down=d.n_fallos_down,
        silencio_hasta=d.silencio_hasta,
        activo=d.activo,
        en_topologia=bool(d.en_topologia),
        creado_en=d.creado_en,
    )
