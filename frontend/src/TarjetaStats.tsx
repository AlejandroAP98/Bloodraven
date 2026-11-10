import { useEffect, useState } from "react";

import { api, calcularStats } from "./api";
import type { Outage, Stats } from "./api";
import { Ayuda } from "./Ayuda";

const CARDS: { k: keyof Stats; label: string; color: string; desc: string }[] = [
  { k: "media", label: "Media", color: "text-acc", desc: "Latencia promedio de los pings con respuesta en el rango. Sensible a picos puntuales." },
  { k: "mediana", label: "Mediana", color: "text-ok", desc: "Ping mediano del rango: la mitad de las lecturas van por debajo. Menos sensible a picos que la media." },
  { k: "min", label: "Mínima", color: "text-mut", desc: "Latencia del ping más rápido del rango: el piso del enlace." },
  { k: "max", label: "Máxima", color: "text-crit", desc: "Latencia del ping más lento registrado en el rango, picos incluidos." },
  { k: "jitter", label: "Jitter (σ)", color: "text-warn", desc: "Desviación estándar de la latencia: cuánto varía el ping entre lecturas. Jitter bajo = enlace estable." },
  { k: "perdida_pct", label: "Pérdida", color: "text-crit", desc: "Pings sin respuesta en el rango seleccionado, incluyendo el tiempo que el dispositivo estuvo caído." },
  { k: "down_pct", label: "Caído", color: "text-crit", desc: "% del rango seleccionado en el que el dispositivo estuvo sin conexión (outages). Informativo: no se resta de las demás métricas." },
];

// rejilla de métricas reutilizable: cualquier vista que ya calle stats la renderiza
export function StatGrid({ stats }: { stats: Stats | null }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      {CARDS.map((c) => (
        <div key={c.k} className="tick border border-edge bg-panel p-2.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
            <Ayuda texto={c.desc}>{c.label}</Ayuda>
          </div>
          <div className={`mt-1 font-mono text-lg font-semibold leading-none ${color(c, stats)}`}>
            {stats?.[c.k] != null
              ? c.k === "perdida_pct" || c.k === "down_pct"
                ? `${stats[c.k]!.toFixed(1)}%`
                : `${stats[c.k]!.toFixed(1)}ms`
              : "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

function color(c: (typeof CARDS)[number], stats: Stats | null) {
  const v = stats?.[c.k];
  if (v == null) return "text-dim";
  if (v === 0 && (c.k === "perdida_pct" || c.k === "down_pct")) return "text-ok";
  return c.color;
}

export default function TarjetaStats({
  deviceId,
  horas,
  resolucion,
  tick,
  outages = [],
}: {
  deviceId: string;
  horas: number;
  resolucion: string;
  tick: number;
  outages?: Outage[];
}) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const m = await api.muestras(deviceId, horas, resolucion);
        if (vivo) setStats(calcularStats(m.puntos, outages, { horas }));
      } catch {
        if (vivo) setStats(null);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [deviceId, horas, resolucion, tick, outages]);

  return <StatGrid stats={stats} />;
}
