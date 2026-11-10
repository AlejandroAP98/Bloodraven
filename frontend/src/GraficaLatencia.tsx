import { useEffect, useRef, useState } from "react";

import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";

import { api, fmtDur } from "./api";
import type { Outage, PuntoAgg, PuntoRaw } from "./api";

// registro modular: solo lo que usa la gráfica (tree-shaking)
echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TooltipComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  CanvasRenderer,
]);

const ALTO = 280;

// segundos por bucket según resolución pedida: raw = buckets de 30s del probe
export const BSECS: Record<string, number> = { raw: 30, "1m": 60, "1h": 3600, "1d": 86400 };

// colores leídos del tema activo (tokens CSS, canvas usa las --graf-*)
export function coloresGrafica() {
  const cs = getComputedStyle(document.documentElement);
  const v = (nombre: string, defecto: string) => cs.getPropertyValue(nombre).trim() || defecto;
  const mut = v("--graf-mut", "76 81 92");
  const crit = v("--graf-crit", "166 42 53");
  const ok = v("--graf-ok", "30 107 64");
  return {
    ACC: v("--color-acc", "#1e2024"),
    CRIT: v("--color-crit", "#a62a35"),
    WARN: v("--color-warn", "#9d4a08"),
    TXT: v("--color-mut", "#4c515c"),
    FG: v("--color-fg", "#101013"),
    PANEL: v("--color-panel", "#ffffff"),
    EDGE: v("--color-edge", "#d3d4d8"),
    EDGEHI: v("--color-edgehi", "#8a8e97"),
    MUT: `rgb(${mut} / .5)`,
    MX: `rgb(${mut} / .8)`,
    MN: `rgb(${ok} / .8)`,
    GRID: v("--graf-grid", "#e4e5e8"),
    AXIS: v("--graf-axis", "#5e636d"),
    BAR: `rgb(${v("--graf-bar", "30 32 36")} / .55)`,
    BAR_CRIT: `rgb(${crit} / .65)`,
    OUTAGE: `rgb(${crit} / .12)`,
    OK: `rgb(${ok} / .8)`,
    OK_L: v("--color-ok", "#1e6b40"),
    FONT: v("--font-mono", '"IBM Plex Mono", Consolas, monospace'),
  };
}
type ColoresGrafica = ReturnType<typeof coloresGrafica>;
export type { ColoresGrafica };

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ref al listado de outages accesible desde armarOpcion
const outagesGlobal = { current: [] as Outage[] };

// rejilla constante: slots fijos desde t0, cada punto cae en su slot,
// los slots sin datos quedan a null (huecos visibles)
export function hacerRejilla(
  puntos: (PuntoRaw | PuntoAgg)[],
  t0: number,
  t1: number,
  bsec: number,
) {
  const total = t1 - t0;
  let nSlots = Math.ceil(total / bsec);
  nSlots = Math.max(1, Math.min(nSlots, 2000)); // techo de creación
  const ts: (number | null)[] = new Array(nSlots).fill(null);
  const avg: (number | null)[] = new Array(nSlots).fill(null);
  const p95: (number | null)[] = new Array(nSlots).fill(null);
  const mx: (number | null)[] = new Array(nSlots).fill(null);
  const mn: (number | null)[] = new Array(nSlots).fill(null);
  const perd: number[] = new Array(nSlots).fill(0);
  const marca: boolean[] = new Array(nSlots).fill(false);
  const pesos: number[][] = Array.from({ length: nSlots }, () => []);

  const leer = (p: PuntoRaw | PuntoAgg, k: string): number | null =>
    (p as unknown as Record<string, number | null>)[k] ?? null;
  const esAgg = puntos.length > 0 && "avg_ms" in puntos[0];

  for (const p of puntos) {
    const t = new Date(p.ts).getTime() / 1000;
    const i = Math.floor((t - t0) / bsec);
    if (i < 0 || i >= nSlots) continue;
    ts[i] = t0 + i * bsec + bsec / 2; // barra centrada en el slot

    const a = esAgg ? leer(p, "avg_ms") : leer(p, "rtt_ms");
    const peso = esAgg ? 1 : ((leer(p, "n") as number) ?? 1);
    if (a != null) pesos[i].push(peso);

    const comb = (dest: (number | null)[], v: number | null, max: boolean) => {
      if (v == null) return;
      dest[i] = dest[i] == null ? v : max ? Math.max(dest[i] as number, v) : Math.min(dest[i] as number, v);
    };
    // varios puntos crudos dentro de un slot: media ponderada de avg, extremos en min/max, p95 tope
    if (a != null) {
      const prev = avg[i] ?? 0;
      const wPrev = pesos[i].length > 1 ? pesos[i].slice(0, -1).reduce((x, y) => x + y, 0) : 0;
      const wTot = wPrev + peso;
      avg[i] = (prev * wPrev + a * peso) / Math.max(1, wTot);
    }
    comb(p95, esAgg ? leer(p, "p95_ms") : leer(p, "rtt_p95_ms"), true);
    comb(mx, esAgg ? leer(p, "max_ms") : leer(p, "rtt_max_ms"), true);
    comb(mn, esAgg ? leer(p, "min_ms") : leer(p, "rtt_min_ms"), false);

    const pl = p.perdida_pct ?? 0;
    if (pl != null) {
      const wTot = Math.max(1, pesos[i].reduce((x, y) => x + y, 0));
      const prevP = perd[i] * (wTot - peso);
      perd[i] = (prevP + pl * peso) / Math.max(1, wTot);
    }

    marca[i] =
      marca[i] ||
      outagesGlobal.current.some(
        (o) => t >= new Date(o.inicio).getTime() / 1000 && (o.fin == null || t <= new Date(o.fin).getTime() / 1000),
      );
  }

  return { ts, avg, p95, mx, mn, perd, marca };
}

type Rejilla = ReturnType<typeof hacerRejilla>;
type Par = [number, number | null];

// slots con ts definidos → pares [ms, valor] que ECharts entiende en eje tiempo
export function pares(ts: (number | null)[], vals: (number | null | undefined)[]): Par[] {
  const out: Par[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t != null) out.push([t * 1000, vals[i] ?? null]);
  }
  return out;
}

const CASI_NADA = 0.5;

function armarOpcion(
  rej: Rejilla,
  t0ms: number,
  t1ms: number,
  col: ColoresGrafica,
): EChartsOption {
  // bandas de outage con etiqueta de duración
  const dataOutages = outagesGlobal.current
    .map((o) => {
      const inicio = new Date(o.inicio).getTime();
      const bruto = o.fin ? new Date(o.fin).getTime() : Date.now();
      const fin = Math.min(bruto, t1ms);
      if (fin <= inicio) return null;
      const durS = (bruto - inicio) / 1000;
      return [
        {
          xAxis: inicio,
          itemStyle: { color: col.OUTAGE },
          label: {
            show: durS > 45,
            formatter: `▾ ${fmtDur(durS)}`,
            position: "insideTop" as const,
            distance: 6,
            fontSize: 9,
            color: col.CRIT,
            fontFamily: col.FONT,
          },
        } as const,
        { xAxis: fin } as const,
      ];
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  // pérdida visible solo > 0.5 %
  const perdDatos = pares(
    rej.ts,
    rej.perd.map((p) => (p > CASI_NADA ? p : null)),
  );

  // barras de avg con color rojo cuando el slot cae dentro de un outage
  const avgDatos: Array<[number, number | null] | { value: [number, number | null]; itemStyle: { color: string } }> = [];
  for (let i = 0; i < rej.ts.length; i++) {
    const t = rej.ts[i];
    if (t == null || rej.avg[i] == null) continue;
    const par: [number, number | null] = [t * 1000, rej.avg[i]];
    if (rej.marca[i]) avgDatos.push({ value: par, itemStyle: { color: col.BAR_CRIT } });
    else avgDatos.push(par);
  }

  const ejeLabel = { color: col.TXT, fontFamily: col.FONT, fontSize: 10 } as const;
  // en rangos multi-día las marcas de hora sola no bastan: añade fecha al eje y al tooltip breve
  const multiDia = t1ms - t0ms > 2 * 24 * 3600e3;
  const fmtEje = multiDia ? "{dd} {MMM} {HH}:{mm}" : "{HH}:{mm}";

  const tooltipHTML = (params: unknown): string => {
    const ps = (Array.isArray(params) ? params : [params]) as Array<{
      seriesName?: string;
      color?: string;
      marker?: string;
      value?: unknown;
    }>;
    if (!ps.length || ps[0].value == null) return "";
    const v0 = ps[0].value as [number, number | null];
    const t = new Date(v0[0]);
    const cuando = t.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
    const filas = ps
      .map((p) => {
        const v = Array.isArray(p.value) ? (p.value[1] as number | null) : null;
        if (v == null) return "";
        const unidad = p.seriesName === "pérdida" ? "%" : " ms";
        return `<div style="margin-top:2px">${p.marker ?? ""} ${p.seriesName}:<b style="float:right;margin-left:10px">${v.toFixed(1)}${unidad}</b></div>`;
      })
      .join("");
    return `<div style="min-width:180px"><b>${cuando}</b><div style="border-top:1px solid ${col.EDGE};margin-top:4px"></div>${filas}</div>`;
  };

  return {
    animation: false,
    backgroundColor: "transparent",
    grid: { left: 8, right: 12, top: 30, bottom: 68, containLabel: true },
    legend: {
      data: ["avg", "p95", "máx", "mín", "pérdida"],
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 7,
      textStyle: { color: col.TXT, fontFamily: col.FONT, fontSize: 10 },
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: col.PANEL,
      borderColor: col.EDGE,
      textStyle: { color: col.FG, fontFamily: col.FONT, fontSize: 11 },
      axisPointer: {
        type: "cross",
        lineStyle: { color: col.EDGEHI },
        crossStyle: { color: col.EDGEHI },
        label: {
          fontFamily: col.FONT,
          fontSize: 9,
          backgroundColor: col.PANEL,
          color: col.FG,
          borderColor: col.EDGEHI,
        },
      },
      formatter: tooltipHTML,
    },
    xAxis: {
      type: "time",
      min: t0ms,
      max: t1ms,
      axisLine: { lineStyle: { color: col.EDGEHI } },
      axisTick: { show: false },
      axisLabel: { ...ejeLabel, formatter: fmtEje },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value",
        name: "ms",
        min: 0,
        boundaryGap: ["0%", "8%"],
        nameTextStyle: { ...ejeLabel, align: "left" as const },
        axisLabel: ejeLabel,
        splitLine: { lineStyle: { color: col.GRID } },
      },
      // eje de pérdida: escala 0-50 fantasma, mantiene las barras al pie bajas
      { type: "value", show: false, min: 0, max: 50, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        height: 16,
        bottom: 14,
        borderColor: col.EDGE,
        fillerColor: hexA(col.ACC, 0.1),
        handleStyle: { color: col.EDGEHI },
        moveHandleStyle: { color: col.EDGEHI },
        textStyle: { color: col.TXT, fontFamily: col.FONT, fontSize: 9 },
        dataBackground: {
          lineStyle: { color: col.EDGEHI, opacity: 0.4 },
          areaStyle: { color: col.EDGEHI, opacity: 0.1 },
        },
        selectedDataBackground: {
          lineStyle: { color: col.ACC, opacity: 0.5 },
          areaStyle: { color: col.ACC, opacity: 0.08 },
        },
      },
    ],
    series: [
      {
        name: "pérdida",
        type: "bar",
        yAxisIndex: 1,
        z: 1,
        barGap: "-100%",
        barMaxWidth: 14,
        itemStyle: { color: col.CRIT, opacity: 0.8 },
        data: perdDatos,
      },
      {
        name: "avg",
        type: "bar",
        z: 2,
        barGap: "-100%",
        barMaxWidth: 14,
        itemStyle: { color: col.BAR },
        data: avgDatos,
        markArea: { silent: true, itemStyle: { color: col.OUTAGE }, data: dataOutages as never },
      },
      {
        name: "p95",
        type: "line",
        z: 3,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: col.WARN, width: 1, type: "dashed", opacity: 0.85 },
        itemStyle: { color: col.WARN },
        data: pares(rej.ts, rej.p95),
      },
      {
        name: "máx",
        type: "line",
        z: 3,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: col.MX, width: 1 },
        itemStyle: { color: col.MX },
        data: pares(rej.ts, rej.mx),
      },
      {
        name: "mín",
        type: "line",
        z: 3,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: col.MN, width: 1 },
        itemStyle: { color: col.MN },
        data: pares(rej.ts, rej.mn),
      },
    ],
  };
}

function esAggQ(puntos: (PuntoRaw | PuntoAgg)[]): boolean {
  return puntos.length > 0 && "avg_ms" in puntos[0];
}

export default function GraficaLatencia({
  deviceId,
  horas = 12,
  outages,
  resolucion = "raw",
  refresco = 0,
  rango,
}: {
  deviceId: string;
  horas?: number;
  outages: Outage[];
  resolucion?: string;
  refresco?: number;
  /** rango fijo por fechas (ms): sustituye la ventana "horas hacia atrás" */
  rango?: { desde: number; hasta: number };
}) {
  const cont = useRef<HTMLDivElement>(null);
  const inst = useRef<ReturnType<typeof echarts.init> | null>(null);
  const kKey = useRef("");
  const [temTick, setTemTick] = useState(0);

  // reconstruye la gráfica con los colores del tema cuando cambia
  useEffect(() => {
    const obs = new MutationObserver(() => setTemTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelado = false;
    outagesGlobal.current = outages;
    (async () => {
      const r0 = rango?.desde ?? null;
      const r1 = rango?.hasta ?? null;
      const res = r0 != null && r1 != null ? await api.muestrasRango(deviceId, r0, r1, resolucion) : await api.muestras(deviceId, horas, resolucion);
      const raw = res.puntos as (PuntoRaw | PuntoAgg)[];
      if (cancelado || !cont.current) return;

      const bsec = BSECS[resolucion] ?? 30;

      // ventana X: fija por fechas en modo rango, "horas hacia atrás" en modo normal
      const t0 = r0 != null ? Math.floor(r0 / 1000) : Math.floor(Date.now() / 1000 - horas * 3600);
      const t1 = r1 != null ? Math.ceil(r1 / 1000) : Math.ceil(Date.now() / 1000);

      const rej = hacerRejilla(raw, t0, t1, bsec);
      if (cancelado || !cont.current) return;
      const col = coloresGrafica();

      const kActual = `${deviceId}:${horas}:${resolucion}:${esAggQ(raw) ? "agg" : "raw"}:${temTick}:${r0 ?? ""}:${r1 ?? ""}`;
      if (inst.current && kKey.current === kActual) {
        inst.current.setOption(armarOpcion(rej, t0 * 1000, t1 * 1000, col));
        return;
      }
      if (cancelado) return;
      inst.current?.dispose();
      cont.current.innerHTML = "";
      inst.current = echarts.init(cont.current);
      inst.current.setOption(armarOpcion(rej, t0 * 1000, t1 * 1000, col));
      kKey.current = kActual;
    })();
    return () => {
      cancelado = true;
    };
  }, [deviceId, horas, resolucion, refresco, temTick, outages, rango?.desde, rango?.hasta]);

  useEffect(() => {
    if (!cont.current) return;
    const ro = new ResizeObserver(() => {
      inst.current?.resize();
    });
    ro.observe(cont.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      inst.current?.dispose();
      inst.current = null;
      kKey.current = "";
    };
  }, []);

  return <div ref={cont} className="w-full overflow-hidden" style={{ height: ALTO }} />;
}
