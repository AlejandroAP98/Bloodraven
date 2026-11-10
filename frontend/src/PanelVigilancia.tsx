import { useEffect, useState } from "react";

import { api, fmtDur, fmtHora } from "./api";
import type { Cobertura } from "./api";
import { Ayuda } from "./Ayuda";

// refresco propio de 60s: los datos de vigilancia cambian lento
const REFRESCO_MS = 60_000;

function Lectura({ label, desc, valor, color }: { label: string; desc: string; valor: string; color: string }) {
  return (
    <div className="tick border border-edge bg-panel p-2.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
        <Ayuda texto={desc}>{label}</Ayuda>
      </div>
      <div className={`mt-1 font-mono text-lg font-semibold leading-none ${color}`}>{valor}</div>
    </div>
  );
}

function colorEstado(pct: number) {
  if (pct >= 99) return "text-ok";
  if (pct >= 95) return "text-warn";
  return "text-crit";
}

export default function PanelVigilancia({
  deviceId,
  horas,
  etiqueta,
  tick,
}: {
  deviceId: string;
  horas: number;
  etiqueta: string;
  tick: number;
}) {
  const [cov, setCov] = useState<Cobertura | null>(null);

  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const c = await api.cobertura(deviceId, horas);
        if (vivo) setCov(c);
      } catch {
        if (vivo) setCov(null);
      }
    };
    cargar();
    const t = setInterval(cargar, REFRESCO_MS);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [deviceId, horas, Math.floor(tick / 12)]);

  const dispo = cov?.disponibilidad_pct;
  const cobertura = cov?.cobertura_pct;
  const degradadoMin = cov ? cov.degradado_s / 60 : null;

  return (
    <section className="space-y-2">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">vigilancia · {etiqueta}</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Lectura
          label="vigilado desde"
          desc="Primer ping con respuesta que se tiene registrado para este dispositivo."
          valor={cov?.vigilado_desde ? fmtHora(cov.vigilado_desde) : "—"}
          color="text-fg"
        />
        <Lectura
          label="cobertura"
          desc="% del período con muestras almacenadas. Menos de 100 % significa huecos: el sondeo estuvo parado o sin registro."
          valor={cobertura != null ? `${cobertura.toFixed(1)}%` : "—"}
          color={cobertura == null ? "text-dim" : colorEstado(cobertura)}
        />
        <Lectura
          label="disponibilidad"
          desc="% de pings contestados durante el período."
          valor={dispo != null ? `${dispo.toFixed(2)}%` : "—"}
          color={dispo == null ? "text-dim" : colorEstado(dispo)}
        />
        <Lectura
          label="caídas"
          desc="Desconexiones (outages) registradas en el período y la duración de la más larga."
          valor={cov ? `${cov.caidas_n} · máx ${fmtDur(cov.caida_max_s)}` : "—"}
          color={cov && cov.caidas_n > 0 ? "text-crit" : "text-ok"}
        />
        <Lectura
          label="degradado"
          desc="Tiempo total respondiendo por encima del umbral de latencia del dispositivo (150 ms por defecto)."
          valor={degradadoMin != null ? `${degradadoMin.toFixed(0)} min` : "—"}
          color={degradadoMin != null && degradadoMin > 0 ? "text-warn" : "text-ok"}
        />
      </div>

      {cov && cov.huecos.length > 0 && (
        <div className="tick border border-edge bg-panel p-2.5">
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
            {cov.n_huecos} hueco{cov.n_huecos === 1 ? "" : "s"} de vigilancia
          </div>
          <ul className="max-h-28 overflow-y-auto font-mono text-[11px]">
            {cov.huecos.slice(0, 10).map((h, i) => (
              <li key={i} className="flex gap-3 py-0.5">
                <span className="text-fg">{fmtHora(h.inicio)}</span>
                <span className="text-mut">{fmtDur(h.duracion_s)} sin muestras</span>
              </li>
            ))}
            {cov.n_huecos > 10 && (
              <li className="py-0.5 text-dim">… y {cov.n_huecos - 10} más</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
