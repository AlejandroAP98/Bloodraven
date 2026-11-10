import { useEffect, useRef, useState } from "react";

import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";

import type { DispOut, PuntoAgg, PuntoRaw } from "./api";
import { api } from "./api";
import { BSECS, coloresGrafica, hacerRejilla, pares } from "./GraficaLatencia";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  CanvasRenderer,
]);

const ALTO = 300;

function hexAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
const MAX_SEL = 4;

const RANGOS = [
  { label: "10m", h: 1 / 6, res: "raw" },
  { label: "30m", h: 0.5, res: "raw" },
  { label: "1h", h: 1, res: "raw" },
  { label: "3h", h: 3, res: "1m" },
  { label: "6h", h: 6, res: "1m" },
];

export function Comparativa({
  dispositivos,
  onVolver,
}: {
  dispositivos: DispOut[];
  onVolver: () => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const [horas, setHoras] = useState(1);
  const [auto, setAuto] = useState(0);
  const [error, setError] = useState("");
  const cont = useRef<HTMLDivElement>(null);
  const inst = useRef<ReturnType<typeof echarts.init> | null>(null);
  const kKey = useRef("");
  const [temTick, setTemTick] = useState(0);

  useEffect(() => {
    const obs = new MutationObserver(() => setTemTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setAuto((a) => a + 1), 10000);
    return () => clearInterval(t);
  }, []);

  const toggle = (id: string) => {
    setSel((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_SEL ? prev : [...prev, id],
    );
  };

  useEffect(() => {
    let cancelado = false;
    (async () => {
      if (!cont.current) return;
      const res = RANGOS.find((r) => r.h === horas)?.res ?? "raw";
      const t0 = Math.floor(Date.now() / 1000 - horas * 3600);
      const t1 = Math.ceil(Date.now() / 1000);
      try {
        const pors = await Promise.all(
          sel.map(async (id) => {
            const d = api.muestras(id, horas, res).then((x) => ({
              id,
              rej: hacerRejilla(x.puntos as (PuntoRaw | PuntoAgg)[], t0, t1, BSECS[res] ?? 30),
            }));
            return d;
          }),
        );
        if (cancelado || !cont.current) return;
        setError("");

        const col = coloresGrafica();
        const PAL = [col.ACC, col.OK_L, col.WARN, col.CRIT];
        const nombre = new Map(dispositivos.map((d) => [d.id, d.nombre]));
        const kActual = `${sel.join(",")}:${horas}:${temTick}`;

        const series = pors.map((p, i) => ({
          name: nombre.get(p.id) ?? p.id,
          type: "line" as const,
          z: 3,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: PAL[i % PAL.length], width: 1.5 },
          itemStyle: { color: PAL[i % PAL.length] },
          data: pares(p.rej.ts, p.rej.avg),
        }));

        const opcion: EChartsOption = {
          animation: false,
          backgroundColor: "transparent",
          grid: { left: 8, right: 12, top: 30, bottom: 68, containLabel: true },
          legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 2, textStyle: { color: col.TXT, fontFamily: col.FONT, fontSize: 10 } },
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
              label: { fontFamily: col.FONT, fontSize: 9, backgroundColor: col.PANEL, color: col.FG, borderColor: col.EDGEHI },
            },
            formatter: (params: unknown) => {
              const ps = (Array.isArray(params) ? params : [params]) as Array<{
                marker?: string;
                color?: string;
                seriesName?: string;
                value?: unknown;
              }>;
              if (!ps.length || ps[0].value == null) return "";
              const v0 = ps[0].value as [number, number | null];
              const cuando = new Date(v0[0]).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
              const filas = ps
                .map((p) => {
                  const v = Array.isArray(p.value) ? (p.value[1] as number | null) : null;
                  if (v == null) return "";
                  return `<div style="margin-top:2px"><span style="display:inline-block;width:8px;height:8px;background:${p.color}"></span> ${p.seriesName}:<b style="float:right;margin-left:10px">${v.toFixed(1)} ms</b></div>`;
                })
                .join("");
              return `<div style="min-width:180px"><b>${cuando}</b><div style="border-top:1px solid ${col.EDGE};margin-top:4px"></div>${filas}</div>`;
            },
          },
          xAxis: {
            type: "time",
            min: t0 * 1000,
            max: t1 * 1000,
            axisLine: { lineStyle: { color: col.EDGEHI } },
            axisTick: { show: false },
            axisLabel: { color: col.TXT, fontFamily: col.FONT, fontSize: 10, formatter: "{HH}:{mm}" },
            splitLine: { show: false },
          },
          yAxis: {
            type: "value",
            name: "ms",
            min: 0,
            boundaryGap: ["0%", "8%"],
            nameTextStyle: { color: col.TXT, fontFamily: col.FONT, fontSize: 10, align: "left" },
            axisLabel: { color: col.TXT, fontFamily: col.FONT, fontSize: 10 },
            splitLine: { lineStyle: { color: col.GRID } },
          },
          dataZoom: [
            { type: "inside", xAxisIndex: 0, filterMode: "none" },
            {
              type: "slider",
              xAxisIndex: 0,
              filterMode: "none",
              height: 16,
              bottom: 14,
              borderColor: col.EDGE,
              fillerColor: hexAlpha(col.ACC, 0.1),
              handleStyle: { color: col.EDGEHI },
              textStyle: { color: col.TXT, fontFamily: col.FONT, fontSize: 9 },
            },
          ],
          series,
        } as EChartsOption;

        if (inst.current && kKey.current === kActual) {
          inst.current.setOption(opcion);
          return;
        }
        if (cancelado) return;
        inst.current?.dispose();
        cont.current.innerHTML = "";
        inst.current = echarts.init(cont.current);
        inst.current.setOption(opcion);
        kKey.current = kActual;
      } catch (e) {
        if (!cancelado) setError(String(e));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [sel, horas, temTick, auto, dispositivos]);

  useEffect(() => {
    if (!cont.current) return;
    const ro = new ResizeObserver(() => inst.current?.resize());
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge pb-4">
        <button
          onClick={onVolver}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
        >
                    <span className="ico">◂</span> Volver
        </button>
        <h2 className="text-xl font-semibold tracking-[0.06em] text-fg">Comparativa</h2>
        <span className="font-mono text-xs text-mut">hasta {MAX_SEL} dispositivos · media de cada nodo</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {dispositivos.map((d) => (
          <button
            key={d.id}
            onClick={() => toggle(d.id)}
            className={`border px-2.5 py-1 font-mono text-xs transition-colors ${
              sel.includes(d.id) ? "border-acc/60 bg-acc/10 text-acc" : "border-edge bg-panel text-mut hover:border-edgehi hover:text-fg"
            }`}
          >
            {d.nombre}
          </button>
        ))}
        {dispositivos.length === 0 && <span className="font-mono text-xs text-mut">Sin dispositivos.</span>}
      </div>

      <div className="flex border border-edge">
        {RANGOS.map((r) => (
          <button
            key={r.label}
            onClick={() => setHoras(r.h)}
            className={`px-3 py-1 font-mono text-xs not-last:border-r transition-colors ${
              horas === r.h ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && <p className="font-mono text-xs text-crit">error: {error}</p>}

      <section className="border border-edge bg-panel p-4">
        {sel.length ? (
          <div ref={cont} className="w-full overflow-hidden" style={{ height: ALTO }} />
        ) : (
          <p className="flex h-[140px] items-center justify-center font-mono text-xs text-mut">
            selecciona dispositivos arriba para superponer sus curvas
          </p>
        )}
      </section>
    </div>
  );
}
