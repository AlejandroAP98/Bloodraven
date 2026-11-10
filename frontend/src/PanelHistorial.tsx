import { useEffect, useState } from "react";

import { api, calcularStats, fmtHora } from "./api";
import type { Outage, Stats } from "./api";
import { StatGrid } from "./TarjetaStats";
import GraficaLatencia from "./GraficaLatencia";

// resolución según el ancho del rango: la rejilla de la gráfica topa a 2000 slots
function resPara(spanH: number): string {
  if (spanH <= 2) return "raw"; // 240 slots de 30 s
  if (spanH <= 30) return "1m"; // hasta 1800 slots de 1 min
  return "1h"; // histórico largo
}

// ISO local para <input type="datetime-local"> (sin zona, 16 chars)
const aLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function PanelHistorial({
  deviceId,
  outages,
}: {
  deviceId: string;
  outages: Outage[];
}) {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [aplicado, setAplicado] = useState<{ t0: number; t1: number; res: string; puntos: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  // inicio real del historial: primer punto agregado por día existente.
  // (lo resolvemos con muestras 1d: el cap de 24 h de cobertura no limita aquí)
  const inicioHistorial = async (): Promise<number | null> => {
    try {
      const m = await api.muestrasRango(deviceId, 0, Date.now(), "1d");
      if (!m.puntos.length) return null;
      return new Date(m.puntos[0].ts).getTime();
    } catch {
      return null;
    }
  };

  // al abrir el apartado, prellena "todo el historial" con lo que la cobertura conoce
  useEffect(() => {
    let vivo = true;
    (async () => {
      const t0 = await inicioHistorial();
      if (!vivo) return;
      if (t0 != null) {
        setDesde(aLocal(new Date(t0)));
        setHasta(aLocal(new Date()));
      }
    })();
    return () => {
      vivo = false;
    };
  }, [deviceId]);

  const calcular = async (t0ms?: number, t1ms?: number) => {
    setError(null);
    const t0 = t0ms ?? new Date(desde).getTime();
    const t1 = t1ms ?? new Date(hasta).getTime();
    if (!desde && t0ms == null) return setError("Elige la fecha 'desde'.");
    if (!(t1 > t0)) return setError("Rango inválido: 'hasta' debe ser posterior a 'desde'.");
    const ahora = Date.now();
    if (t1 > ahora + 60_000) return setError("'hasta' no puede ser a futuro.");
    if (!deviceId) return;
    setCargando(true);
    try {
      const spanH = (t1 - t0) / 3600e3;
      const res = resPara(spanH);
      const m = await api.muestrasRango(deviceId, t0, t1, res);
      setStats(calcularStats(m.puntos, outages, { t0, t1 }));
      setAplicado({ t0, t1, res, puntos: m.puntos.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCargando(false);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
        métricas por rango · historial del dispositivo
      </h3>
      <div className="flex flex-wrap items-center gap-2 border border-edge bg-panel p-3">
        <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">desde</label>
        <input
          type="datetime-local"
          value={desde}
          onChange={(e) => setDesde(e.target.value)}
          className="border border-edge bg-panel2 px-2 py-1 font-mono text-xs text-fg"
        />
        <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">hasta</label>
        <input
          type="datetime-local"
          value={hasta}
          onChange={(e) => setHasta(e.target.value)}
          className="border border-edge bg-panel2 px-2 py-1 font-mono text-xs text-fg"
        />
        <button
          onClick={() => calcular()}
          disabled={cargando}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-fg transition-colors hover:border-edgehi disabled:opacity-50"
        >
          {cargando ? "Calculando…" : "Calcular métricas"}
        </button>
        <button
          onClick={async () => {
            const t0 = await inicioHistorial();
            if (t0 == null) {
              setError("Aún no hay muestras registradas para este dispositivo.");
              return;
            }
            setDesde(aLocal(new Date(t0)));
            setHasta(aLocal(new Date()));
            await calcular(t0, Date.now());
          }}
          disabled={cargando}
          className="border border-edge px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg disabled:opacity-50"
        >
          Todo el historial
        </button>
        {error && <span className="font-mono text-xs text-crit">{error}</span>}
      </div>

      {aplicado && (
        <p className="font-mono text-[10px] text-mut">
          {fmtHora(new Date(aplicado.t0).toISOString())} → {fmtHora(new Date(aplicado.t1).toISOString())} ·{" "}
          {aplicado.puntos} muestras · resolución {aplicado.res === "raw" ? "30 s" : aplicado.res === "1m" ? "1 min" : "1 h"}
        </p>
      )}

      <StatGrid stats={aplicado ? stats : null} />

      {aplicado && (
        <section className="border border-edge bg-panel p-4">
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
            telemetría del rango seleccionado
          </h3>
          <GraficaLatencia
            deviceId={deviceId}
            outages={outages}
            resolucion={aplicado.res}
            rango={{ desde: aplicado.t0, hasta: aplicado.t1 }}
          />
        </section>
      )}
    </section>
  );
}
