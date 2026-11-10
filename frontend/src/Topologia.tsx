import { useEffect, useMemo, useState } from "react";

import { api, fmtHora } from "./api";
import type { TopoArista, TopoNodo, Topologia } from "./api";
import { BotonCopiar } from "./BotonCopiar";
import { GeneralView } from "./TopologiaGeneral";

// color de nodo por rol (tonos medios legibles en tema claro y oscuro)
const COLOR_ROL: Record<string, string> = {
  "gateway local": "#4f86d6",
  "router/agregador": "#4f86d6",
  "borde público": "#c46a28",
  switch: "#b8860b",
  "radio/antena": "#8d67c0",
  celda: "#8d67c0",
  PC: "#4ea35a",
  servidor: "#2a9d8f",
  "equipo objetivo": "#4ea35a",
  cámara: "#d06a75",
  DVR: "#a6584a",
  otro: "#8b8f96",
};
const COLOR_DEF = "#8b8f96";

// geometría del grafo
const W_NODO = 148;
const H_NODO = 32;
const GAP_X = 210;
const GAP_Y = 46;
const MARGEN = 30;

type CampoOrden = "de" | "a" | "rol" | "escaneos" | "delta" | "ultima";

// comparación de IP por octetos (equivalente a la del catálogo)
function cmpIp(a: string, b: string): number {
  const oa = a.split(".");
  const ob = b.split(".");
  for (let i = 0; i < 4; i++) {
    const x = Number(oa[i]) || 0;
    const y = Number(ob[i]) || 0;
    if (x !== y) return x - y;
  }
  return a.localeCompare(b, "es");
}

export function Topologia({
  onVolver,
  onVerDevice,
}: {
  onVolver: () => void;
  onVerDevice: (id: string) => void;
}) {
  const horas = 24; // ventana fija de rutas observadas
  const [topo, setTopo] = useState<Topologia | null>(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  const [busca, setBusca] = useState("");
  const [foco, setFoco] = useState<string | null>(null); // ip del nodo enfocado
  const [orden, setOrden] = useState<{ campo: CampoOrden; asc: boolean }>({ campo: "de", asc: true });
  // sección con dos pestañas: rutas (automática, todos los dispositivos) y
  // general (solo los dispositivos marcados por el usuario)
  const [modo, setModo] = useState<"rutas" | "general">("rutas");

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    api
      .topologia(horas)
      .then((t) => {
        if (!vivo) return;
        setTopo(t);
        setError("");
        setFoco(null);
      })
      .catch((e) => {
        if (vivo) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
  }, [horas]);

  const mapNodos = useMemo(
    () => new Map((topo?.nodos ?? []).map((n) => [n.ip, n] as const)),
    [topo],
  );

  // posiciones: capas horizontales por rango (BFS calculado en el backend);
  // dentro de cada capa los nodos se apilan verticalmente
  const layout = useMemo(() => {
    if (!topo) return null;
    const porCapa = new Map<number, TopoNodo[]>();
    for (const n of topo.nodos) {
      if (!porCapa.has(n.rango)) porCapa.set(n.rango, []);
      porCapa.get(n.rango)!.push(n);
    }
    const pos = new Map<string, { x: number; y: number }>();
    let maxCapa = 0;
    let altoCapa = 0;
    for (const [r, capa] of porCapa) {
      capa.forEach((n, i) => {
        pos.set(n.ip, { x: MARGEN + r * GAP_X, y: MARGEN + i * GAP_Y });
      });
      maxCapa = Math.max(maxCapa, r);
      altoCapa = Math.max(altoCapa, capa.length);
    }
    return {
      pos,
      width: MARGEN * 2 + maxCapa * GAP_X + W_NODO,
      height: MARGEN * 2 + Math.max(1, altoCapa) * GAP_Y,
    };
  }, [topo]);

  // adyacencias: subidas (quién va hacia aquí desde arriba) y bajadas
  const { subidas, bajadas } = useMemo(() => {
    const up = new Map<string, TopoArista[]>();
    const down = new Map<string, TopoArista[]>();
    for (const e of topo?.aristas ?? []) {
      if (!up.has(e.a)) up.set(e.a, []);
      up.get(e.a)!.push(e);
      if (!down.has(e.de)) down.set(e.de, []);
      down.get(e.de)!.push(e);
    }
    return { subidas: up, bajadas: down };
  }, [topo]);

  // búsqueda: ips o nombres que matchean se resaltan (los demás se diluyen)
  const resultados = useMemo(() => {
    const t = busca.trim().toLowerCase();
    if (!t || !topo) return null;
    const r = new Set<string>();
    for (const n of topo.nodos) {
      if (n.ip.includes(t) || (n.nombre ?? "").toLowerCase().includes(t)) r.add(n.ip);
    }
    return r;
  }, [busca, topo]);

  // cadena de ancestros del nodo enfocado: sube siempre por el uplink más usado
  const activos = useMemo(() => {
    if (!foco || !mapNodos.has(foco)) return null;
    const cadena = new Set<string>([foco]);
    const tramos = new Set<string>();
    let cur = foco;
    for (let guard = 0; guard < 32; guard++) {
      const ups = subidas.get(cur);
      if (!ups?.length) break;
      const mejor = [...ups].sort((a, b) => b.n_scans - a.n_scans)[0];
      cadena.add(mejor.de);
      tramos.add(`${mejor.de}>${mejor.a}`);
      if (mejor.de === cur) break;
      cur = mejor.de;
    }
    return { cadena, tramos };
  }, [foco, mapNodos, subidas]);

  const toggleOrden = (campo: CampoOrden) =>
    setOrden((o) => (o.campo === campo ? { campo, asc: !o.asc } : { campo, asc: true }));

  if (error) {
    return (
      <div className="space-y-3">
        <button
          onClick={onVolver}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
        >
          <span className="ico">◂</span> Volver
        </button>
        <p className="border border-crit/40 bg-crit/10 p-3 font-mono text-xs text-crit">
          error al calcular la topología: {error}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge pb-4">
        <button
          onClick={onVolver}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
        >
          <span className="ico">◂</span> Volver
        </button>
        <h2 className="text-xl font-semibold tracking-[0.06em] text-fg">Topología de la red</h2>
        <span className="flex border border-edge">
          <button
            onClick={() => setModo("rutas")}
            title="Automática: rutas observadas a todos los dispositivos vigilados"
            className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${
              modo === "rutas" ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"
            }`}
          >
            rutas
          </button>
          <button
            onClick={() => setModo("general")}
            title="General: solo los dispositivos marcados para este mapa"
            className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${
              modo === "general" ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"
            }`}
          >
            general
          </button>
        </span>
        {modo === "rutas" && (
          <span className="font-mono text-xs text-mut">
            grafo por rutas observadas
            {topo ? ` · ${topo.nodos.length} nodos · ${topo.aristas.length} enlaces · raíz ${topo.raiz ?? "—"}` : ""}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="buscar ip o nombre…"
            spellCheck={false}
            className="w-44 bg-void px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-dim ring-1 ring-edge transition-shadow outline-none focus:ring-acc/60"
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-dim" title="Ventana de rutas observadas">
            ventana 24 h
          </span>
        </span>
      </div>

      {modo === "general" ? (
        <GeneralView busca={busca} onVerDevice={onVerDevice} />
      ) : modo === "rutas" ? (
        <>
          {cargando && !topo && (
            <p className="font-mono text-xs text-mut">calculando topología de las rutas observadas…</p>
          )}

          {topo && topo.nodos.length === 0 && (
            <p className="border border-edge bg-panel p-4 font-mono text-xs text-mut">
              Sin escaneos de ruta en la ventana. La topología se arma con las rutas que Bloodraven traza a cada
              dispositivo vigilado; prueba con más tiempo (30 d) o agrega dispositivos.
            </p>
          )}

          {topo && layout && topo.nodos.length > 0 && (
        <section className="border border-edge bg-panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">grafo · capas desde la raíz</h3>
            <span className="font-mono text-[10px] text-dim">
              hover: tooltip · clic: foco · punteado = enlace de regreso
            </span>
          </div>
          <div className="overflow-auto border border-edge bg-void p-2">
            <svg width={layout.width} height={layout.height}>
              {topo.aristas.map((e) => {
                const p1 = layout.pos.get(e.de);
                const p2 = layout.pos.get(e.a);
                if (!p1 || !p2) return null;
                const llave = `${e.de}>${e.a}`;
                const regresa = e.a_rango <= e.de_rango;
                const resaltado = activos
                  ? activos.tramos.has(llave)
                  : resultados
                    ? resultados.has(e.de) || resultados.has(e.a)
                    : false;
                const atenuado = (activos || resultados) && !resaltado;
                let d: string;
                if (regresa) {
                  // enlace hacia arriba (loop): pasa por debajo de ambos nodos
                  d = `M ${p1.x + W_NODO / 2} ${p1.y + H_NODO} C ${p1.x + W_NODO / 2} ${p1.y + H_NODO + 24} ${p2.x + W_NODO / 2} ${p2.y + H_NODO + 24} ${p2.x + W_NODO / 2} ${p2.y + H_NODO}`;
                } else {
                  d = `M ${p1.x + W_NODO} ${p1.y + H_NODO / 2} C ${p1.x + W_NODO + 50} ${p1.y + H_NODO / 2} ${p2.x - 50} ${p2.y + H_NODO / 2} ${p2.x} ${p2.y + H_NODO / 2}`;
                }
                return (
                  <path
                    key={llave}
                    d={d}
                    fill="none"
                    stroke="var(--color-edgehi)"
                    strokeWidth={Math.min(4, 1.2 + e.n_scans / 40)}
                    strokeDasharray={regresa ? "5 4" : undefined}
                    opacity={atenuado ? 0.1 : resaltado ? 0.95 : 0.55}
                  >
                    <title>
                      {`${e.de} → ${e.a}`}
                      {`\n${e.n_scans} escaneos de ${e.dispositivos_n} dispositivo(s)`}
                      {e.delta_avg_ms != null ? `\ndelta medio del tramo: ${e.delta_avg_ms} ms` : ""}
                      {e.ultima ? `\núltima vez: ${fmtHora(e.ultima)}` : ""}
                    </title>
                  </path>
                );
              })}
              {topo.nodos.map((n) => {
                const p = layout.pos.get(n.ip)!;
                const c = COLOR_ROL[n.rol ?? ""] ?? COLOR_DEF;
                const esFoco = foco === n.ip;
                const atenuado = activos
                  ? !activos.cadena.has(n.ip)
                  : resultados
                    ? !resultados.has(n.ip)
                    : false;
                return (
                  <g
                    key={n.ip}
                    opacity={atenuado ? 0.15 : 1}
                    onClick={() => setFoco((f) => (f === n.ip ? null : n.ip))}
                    style={{ cursor: "pointer" }}
                  >
                    <rect
                      x={p.x}
                      y={p.y}
                      width={W_NODO}
                      height={H_NODO}
                      rx={4}
                      fill={c}
                      fillOpacity={n.catalogado ? 0.16 : 0.06}
                      stroke={c}
                      strokeWidth={n.monitoreado || esFoco ? 2 : 1.2}
                      strokeDasharray={n.isla ? "4 3" : undefined}
                    />
                    <text
                      x={p.x + 10}
                      y={p.y + (n.nombre ? 14 : 21)}
                      fontSize={n.nombre ? 11.5 : 10.5}
                      fill="var(--color-fg)"
                      fontWeight={600}
                    >
                      {(n.nombre ?? n.ip).slice(0, 19)}
                    </text>
                    {n.nombre && (
                      <text x={p.x + 10} y={p.y + 26} fontSize="9.5" fill="var(--color-mut)" fontFamily="monospace">
                        {n.ip}
                      </text>
                    )}
                    <title>
                      {`${n.nombre ?? "sin catalogar"} · ${n.ip}`}
                      {n.rol ? `\nrol: ${n.rol}` : ""}
                      {`\nvisto en ${n.vistos} escaneos · ${n.dispositivos_n} dispositivo(s)`}
                      {n.rtt_avg_ms != null ? `\nrtt medio: ${n.rtt_avg_ms} ms` : ""}
                      {n.ultima ? `\núltima vez: ${fmtHora(n.ultima)}` : ""}
                      {n.isla ? "\nsin camino hacia la raíz" : ""}
                    </title>
                  </g>
                );
              })}
            </svg>
          </div>
          {foco && mapNodos.get(foco) && (
            <FocoCard
              nodo={mapNodos.get(foco)!}
              subs={subidas.get(foco) ?? []}
              bajs={bajadas.get(foco) ?? []}
              mapNodos={mapNodos}
              onVerDevice={onVerDevice}
              onQuien={(ip) => setFoco(ip)}
              onLimpiar={() => setFoco(null)}
            />
          )}
        </section>
      )}

          {topo && topo.aristas.length > 0 && (
            <TablaAdyacencia
              topo={topo}
              orden={orden}
              onToggleOrden={toggleOrden}
              onFoco={(ip) => setFoco((f) => (f === ip ? null : ip))}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

// tarjeta del nodo enfocado: identidad, métricas y vecinos inmediatos
function FocoCard({
  nodo,
  subs,
  bajs,
  mapNodos,
  onVerDevice,
  onQuien,
  onLimpiar,
}: {
  nodo: TopoNodo;
  subs: TopoArista[];
  bajs: TopoArista[];
  mapNodos: Map<string, TopoNodo>;
  onVerDevice: (id: string) => void;
  onQuien: (ip: string) => void;
  onLimpiar: () => void;
}) {
  const etiqueta = (ip: string) => {
    const n = mapNodos.get(ip);
    return n?.nombre ? `${n.nombre} · ${ip}` : ip;
  };
  return (
    <div className="mt-3 border border-edgehi bg-void p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <p className="flex items-baseline gap-2 font-mono text-sm font-semibold text-fg">
            {nodo.nombre ?? nodo.ip}
            <span className="text-xs text-mut">{nodo.ip}</span>
            <BotonCopiar texto={nodo.ip} titulo="copiar ip" />
          </p>
          <p className="mt-0.5 font-mono text-xs text-mut">
            {nodo.rol ?? "sin catalogar"} · capa {nodo.rango}
            {nodo.isla ? " · isla (sin camino a la raíz)" : ""} · {nodo.vistos} escaneos de {nodo.dispositivos_n}{" "}
            dispositivo(s)
            {nodo.rtt_avg_ms != null ? ` · rtt medio ${nodo.rtt_avg_ms} ms` : ""}
            {nodo.ultima ? ` · última vez ${fmtHora(nodo.ultima)}` : ""}
          </p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {nodo.monitoreado && (
            <button
              onClick={() => onVerDevice(nodo.monitoreado!)}
              title="Abrir el detalle del dispositivo vigilado con esta ip"
              className="border border-acc/50 bg-acc/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20"
            >
              ver dispositivo
            </button>
          )}
          <button
            onClick={onLimpiar}
            title="Quitar el foco y volver a ver toda la topología"
            className="border border-edge bg-panel px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
          >
            quitar foco
          </button>
        </span>
      </div>
      {(subs.length > 0 || bajs.length > 0) && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim"> hacia arriba ({subs.length})</p>
            <ul className="mt-1 space-y-1">
              {[...subs]
                .sort((a, b) => b.n_scans - a.n_scans)
                .map((e) => (
                  <li key={e.de} className="font-mono text-xs">
                    <button
                      onClick={() => onQuien(e.de)}
                      className="text-mut transition-colors hover:text-acc"
                      title="Poner el foco en este equipo"
                    >
                      {etiqueta(e.de)}
                    </button>
                    <span className="ml-2 text-dim">
                      {e.n_scans} esc · {e.delta_avg_ms != null ? `+${e.delta_avg_ms} ms` : "—"}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim"> hacia abajo ({bajs.length})</p>
            <ul className="mt-1 space-y-1">
              {[...bajs]
                .sort((a, b) => b.n_scans - a.n_scans)
                .map((e) => (
                  <li key={e.a} className="font-mono text-xs">
                    <button
                      onClick={() => onQuien(e.a)}
                      className="text-mut transition-colors hover:text-acc"
                      title="Poner el foco en este equipo"
                    >
                      {etiqueta(e.a)}
                    </button>
                    <span className="ml-2 text-dim">
                      {e.n_scans} esc · {e.delta_avg_ms != null ? `+${e.delta_avg_ms} ms` : "—"}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// tabla de adyacencia: un enlace por fila, ordenable por clic en la cabecera
function TablaAdyacencia({
  topo,
  orden,
  onToggleOrden,
  onFoco,
}: {
  topo: Topologia;
  orden: { campo: CampoOrden; asc: boolean };
  onToggleOrden: (campo: CampoOrden) => void;
  onFoco: (ip: string) => void;
}) {
  const info = useMemo(
    () => new Map(topo.nodos.map((n) => [n.ip, { nombre: n.nombre, rol: n.rol }] as const)),
    [topo],
  );

  const filas = useMemo(() => {
    const esc = orden.asc ? 1 : -1;
    const cmpBase: Record<CampoOrden, (a: TopoArista, b: TopoArista) => number> = {
      de: (a, b) => cmpIp(a.de, b.de) || cmpIp(a.a, b.a),
      a: (a, b) => cmpIp(a.a, b.a) || cmpIp(a.de, b.de),
      rol: (a, b) =>
        (info.get(a.a)?.rol ?? "").localeCompare(info.get(b.a)?.rol ?? "", "es") || cmpIp(a.a, b.a),
      escaneos: (a, b) => a.n_scans - b.n_scans || cmpIp(a.a, b.a),
      delta: (a, b) => (a.delta_avg_ms ?? -1) - (b.delta_avg_ms ?? -1) || cmpIp(a.a, b.a),
      ultima: (a, b) => (a.ultima ?? "").localeCompare(b.ultima ?? "") || cmpIp(a.a, b.a),
    };
    return [...topo.aristas].sort((a, b) => esc * cmpBase[orden.campo](a, b));
  }, [topo, orden, info]);

  return (
    <section className="overflow-x-auto border border-edge bg-panel p-4">
      <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
        tabla de adyacencia · {topo.aristas.length} enlaces
      </h3>
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
            {(
              [
                ["de", "de (uplink)"],
                ["a", "a (nodo)"],
                ["rol", "rol del nodo"],
                ["escaneos", "escaneos"],
                ["delta", "delta medio"],
                ["ultima", "última vez"],
              ] as [CampoOrden, string][]
            ).map(([campo, label]) => (
              <th key={campo} className="pb-1 pr-4 font-medium">
                <button
                  onClick={() => onToggleOrden(campo)}
                  title={
                    orden.campo === campo
                      ? `Ordenado por ${label} · ${orden.asc ? "ascendente" : "descendente"} — clic para invertir`
                      : `Ordenar por ${label}`
                  }
                  className={`transition-colors hover:text-acc ${orden.campo === campo ? "text-acc" : ""}`}
                >
                  {label}
                  {orden.campo === campo && <span className="ico ml-1">{orden.asc ? "▲" : "▼"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((e) => (
            <tr key={`${e.de}>${e.a}`} className="border-t border-edge font-mono text-xs transition-colors hover:bg-panel2/60">
              <td className="py-1.5 pr-4 text-mut">
                {info.get(e.de)?.nombre ? `${info.get(e.de)!.nombre} · ` : ""}
                <button onClick={() => onFoco(e.de)} className="text-fg transition-colors hover:text-acc" title="Poner el foco en este equipo">
                  {e.de}
                </button>
              </td>
              <td className="py-1.5 pr-4 text-mut">
                {info.get(e.a)?.nombre ? `${info.get(e.a)!.nombre} · ` : ""}
                <button onClick={() => onFoco(e.a)} className="text-fg transition-colors hover:text-acc" title="Poner el foco en este equipo">
                  {e.a}
                </button>
              </td>
              <td className="py-1.5 pr-4 text-mut">{info.get(e.a)?.rol ?? "—"}</td>
              <td className="py-1.5 pr-4 text-fg">
                {e.n_scans} <span className="text-dim">· {e.dispositivos_n} disp.</span>
              </td>
              <td className="py-1.5 pr-4 text-fg">{e.delta_avg_ms != null ? `${e.delta_avg_ms} ms` : "—"}</td>
              <td className="py-1.5 pr-4 text-mut">{e.ultima ? fmtHora(e.ultima) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
