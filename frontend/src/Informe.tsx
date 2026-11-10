import { useEffect, useMemo, useState } from "react";

import { api, calcularStats, fmtDur, fmtHora } from "./api";
import type { CambioRutaEvt, Cobertura, DispOut, Estado, Outage, PuntoAgg, PuntoRaw, Stats } from "./api";
import { StatGrid } from "./TarjetaStats";

const RANGOS = [
  { label: "1h", h: 1 },
  { label: "6h", h: 6 },
  { label: "24h", h: 24 },
  { label: "7d", h: 168 },
  { label: "todo el historial", h: null },
];

// resolución según ancho del rango (igual que en la gráfica: cap ~2000 slots)
function resPara(spanH: number): string {
  if (spanH <= 2) return "raw";
  if (spanH <= 30) return "1m";
  if (spanH <= 2160) return "1h"; // hasta ~90 días
  return "1d";
}

const vMs = (v: number | null | undefined) => (v == null ? "n.d." : `${v.toFixed(1)} ms`);
const vPct = (v: number | null | undefined) => (v == null ? "n.d." : `${v.toFixed(1)} %`);
const fmtFecha = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

// valor representativo de un punto (misma regla que calcularStats)
const valor = (p: PuntoRaw | PuntoAgg): number | null =>
  "avg_ms" in p ? p.avg_ms : p.rtt_median_ms != null ? p.rtt_median_ms : p.ok ? p.rtt_ms : null;

export type InformeDatos = {
  t0: number;
  t1: number;
  res: string;
  puntos: number;
  stats: Stats;
  outages: Outage[];
  cobertura: Cobertura | null;
  coberturaHoras: number;
  cambios: CambioRutaEvt[];
  rutaRef: { ts: string | null; hops: { ip: string | null; hostname: string | null }[] } | null;
  pico: { v: number; ts: string } | null;
};

type Bloque =
  | { t: "titulo"; texto: string }
  | { t: "seccion"; texto: string }
  | { t: "kv"; pares: [string, string][] }
  | { t: "tabla"; cabecera: string[]; filas: string[][] }
  | { t: "linea"; texto: string };

// ------------------------------------------------------------------ documento

function genBloques(dispositivo: DispOut, estado: Estado | undefined, d: InformeDatos): Bloque[] {
  const cheq =
    dispositivo.tipo === "tcp"
      ? `TCP puerto ${dispositivo.puerto ?? "?"}`
      : dispositivo.tipo === "http"
        ? `HTTP${dispositivo.puerto ? `:${dispositivo.puerto}` : ""}${dispositivo.texto_buscado ? ` (busca "${dispositivo.texto_buscado}")` : ""}`
        : dispositivo.tipo === "dns"
          ? `DNS${dispositivo.dns_servidor ? ` vía ${dispositivo.dns_servidor}` : ""}`
          : "ICMP ping";
  const s = d.stats;
  const cob = d.cobertura;
  const caidasActivas = d.outages.filter((o) => o.activa).length;

  const bloques: Bloque[] = [
    { t: "titulo", texto: `informe de comportamiento · ${dispositivo.nombre}` },
    {
      t: "seccion",
      texto: "1. Dispositivo",
    },
    {
      t: "kv",
      pares: [
        ["Nombre", dispositivo.nombre],
        ["Host", dispositivo.host],
        ["Tipo de chequeo", cheq],
        ["Intervalo de sondeo", `${dispositivo.intervalo_ping_s} s`],
        ["Umbral degradado", `${dispositivo.umbral_degradado_ms} ms`],
        ["Estado actual", estado?.estado ?? "desconocido"],
        ["Última latencia", estado?.ultimo_rtt_ms != null ? `${estado.ultimo_rtt_ms.toFixed(0)} ms` : "n.d."],
      ],
    },
    {
      t: "seccion",
      texto: "2. Período analizado",
    },
    {
      t: "kv",
      pares: [
        ["Desde", fmtFecha(d.t0)],
        ["Hasta", fmtFecha(d.t1)],
        ["Duración", fmtDur((d.t1 - d.t0) / 1000)],
        ["Muestras procesadas", String(d.puntos)],
        ["Resolución de datos", d.res === "raw" ? "30 s" : d.res === "1m" ? "1 min" : d.res === "1h" ? "1 h" : "1 día"],
        ["Fecha del informe", fmtFecha(Date.now())],
      ],
    },
    {
      t: "seccion",
      texto: "3. Métricas del período",
    },
    {
      t: "tabla",
      cabecera: ["Métrica", "Valor", "Nota"],
      filas: [
        ["Latencia media", vMs(s.media), "promedio de las lecturas con respuesta"],
        ["Latencia mediana", vMs(s.mediana), "mitad del rango por debajo"],
        ["Latencia mínima", vMs(s.min), "piso del enlace"],
        ["Latencia máxima", vMs(s.max), "peor lectura registrada"],
        ["Jitter (σ)", vMs(s.jitter), "variabilidad entre lecturas"],
        ["Pérdida de pings", vPct(s.perdida_pct), "incluye tiempo caído"],
        ["Tiempo caído", vPct(s.down_pct), "% del rango en outage"],
      ],
    },
    {
      t: "kv",
      pares: d.pico
        ? [["Pico de latencia", `${d.pico.v.toFixed(1)} ms el ${fmtFecha(new Date(d.pico.ts).getTime())}`]]
        : [["Pico de latencia", "sin lecturas con respuesta en el rango"]],
    },
    {
      t: "seccion",
      texto: `4. Cobertura de supervisión (últimos ${
        d.coberturaHoras < 24 ? `${d.coberturaHoras.toFixed(0)} h` : `${(d.coberturaHoras / 24).toFixed(0)} día(s)`
      })`,
    },
    {
      t: "kv",
      pares: cob
        ? [
            ["Vigilado desde", cob.vigilado_desde ? fmtFecha(new Date(cob.vigilado_desde).getTime()) : "n.d."],
            ["Pings enviados", String(cob.pings)],
            ["Pings con respuesta", String(cob.pings_ok)],
            ["Cobertura de datos", vPct(cob.cobertura_pct)],
            ["Disponibilidad", cob.disponibilidad_pct != null ? vPct(cob.disponibilidad_pct) : "n.d."],
            ["Huecos sin muestras", `${cob.n_huecos} (total ${fmtDur(cob.huecos.reduce((a, h) => a + h.duracion_s, 0))})`],
            ["Caídas totales", `${cob.caidas_n} (${fmtDur(cob.caidas_s_acum)} acumulado)`],
            ["Peor caída", cob.caidas_n ? fmtDur(cob.caida_max_s) : "—"],
            ["Tiempo degradado", fmtDur(cob.degradado_s)],
          ]
        : [["Cobertura", "sin datos"]],
    },
    {
      t: "seccion",
      texto: `5. Caídas registradas (${d.outages.length}${caidasActivas ? ` · ${caidasActivas} activa(s)` : ""})`,
    },
    d.outages.length === 0
      ? { t: "linea", texto: "Sin desconexiones en el período analizado." }
      : {
          t: "tabla",
          cabecera: ["Inicio", "Duración", "Causa", "Dónde se cortó"],
          filas: d.outages.slice(0, 30).map((o) => [
            fmtFecha(new Date(o.inicio).getTime()) + (o.activa ? " (activa)" : ""),
            fmtDur(o.duracion_s),
            o.causa,
            o.corte,
          ]),
        },
    {
      t: "seccion",
      texto: `6. Ruta (${d.cambios.length} cambio(s) en el período)`,
    },
    d.rutaRef?.ts
      ? {
          t: "kv",
          pares: [
            [
              "Ruta de referencia",
              `${fmtHora(d.rutaRef.ts)}: ${d.rutaRef.hops.map((h) => h.ip ?? h.hostname ?? "timeout").join(" → ") || "sin saltos"}`,
            ],
          ],
        }
      : { t: "linea", texto: "Sin escaneos de ruta aún." },
    d.cambios.length === 0
      ? { t: "linea", texto: "Ruta estable: sin cambios desde la referencia." }
      : {
          t: "tabla",
          cabecera: ["Momento", "Cambio detectado"],
          filas: d.cambios.slice(0, 10).map((c) => [fmtFecha(new Date(c.ts).getTime()), c.resumen]),
        },
  ];

  // conclusiones heurísticas
  const conc: string[] = [];
  if (s.media == null && !d.stats.perdida_pct) {
    conc.push("Sin datos suficientes en el rango para emitir conclusiones.");
  } else {
    if (s.down_pct != null && s.down_pct === 0) conc.push("El dispositivo no registró caídas en el período analizado.");
    else if (s.down_pct != null && s.down_pct > 5)
      conc.push(`Problemas serios de disponibilidad: ${d.outages.length} caída(s), ${s.down_pct.toFixed(1)} % del tiempo fuera de servicio.`);
    else if (s.down_pct != null && s.down_pct > 0)
      conc.push(`${d.outages.length} caída(s) que suman ${s.down_pct.toFixed(1)} % del período.`);

    if (s.perdida_pct != null && s.perdida_pct > 5)
      conc.push(`Pérdida de paquetes elevada (${s.perdida_pct.toFixed(1)} %) incluso con el dispositivo en línea.`);
    else if (s.perdida_pct != null && s.perdida_pct > 0)
      conc.push(`Pérdida de paquetes ligera (${s.perdida_pct.toFixed(1)} %).`);
    else if (s.perdida_pct != null) conc.push("Sin pérdida de paquetes apreciable.");

    if (s.jitter != null && s.jitter > 30) conc.push(`Latencia irregular: desviación (jitter) de ${s.jitter.toFixed(1)} ms.`);
    if (s.max != null && s.media != null && s.max > s.media * 3 && s.max > 200)
      conc.push(`Picos de latencia aislados: máximo de ${s.max.toFixed(1)} ms frente a media de ${s.media.toFixed(1)} ms.`);
    if (conc.length === 0 && s.media != null)
      conc.push(`Enlace estable: latencia media ${s.media.toFixed(1)} ms y jitter ${s.jitter?.toFixed(1) ?? "n.d."} ms.`);
  }
  bloques.push({ t: "seccion", texto: "7. Conclusiones" });
  bloques.push({ t: "kv", pares: conc.map((c, i) => [`${i + 1}.`, c]) as [string, string][] });

  return bloques;
}

// ------------------------------------------------------------------- render

function render(b: Bloque[], formato: "md" | "txt"): string {
  const out: string[] = [];
  for (const bl of b) {
    if (bl.t === "titulo") {
      out.push(formato === "md" ? `# ${bl.texto}` : `${bl.texto.toUpperCase()}\n${"=".repeat(Math.min(bl.texto.length, 76))}`);
    } else if (bl.t === "seccion") {
      out.push(formato === "md" ? `## ${bl.texto}` : `${bl.texto.toUpperCase()}\n${"-".repeat(Math.min(bl.texto.length, 76))}`);
    } else if (bl.t === "kv") {
      const w = Math.max(...bl.pares.map(([k]) => k.length)) + 1;
      out.push(bl.pares.map(([k, v]) => (formato === "md" ? `- **${k}:** ${v}` : `${k.padEnd(w)}${v}`)).join("\n"));
    } else if (bl.t === "tabla") {
      if (formato === "md") {
        out.push(
          `| ${bl.cabecera.join(" | ")} |\n| ${bl.cabecera.map(() => "---").join(" | ")} |\n` +
            bl.filas.map((f) => `| ${f.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`).join("\n")
        );
      } else {
        const w = bl.cabecera.map((h, i) => Math.max(h.length, ...bl.filas.map((f) => (f[i] ?? "").length)));
        out.push(
          bl.cabecera.map((h, i) => h.padEnd(w[i])).join("  ") +
            "\n" +
            w.map((x) => "-".repeat(x)).join("  ") +
            "\n" +
            bl.filas.map((f) => f.map((c, i) => (c ?? "").padEnd(w[i])).join("  ")).join("\n")
        );
      }
    } else {
      out.push(formato === "md" ? bl.texto : bl.texto);
    }
  }
  return out.join("\n\n");
}

const slug = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dispositivo";

const estampilla = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");

// ------------------------------------------------------------------ componente

export function Informe({
  dispositivo,
  estado,
  onCerrar,
}: {
  dispositivo: DispOut;
  estado?: Estado;
  onCerrar: () => void;
}) {
  const [hIdx, setHIdx] = useState(2);
  const [formato, setFormato] = useState<"md" | "txt">("md");
  const [datos, setDatos] = useState<InformeDatos | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCargando(true);
      setError(null);
      try {
        const ahora = Date.now();
        let t0 = RANGOS[hIdx].h != null ? ahora - RANGOS[hIdx].h! * 3600e3 : null;
        const t1 = ahora;
        if (t0 == null) {
          // principio real del historial: primera muestra diaria agregada
          const m = await api.muestrasRango(dispositivo.id, 0, ahora, "1d");
          if (!m.puntos.length) throw new Error("Aún no hay muestras registradas para este dispositivo.");
          t0 = new Date(m.puntos[0].ts).getTime();
        }
        const spanH = (t1 - t0) / 3600e3;
        const res = resPara(spanH);
        const cobHoras = Math.min(720, Math.max(0.1, spanH)); // cobertura topa a 30 días en la API
        const [m, out, cob, cam, rf] = await Promise.all([
          api.muestrasRango(dispositivo.id, t0, t1, res),
          api.outages(dispositivo.id, spanH),
          api.cobertura(dispositivo.id, cobHoras),
          api.cambiosRuta(dispositivo.id).catch(() => [] as CambioRutaEvt[]),
          api.rutaReferencia(dispositivo.id).catch(() => null),
        ]);
        if (!vivo) return;
        setDatos({
          t0,
          t1,
          res,
          puntos: m.puntos.length,
          stats: calcularStats(m.puntos, out, { t0, t1 }),
          outages: out,
          cobertura: cob,
          coberturaHoras: cobHoras,
          cambios: cam.filter((c) => new Date(c.ts).getTime() >= t0),
          rutaRef: rf,
          pico: (() => {
            let pic: { v: number; ts: string } | null = null;
            for (const p of m.puntos) {
              const v = valor(p);
              if (v != null && (pic == null || v > pic.v)) pic = { v, ts: p.ts };
            }
            return pic;
          })(),
        });
      } catch (e) {
        if (vivo) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [dispositivo.id, hIdx]);

  const texto = useMemo(() => (datos ? render(genBloques(dispositivo, estado, datos), formato) : ""), [datos, formato, dispositivo, estado]);

  const descargar = (ext: "md" | "txt") => {
    if (!datos) return;
    const url = URL.createObjectURL(new Blob([texto], { type: ext === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `informe-${slug(dispositivo.nombre)}-${estampilla()}-${RANGOS[hIdx].label.replace(/\s+/g, "")}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="tick tick-acc max-h-[88vh] w-[52rem] overflow-auto border border-edgehi bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-baseline gap-3 border-b border-edge pb-3">
          <h2 className="text-lg font-semibold tracking-[0.06em] text-fg">Informe de comportamiento</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-mut">{dispositivo.nombre}</span>
          <button
            onClick={onCerrar}
            className="ml-auto border border-edge px-2 py-1 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
          >
            cerrar
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex border border-edge">
            {RANGOS.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setHIdx(i)}
                className={`px-3 py-1 font-mono text-xs not-last:border-r transition-colors ${
                  hIdx === i ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <span className="font-mono text-[10px] text-mut">formato:</span>
          <div className="flex border border-edge">
            {(["md", "txt"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormato(f)}
                className={`px-3 py-1 font-mono text-xs not-last:border-r transition-colors ${
                  formato === f ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"
                }`}
              >
                .{f}{f === "md" && <span className="ml-1.5 text-[9px] text-acc/70">(recomendado)</span>}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => descargar("md")}
              disabled={cargando || !datos}
              className="border border-acc/50 bg-acc/10 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-40"
            >
              <span className="ico">⭱</span> Exportar .md
            </button>
            <button
              onClick={() => descargar("txt")}
              disabled={cargando || !datos}
              className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg disabled:opacity-40"
            >
              <span className="ico">⭱</span> Exportar .txt
            </button>
          </div>
        </div>

        {datos && <StatGrid stats={datos.stats} />}

        <div className="mt-4 border border-edge bg-void/60 p-4">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">vista previa del informe</h3>
          {error ? (
            <p className="font-mono text-xs text-crit">{error}</p>
          ) : cargando ? (
            <p className="font-mono text-xs text-mut">Generando informe…</p>
          ) : (
            <pre className="max-h-[38vh] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg">{texto}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
