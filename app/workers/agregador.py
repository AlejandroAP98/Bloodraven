from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app.config import get_settings
from app.database import SesionLocal

settings = get_settings()
UTC = timezone.utc

# buckets de minuto solo se forman con muestras cerradas: DO NOTHING basta.
# hora y día se RE-agregan (DO UPDATE): la pasada incremental recalcula la
# hora/día parciales con los últimos minutos, y la nocturna completa las deja
# definitivas. p95 guarda max(rtt_p95_ms) de los slots de menor escala.
SQL_MIN = text("""
INSERT INTO agg_1min (device_id, bucket, n, ok_n, avg_ms, min_ms, max_ms, p95_ms)
SELECT device_id,
       to_timestamp(floor(extract(epoch FROM ts) / 60) * 60) AS bucket,
       count(*),
       sum(CASE WHEN ok THEN 1 ELSE 0 END),
       (sum(rtt_ms * n) / sum(n))::float8, min(rtt_ms), max(rtt_ms), max(rtt_p95_ms)
FROM muestras_ping
WHERE ts >= :limite_inf AND ts < :limite_sup
GROUP BY 1, 2
ON CONFLICT (device_id, bucket) DO UPDATE SET
    n = excluded.n, ok_n = excluded.ok_n, avg_ms = excluded.avg_ms,
    min_ms = excluded.min_ms, max_ms = excluded.max_ms, p95_ms = excluded.p95_ms
""")

SQL_HORA = text("""
INSERT INTO agg_1h (device_id, bucket, n, ok_n, avg_ms, min_ms, max_ms, p95_ms)
SELECT device_id,
       to_timestamp(floor(extract(epoch FROM bucket) / 3600) * 3600) AS bucket,
       sum(n), sum(ok_n),
       (sum(avg_ms * n) / sum(n))::float8, min(min_ms), max(max_ms), max(p95_ms)
FROM agg_1min
WHERE bucket >= :limite_inf AND bucket < :limite_sup
GROUP BY 1, 2
ON CONFLICT (device_id, bucket) DO UPDATE SET
    n = excluded.n, ok_n = excluded.ok_n, avg_ms = excluded.avg_ms,
    min_ms = excluded.min_ms, max_ms = excluded.max_ms, p95_ms = excluded.p95_ms
""")

SQL_DIA = text("""
INSERT INTO agg_1d (device_id, bucket, n, ok_n, avg_ms, min_ms, max_ms, p95_ms)
SELECT device_id,
       to_timestamp(floor(extract(epoch FROM bucket) / 86400) * 86400) AS bucket,
       sum(n), sum(ok_n),
       (sum(avg_ms * n) / sum(n))::float8, min(min_ms), max(max_ms), max(p95_ms)
FROM agg_1h
WHERE bucket >= :limite_inf AND bucket < :limite_sup
GROUP BY 1, 2
ON CONFLICT (device_id, bucket) DO UPDATE SET
    n = excluded.n, ok_n = excluded.ok_n, avg_ms = excluded.avg_ms,
    min_ms = excluded.min_ms, max_ms = excluded.max_ms, p95_ms = excluded.p95_ms
""")

SQL_PURGAR_RAW = text("""
DELETE FROM muestras_ping WHERE ts < :corte
""")

SQL_PURGAR_HOPS = text("""
DELETE FROM hop_samples WHERE ts < :corte
""")

SQL_PURGAR_MIN = text("""
DELETE FROM agg_1min WHERE bucket < :corte
""")

# modo incremental: ventana corta — repone los últimos minutos y deja
# las agg listas "hasta hace un minuto" para que samples(1m/1h/1d) las lea
_INCREMENTAL: list[tuple[text, timedelta]] = [
    (SQL_MIN, timedelta(minutes=20)),
    (SQL_HORA, timedelta(hours=3)),
    (SQL_DIA, timedelta(days=2)),
]

# pasada completa nocturna (ventanas originales, backstop de faltantes)
_COMPLETA: list[tuple[text, timedelta]] = [
    (SQL_MIN, timedelta(days=2)),
    (SQL_HORA, timedelta(days=8)),
    (SQL_DIA, timedelta(days=60)),
]


async def consolidar(incremental: bool = False) -> None:
    """Agrega muestras → agg_1min → agg_1h → agg_1d y purga con la retención.

    `incremental` corre cada minuto (ventanas cortas, sin purga);
    la pasada completa se ejecuta cada noche y incluye la purga.
    """
    try:
        async with SesionLocal() as db:
            ahora = datetime.now(UTC)
            sup_min = ahora.replace(second=0, microsecond=0) - timedelta(minutes=1)
            sup_hora = ahora.replace(minute=0, second=0, microsecond=0)
            sup_dia = ahora.replace(hour=0, minute=0, second=0, microsecond=0)

            por_paso = _INCREMENTAL if incremental else _COMPLETA
            sups = (sup_min, sup_hora, sup_dia)
            for idx, (sql, ventana) in enumerate(por_paso):
                sup = sups[idx]
                await db.execute(sql, {"limite_inf": sup - ventana, "limite_sup": sup})

            if not incremental:
                corte_raw = ahora - timedelta(days=settings.retencion_raw_dias)
                corte_min = ahora - timedelta(days=settings.retencion_1min_dias)
                await db.execute(SQL_PURGAR_RAW, {"corte": corte_raw})
                await db.execute(SQL_PURGAR_HOPS, {"corte": ahora - timedelta(days=30)})
                await db.execute(SQL_PURGAR_MIN, {"corte": corte_min})
            await db.commit()
    except Exception:
        import traceback

        traceback.print_exc()
