from datetime import datetime
from typing import Any

from sqlalchemy import Index, Integer, String, text, DateTime, Boolean, Float, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def gen_uuid() -> Any:
    from sqlalchemy import text

    return text("gen_random_uuid()")


class Dispositivo(Base):
    __tablename__ = "dispositivos"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    nombre: Mapped[str] = mapped_column(String(100), unique=True)
    host: Mapped[str] = mapped_column(String(255))
    tipo: Mapped[str] = mapped_column(
        String(10), server_default=text("'icmp'"), default="icmp"
    )
    puerto: Mapped[int | None] = mapped_column(Integer, nullable=True)
    texto_buscado: Mapped[str | None] = mapped_column(String(200), nullable=True)
    dns_servidor: Mapped[str | None] = mapped_column(String(100), nullable=True)
    intervalo_ping_s: Mapped[int] = mapped_column(Integer, server_default=text("30"))
    hop_scan_interval_min: Mapped[int] = mapped_column(Integer, default=10)
    umbral_degradado_ms: Mapped[int] = mapped_column(Integer, default=150)
    n_fallos_down: Mapped[int] = mapped_column(Integer, default=3)
    silencio_hasta: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    activo: Mapped[bool] = mapped_column(Boolean, default=True)
    # topología general: lo marca el usuario; solo el grafo nuevo lo consulta
    en_topologia: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    creado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    outages: Mapped[list["Outage"]] = relationship(
        back_populates="dispositivo",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    reglas: Mapped[list["ReglaAlerta"]] = relationship(
        back_populates="dispositivo",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class MuestraPing(Base):
    __tablename__ = "muestras_ping"
    __table_args__ = (
        Index("idx_muestras_device_ts", "device_id", "ts"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    device_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dispositivos.id", ondelete="CASCADE")
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    rtt_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    ok: Mapped[bool] = mapped_column(Boolean)
    n: Mapped[int | None] = mapped_column(Integer, server_default=text("1"), nullable=True)
    ok_n: Mapped[int | None] = mapped_column(Integer, server_default=text("0"), nullable=True)
    rtt_min_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    rtt_max_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    rtt_median_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    rtt_p95_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    rtt_std_ms: Mapped[float | None] = mapped_column(Float, nullable=True)


class HopSample(Base):
    __tablename__ = "hop_samples"
    __table_args__ = (
        Index("idx_hops_device_ts", "device_id", "ts"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    device_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dispositivos.id", ondelete="CASCADE")
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ttl: Mapped[int] = mapped_column(Integer)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rtt_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    ok: Mapped[bool] = mapped_column(Boolean)


class Outage(Base):
    __tablename__ = "outages"
    __table_args__ = (
        Index("idx_outages_device_inicio", "device_id", "inicio"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    device_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dispositivos.id", ondelete="CASCADE")
    )
    inicio: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    fin: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    causa: Mapped[str] = mapped_column(String(30), default="timeout")
    hops_snapshot: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB, nullable=True
    )

    dispositivo: Mapped[Dispositivo] = relationship(back_populates="outages")


class ReglaAlerta(Base):
    __tablename__ = "reglas_alerta"
    __table_args__ = (
        Index("uq_regla_device_tipo", "device_id", "tipo", unique=True),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    device_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dispositivos.id", ondelete="CASCADE")
    )
    tipo: Mapped[str] = mapped_column(String(20))  # latencia | perdida | ruta
    umbral: Mapped[float] = mapped_column(Float)  # ms (latencia) | % (pérdida)
    ventana_min: Mapped[int] = mapped_column(Integer, default=5)
    activo: Mapped[bool] = mapped_column(Boolean, default=True)

    dispositivo: Mapped[Dispositivo] = relationship(back_populates="reglas")


class CambioRuta(Base):
    __tablename__ = "cambios_ruta"
    __table_args__ = (
        Index("idx_cambios_ruta_device_ts", "device_id", "ts"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    device_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dispositivos.id", ondelete="CASCADE")
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resumen: Mapped[str] = mapped_column(String(255))
    hops: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)


class HopHost(Base):
    __tablename__ = "hop_hosts"

    ip: Mapped[str] = mapped_column(String(45), primary_key=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    resuelto_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class EquipoRed(Base):
    """Catálogo editable de equipos de la red: IP -> nombre/rol declarado por el usuario.
    Tiene prioridad sobre la clasificación inferida del diagnóstico."""

    __tablename__ = "equipos_red"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    ip: Mapped[str] = mapped_column(String(45), unique=True)
    nombre: Mapped[str] = mapped_column(String(100))
    rol: Mapped[str] = mapped_column(String(30), default="otro")
    notas: Mapped[str | None] = mapped_column(String(255), nullable=True)
    actualizado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Agg(Base):
    __abstract__ = True

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=True), nullable=False)
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    n: Mapped[int] = mapped_column(Integer, nullable=False)
    ok_n: Mapped[int] = mapped_column(Integer, nullable=False)
    avg_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    p95_ms: Mapped[float | None] = mapped_column(Float, nullable=True)


class AggMin(Agg):
    __tablename__ = "agg_1min"
    __table_args__ = (
        Index("uq_agg_min", "device_id", "bucket", unique=True),
        Index("idx_agg_min_dev", "device_id", "bucket"),
    )


class AggHora(Agg):
    __tablename__ = "agg_1h"
    __table_args__ = (
        Index("uq_agg_hora", "device_id", "bucket", unique=True),
        Index("idx_agg_hora_dev", "device_id", "bucket"),
    )


class AggDia(Agg):
    __tablename__ = "agg_1d"
    __table_args__ = (
        Index("uq_agg_dia", "device_id", "bucket", unique=True),
        Index("idx_agg_dia_dev", "device_id", "bucket"),
    )


class TopoNodoGuardado(Base):
    """Nodo persistido de la topología general. El grafo entra aquí desde los
    traceroutes de los dispositivos marcados y PERMANECE aunque el dispositivo
    que lo avistó deje de observarse, se desmarque o deje de vigilarse.

    `device_id` marca la entrada que ES un dispositivo registrado en el mapa
    (alta por el usuario): su nombre/host quedan congelados si el dispositivo
    deja de existir en el monitoreo. `dispositivos` lista los dispositivos que
    lo avistaron alguna vez (para el conteo histórico)."""

    __tablename__ = "topologia_nodos"

    ip: Mapped[str] = mapped_column(String(45), primary_key=True)
    nombre: Mapped[str | None] = mapped_column(String(100), nullable=True)
    rol: Mapped[str | None] = mapped_column(String(60), nullable=True)
    device_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    alta: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=True
    )
    vistos: Mapped[int] = mapped_column(Integer, default=0)
    rtt_avg_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    primera: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ultima: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dispositivos: Mapped[list] = mapped_column(JSONB, default=list)


class TopoAristaGuardada(Base):
    """Enlace persistido de la topología general (tramo ttl n-1 → ttl n)."""

    __tablename__ = "topologia_aristas"

    de: Mapped[str] = mapped_column(String(45), primary_key=True)
    a: Mapped[str] = mapped_column(String(45), primary_key=True)
    n_scans: Mapped[int] = mapped_column(Integer, default=0)
    dispositivos_n: Mapped[int] = mapped_column(Integer, default=0)
    delta_avg_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    primera: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ultima: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dispositivos: Mapped[list] = mapped_column(JSONB, default=list)


class CredencialEquipo(Base):
    """Credenciales de acceso a un equipo (MikroTik RouterOS o Ubiquiti
    airMAX/aireOS): usuario + password cifrada con Fernet. La clave vive en
    .env (credencial_clave) o, si no, en el archivo credencial_clave.key que
    el propio sistema genera una vez; la contraseña cifrada NO sale nunca al
    frontend."""

    __tablename__ = "credenciales_equipo"

    ip: Mapped[str] = mapped_column(String(45), primary_key=True)
    usuario: Mapped[str] = mapped_column(String(100))
    # fabricante detectado al validar la credencial contra el equipo:
    # 'mikrotik' | 'ubiquiti'. NULL en credenciales previas (se asume mikrotik
    # hasta que se guarde de nuevo).
    marca: Mapped[str | None] = mapped_column(String(20), nullable=True)
    password_cifrada: Mapped[str] = mapped_column(String(255))
    actualizado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AccionLog(Base):
    """Auditoría de acciones sobre equipos (poe_cycle, reboot): quién, cuándo
    y resultado; sirve para cruzar con las curvas de outage."""

    __tablename__ = "acciones_log"
    __table_args__ = (
        Index("idx_acciones_ip_ts", "ip", "ts"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=gen_uuid()
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ip: Mapped[str] = mapped_column(String(45))
    accion: Mapped[str] = mapped_column(String(30))  # poe_cycle | reboot
    parametros: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    resultado: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
