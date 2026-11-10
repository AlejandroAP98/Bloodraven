import { useEffect, useMemo, useRef, useState } from "react";

import { api, fmtHora } from "./api";
import type { TopoArista, TopoNodo, TopologiaGeneral, TopoSel } from "./api";
import { BotonCopiar } from "./BotonCopiar";

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

// geometría del grafo (radial: la raíz queda al centro y cada rango BFS
// forma un anillo concéntrico; los hijos se reparten alrededor de su padre)
const W_NODO = 148;
const H_NODO = 32;
// radio (px) mínimo entre anillos consecutivos; se agranda si algún anillo
// no cabe en su circunferencia
const RING_R = 155;
// arco (px) mínimo que ocupa un nodo al calcular el radio que necesita un anillo
const SEP = W_NODO + 26;

type CampoOrden = "de" | "a" | "rol" | "escaneos" | "delta" | "ultima";

type Punto = { x: number; y: number };

// normaliza un ángulo a [0, 2π)
const normAng = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// punto de entrada/salida del enlace sobre el borde de la caja del nodo:
// intersección del segmento centro→centro con el rectángulo del nodo
function bordeHacia(cx: number, cy: number, ox: number, oy: number): Punto {
  const dx = ox - cx;
  const dy = oy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const escX = dx === 0 ? Infinity : W_NODO / 2 / Math.abs(dx);
  const escY = dy === 0 ? Infinity : H_NODO / 2 / Math.abs(dy);
  const s = Math.min(escX, escY);
  return { x: cx + dx * s, y: cy + dy * s };
}

// trazo de un enlace entre los centros de dos nodos, recortado en los bordes
// de ambas cajas y con una curvatura suave (da aire a los enlaces radiales)
function trazoEnlace(c1: Punto, c2: Punto): string {
  const a = bordeHacia(c1.x, c1.y, c2.x, c2.y);
  const b = bordeHacia(c2.x, c2.y, c1.x, c1.y);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const k = Math.min(40, dist * 0.12);
  const mx = (a.x + b.x) / 2 - (dy / dist) * k;
  const my = (a.y + b.y) / 2 + (dx / dist) * k;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

// comparación de IP por octetos
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

// pestaña "general" de la sección Topología: el panel de selección vive aquí,
// la cabecera (botón volver, título, tabs y búsqueda) la pone la vista dueña
export function GeneralView({
  busca,
  onVerDevice,
}: {
  busca: string;
  onVerDevice: (id: string) => void;
}) {
  const horas = 24; // ventana fija de rutas observadas
  const [topo, setTopo] = useState<TopologiaGeneral | null>(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  const [foco, setFoco] = useState<string | null>(null); // ip del nodo enfocado
  const [orden, setOrden] = useState<{ campo: CampoOrden; asc: boolean }>({ campo: "de", asc: true });

  const cargar = () => {
    setCargando(true);
    return api
      .topologiaGeneral(horas)
      .then((t) => {
        setTopo(t);
        setError("");
        setFoco(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setCargando(false));
  };

  useEffect(() => {
    cargar();
    // la vista se carga una sola vez: la selección y el grafo refrescan bajo demanda
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // marcar o quitar un dispositivo del mapa general: persiste en DB y refresca el grafo
  const alternar = async (d: TopoSel) => {
    // actualización optimista del panel; el grafo refresca tras el PUT
    setTopo((t) =>
      t
        ? {
            ...t,
            seleccion: t.seleccion.map((s) => (s.id === d.id ? { ...s, incluido: !d.incluido } : s)),
          }
        : t,
    );
    try {
      await api.incluirTopologia(d.id, !d.incluido);
    } catch {
      setTopo((t) =>
        t
          ? {
              ...t,
              seleccion: t.seleccion.map((s) => (s.id === d.id ? { ...s, incluido: d.incluido } : s)),
            }
          : t,
      );
      return;
    }
    await cargar();
  };

  // reinicia el mapa persistido y lo rehace con la selección actual
  const reasentar = async () => {
    if (
      !confirm(
        "¿Reasentar la topología general?\n\nSe borra el grafo guardado y se rehace solo con los escaneos recientes de los dispositivos incluidos."
      )
    )
      return;
    try {
      const t = await api.reasentarTopologia();
      setTopo(t);
      setError("");
      setFoco(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // quita del mapa persistido el nodo del dispositivo (acción manual)
  const quitar = async (d: TopoSel) => {
    if (!confirm(`¿Quitar "${d.nombre}" del mapa persistido?\\n\\nSe borra su nodo registrado y los enlaces que toca su ip.`)) return;
    try {
      const ok = await api.quitarTopologia(d.id);
      if (!ok) throw Error("no se pudo quitar");
    } catch {
      /* el refetch mostrará el estado real */
    }
    await cargar();
  };

  // quita un nodo concreto del mapa persistido (por ip; funciona incluso si
  // su dispositivo ya no está en el monitoreo)
  const quitarNodo = async (ip: string) => {
    if (!confirm(`¿Quitar el nodo ${ip} del mapa persistido?\\n\\nSe borra y también sus enlaces tocados.`)) return;
    try {
      const ok = await api.quitarNodoTopo(ip);
      if (!ok) throw Error("no se pudo quitar");
    } catch {
      /* el refetch mostrará el estado real */
    }
    setFoco(null);
    await cargar();
  };

  const mapNodos = useMemo(
    () => new Map((topo?.nodos ?? []).map((n) => [n.ip, n] as const)),
    [topo],
  );

  // layout radial: la raíz (rango 0) queda en el centro y cada rango BFS
  // forma un anillo concéntrico. El ángulo de cada nodo parte del arco de
  // su padre: se reparte el círculo proporcional a las hojas de cada subárbol,
  // así los nodos vecinos quedan agrupados junto a su equipo superior y las
  // aristas se cruzan poco (útil cuando no todos se conectan con todos).
  // El padre de cada nodo es su uplink con más escaneos (mismo criterio del
  // foco). Los nodos isla van en un anillo exterior, borde punteado.
  const layout = useMemo(() => {
    if (!topo) return null;
    if (topo.nodos.length === 0) return { pos: new Map(), width: 0, height: 0 };
    const normales: TopoNodo[] = [];
    const islas: TopoNodo[] = [];
    for (const n of topo.nodos) (n.isla ? islas : normales).push(n);

    // anillo de cada nodo; con varias raíces se reservan el anillo interior
    // (repartidas alrededor del centro) y todo lo demás se corre un anillo
    const raices = normales.filter((n) => n.rango === 0);
    const desfase = raices.length > 1 ? 1 : 0;
    const anilloDe = (n: TopoNodo) => (n.rango === 0 ? (desfase ? 1 : 0) : n.rango + desfase);

    // radio mínimo: cada anillo debe poder dar la vuelta completa sin
    // encimar cajas (circunferencia ≥ nodos × separación mínima)
    const cuentaAnillo = new Map<number, number>();
    for (const n of normales) {
      const r = anilloDe(n);
      cuentaAnillo.set(r, (cuentaAnillo.get(r) ?? 0) + 1);
    }
    const maxAnillo = Math.max(0, ...cuentaAnillo.keys());
    const anilloIslas = islas.length ? maxAnillo + 1 : 0;
    let R = RING_R;
    for (const [r, k] of cuentaAnillo) if (r > 0) R = Math.max(R, (SEP * k) / (2 * Math.PI * r));
    if (islas.length) R = Math.max(R, (SEP * islas.length) / (2 * Math.PI * anilloIslas));

    // árbol de expansión: padre de cada nodo = su uplink con más escaneos
    const mapa = new Map(normales.map((n) => [n.ip, n] as const));
    const hijos = new Map<string, TopoNodo[]>();
    for (const n of normales) {
      if (n.rango === 0) continue;
      let mejor: TopoNodo | null = null;
      let mejorN = -1;
      for (const e of topo.aristas) {
        if (e.a !== n.ip) continue;
        const p = mapa.get(e.de);
        if (!p) continue;
        if (anilloDe(p) >= anilloDe(n)) continue; // solo enlaces hacia el centro
        if (e.n_scans > mejorN || (e.n_scans === mejorN && mejor && cmpIp(e.de, mejor.ip) < 0)) {
          mejor = p;
          mejorN = e.n_scans;
        }
      }
      if (mejor) {
        if (!hijos.has(mejor.ip)) hijos.set(mejor.ip, []);
        hijos.get(mejor.ip)!.push(n);
      }
    }

    // hojas por subárbol: define el arco angular que se lleva cada rama
    const hojas = new Map<string, number>();
    const calcHojas = (n: TopoNodo): number => {
      const hs = hijos.get(n.ip) ?? [];
      const h = hs.length ? hs.reduce((s, c) => s + calcHojas(c), 0) : 1;
      hojas.set(n.ip, h);
      return h;
    };

    // árboles a repartir: raíces + huérfanos (sin uplink válido hacia dentro)
    const arboles = raices.map((n) => ({ n, h: calcHojas(n) }));
    for (const n of normales) {
      if (n.rango === 0 || hojas.has(n.ip)) continue;
      hojas.set(n.ip, 1);
      arboles.push({ n, h: 1 });
    }
    const total = Math.max(1, arboles.reduce((s, t) => s + t.h, 0));

    // repartición angular: cada nodo queda al centro del arco de su subárbol
    // y sus hijos heredan ese arco repartido proporcional a sus hojas
    const angulo = new Map<string, number>();
    const asignar = (n: TopoNodo, a0: number, span: number) => {
      angulo.set(n.ip, a0 + span / 2);
      const hs = hijos.get(n.ip) ?? [];
      const H = hojas.get(n.ip) ?? 1;
      let a = a0;
      for (const c of hs) {
        const s = (span * (hojas.get(c.ip) ?? 1)) / H;
        asignar(c, a, s);
        a += s;
      }
    };
    let a0 = -Math.PI / 2; // se empieza arriba y se gira en sentido horario
    for (const t of arboles) {
      const span = (2 * Math.PI * t.h) / total;
      asignar(t.n, a0, span);
      a0 += span;
    }

    // islas: repartición uniforme en su anillo exterior (sin árbol padre)
    if (islas.length)
      islas.forEach((n, i) => angulo.set(n.ip, normAng(-Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / islas.length)));

    // relajación: si en un anillo dos nodos quedan más cerca que una caja
    // tras el reparto del árbol, se separan (conservando su vecindad global)
    const porAnillo = new Map<number, TopoNodo[]>();
    for (const n of topo.nodos) {
      const r = n.isla ? anilloIslas : anilloDe(n);
      if (!porAnillo.has(r)) porAnillo.set(r, []);
      porAnillo.get(r)!.push(n);
    }
    for (const [r, lista] of porAnillo) {
      if (r === 0 || lista.length < 2) continue; // el centro no necesita giro
      const rr = r * R;
      const minGap = SEP / rr;
      for (let pasada = 0; pasada < 4; pasada++) {
        const arr = lista.map((n) => ({ n, a: normAng(angulo.get(n.ip) ?? 0) })).sort((x, y) => x.a - y.a);
        for (let i = 0; i < arr.length; i++) {
          const A = arr[i];
          const B = arr[(i + 1) % arr.length];
          let gap = (B.a - A.a + 2 * Math.PI) % (2 * Math.PI);
          if (i === arr.length - 1 && gap === 0) gap = 2 * Math.PI;
          if (gap >= minGap) continue;
          const corr = (minGap - gap) / 2;
          angulo.set(A.n.ip, A.a - corr);
          angulo.set(B.n.ip, B.a + corr);
        }
      }
    }

    // canvas cuadrado: centro + anillo exterior + caja completa
    const maxR = Math.max(0, ...porAnillo.keys());
    const side = 2 * (maxR * R + SEP) + 20;
    const cx = side / 2;
    const cy = side / 2;
    const pos = new Map<string, { x: number; y: number }>();
    for (const n of topo.nodos) {
      const r = n.isla ? anilloIslas : anilloDe(n);
      const a = angulo.get(n.ip) ?? 0;
      const X = cx + r * R * Math.cos(a);
      const Y = cy + r * R * Math.sin(a);
      pos.set(n.ip, { x: X - W_NODO / 2, y: Y - H_NODO / 2 });
    }
    return { pos, width: side, height: side };
  }, [topo]);

  // vista del lienzo: escala + traslación (zoom con rueda, arrastre para mover)
  const [vista, setVista] = useState({ k: 1, x: 0, y: 0 });
  const cajaRef = useRef<HTMLDivElement>(null);
  const arrastra = useRef<{ id: number; sx: number; sy: number; x0: number; y0: number; pan?: boolean } | null>(null);
  // px acumulados del último arrastre: si superan un umbral el clic en nodo no aplica
  const movio = useRef(0);

  // encuadre inicial (al recalcular el grafo): nunca empieza más lejos de
  // 55% y nunca más cerca de 100%; se centra el grafo en el marco
  const encuadreInicial = () => {
    const el = cajaRef.current;
    if (!layout || !el) return;
    const ktodo = Math.min(el.clientWidth / layout.width, el.clientHeight / layout.height);
    const k = Math.max(0.55, Math.min(1, ktodo));
    setVista({ k, x: (el.clientWidth - layout.width * k) / 2, y: (el.clientHeight - layout.height * k) / 2 });
  };
  useEffect(() => {
    encuadreInicial();
    // solo cuando cambia el grafo (el ref de la caja es estable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // zoom con la rueda fijando el punto bajo el cursor (listener no pasivo para
  // poder cortar el scroll de la página). Va atado a layout: la caja solo
  // existe cuando ya hay grafo que renderizar (al montar aún es null).
  useEffect(() => {
    const el = cajaRef.current;
    if (!el) return;
    const zoomba = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      setVista((v) => {
        const k = Math.min(3, Math.max(0.05, v.k * Math.exp(-ev.deltaY * 0.0018)));
        const f = k / v.k;
        return { k, x: mx - (mx - v.x) * f, y: my - (my - v.y) * f };
      });
    };
    el.addEventListener("wheel", zoomba, { passive: false });
    return () => el.removeEventListener("wheel", zoomba);
  }, [layout]);

  // todo el grafo dentro del marco (botón "ajustar", sin límites de escala)
  const ajustar = () => {
    const el = cajaRef.current;
    if (!layout || !el) return;
    const k = Math.max(0.02, Math.min(el.clientWidth / layout.width, el.clientHeight / layout.height));
    setVista({ k, x: (el.clientWidth - layout.width * k) / 2, y: (el.clientHeight - layout.height * k) / 2 });
  };

  // con los botones el zoom va centrado en el centro del marco
  const zooma = (f: number) => {
    const el = cajaRef.current;
    if (!el) return;
    setVista((v) => {
      const k = Math.min(3, Math.max(0.05, v.k * f));
      const g = k / v.k;
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      return { k, x: cx - (cx - v.x) * g, y: cy - (cy - v.y) * g };
    });
  };

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

  const nIncluidos = topo?.seleccion.filter((s) => s.incluido).length ?? 0;

  const toggleOrden = (campo: CampoOrden) =>
    setOrden((o) => (o.campo === campo ? { campo, asc: !o.asc } : { campo, asc: true }));

  if (error) {
    return (
      <p className="border border-crit/40 bg-crit/10 p-3 font-mono text-xs text-crit">
        error al calcular la topología general: {error}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {cargando && !topo && !error && <p className="font-mono text-xs text-mut">calculando la topología general…</p>}

      {topo && (
        <PanelSeleccion
          seleccion={topo.seleccion}
          nIncluidos={nIncluidos}
          onAlternar={alternar}
          onVerDevice={onVerDevice}
          onReasentar={reasentar}
          onQuitar={quitar}
        />
      )}

      {topo && topo.nodos.length === 0 && nIncluidos > 0 && (
        <p className="border border-edge bg-panel p-4 font-mono text-xs text-mut">
          Cada dispositivo incluido aparece aquí como nodo con su información (nombre, host) aunque aún no tenga
          escaneos de ruta; sus enlaces se registran según capture sus traceroutes y todo queda persistido.
        </p>
      )}

      {topo && layout && topo.nodos.length > 0 && (
        <section className="border border-edge bg-panel p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">grafo · anillos radiales desde la raíz</h3>
            <span className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-dim">
                rueda: zoom · arrastrar: mover · clic: foco · punteado = enlace de regreso
              </span>
              <button
                onClick={() => zooma(1.25)}
                title="Acercar"
                className="border border-edge px-2 py-0.5 font-mono text-xs text-mut transition-colors hover:border-edgehi hover:text-fg"
              >
                +
              </button>
              <button
                onClick={() => zooma(0.8)}
                title="Alejar"
                className="border border-edge px-2 py-0.5 font-mono text-xs text-mut transition-colors hover:border-edgehi hover:text-fg"
              >
                −
              </button>
              <button
                onClick={ajustar}
                title="Encuadrar todo el grafo en el marco"
                className="border border-edge px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-mut transition-colors hover:border-edgehi hover:text-fg"
              >
                ajustar
              </button>
            </span>
          </div>
          <div
            ref={cajaRef}
            className="relative h-[72vh] min-h-[440px] touch-none select-none overflow-hidden border border-edge bg-void cursor-grab active:cursor-grabbing"
            onPointerDown={(ev) => {
              if (ev.button !== 0) return;
              // sin capturar de una: la captura redirige el click al contenedor
              // y los nodos dejan de recibirlo; se captura al empezar el pan
              arrastra.current = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, x0: vista.x, y0: vista.y };
              movio.current = 0;
            }}
            onPointerMove={(ev) => {
              const a = arrastra.current;
              if (!a || a.id !== ev.pointerId) return;
              const d = Math.hypot(ev.clientX - a.sx, ev.clientY - a.sy);
              movio.current = d;
              if (d <= 5) return;
              // a partir de aquí es pan: captura el puntero para seguir el
              // arrastre aunque salga del marco (y click ya no llega a nodos)
              if (!a.pan) {
                ev.currentTarget.setPointerCapture(ev.pointerId);
                a.pan = true;
              }
              setVista((v) => ({ ...v, x: a.x0 + ev.clientX - a.sx, y: a.y0 + ev.clientY - a.sy }));
            }}
            onPointerUp={(ev) => {
              if (arrastra.current?.id === ev.pointerId) arrastra.current = null;
            }}
            onPointerCancel={() => {
              arrastra.current = null;
            }}
          >
            <svg
              width={layout.width}
              height={layout.height}
              style={{ transform: `translate(${vista.x}px, ${vista.y}px) scale(${vista.k})`, transformOrigin: "0 0" }}
            >
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
                const c1 = { x: p1.x + W_NODO / 2, y: p1.y + H_NODO / 2 };
                const c2 = { x: p2.x + W_NODO / 2, y: p2.y + H_NODO / 2 };
                const d = trazoEnlace(c1, c2);
                return (
                  <path
                    key={llave}
                    d={d}
                    fill="none"
                    stroke="var(--color-edgehi)"
                    strokeWidth={Math.min(4, 1.2 + e.n_scans / 40)}
                    strokeDasharray={regresa ? "5 4" : e.inactiva ? "2 3" : undefined}
                    opacity={atenuado ? 0.3 : resaltado ? 0.95 : e.inactiva ? 0.35 : 0.65}
                  >
                    <title>
                      {`${e.de} → ${e.a}`}
                      {`\n${e.n_scans} escaneos de ${e.dispositivos_n} dispositivo(s)`}
                      {e.delta_avg_ms != null ? `\ndelta medio del tramo: ${e.delta_avg_ms} ms` : ""}
                      {e.ultima ? `\núltima vez: ${fmtHora(e.ultima)}` : ""}
                      {e.inactiva ? "\npersistido: sin escaneos recientes" : ""}
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
                // el foco y los nodos de su cadena se ven a plena opacidad
                // (antes un nodo inactivo enfocado quedaba a 0.8 y perdía brillo)
                const resaltado = !!activos && !atenuado;
                return (
                  <g
                    key={n.ip}
                    opacity={esFoco || resaltado ? 1 : atenuado ? 0.4 : n.inactiva ? (n.device_id ? 0.8 : 0.55) : 1}
                    onClick={() => {
                      // tras un arrastre de pan el clic no cambia el foco
                      if (movio.current > 6) return;
                      setFoco((f) => (f === n.ip ? null : n.ip));
                    }}
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
                      {n.host && n.host !== n.ip ? `\nhost: ${n.host}` : ""}
                      {n.rol ? `\nrol: ${n.rol}` : ""}
                      {`\nvisto en ${n.vistos} escaneos · ${n.dispositivos_n} dispositivo(s)`}
                      {n.rtt_avg_ms != null ? `\nrtt medio: ${n.rtt_avg_ms} ms` : ""}
                      {n.ultima ? `\núltima vez: ${fmtHora(n.ultima)}` : ""}
                      {n.isla ? "\nsin camino hacia la raíz" : ""}
                      {n.inactiva ? "\npersistido: sin escaneos recientes" : ""}
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
              onQuitarNodo={quitarNodo}
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
    </div>
  );
}

// panel de selección: todos los dispositivos vigilados, con toggle de
// alimentación y acción manual de registro/quitar
function PanelSeleccion({
  seleccion,
  nIncluidos,
  onAlternar,
  onVerDevice,
  onReasentar,
  onQuitar,
}: {
  seleccion: TopoSel[];
  nIncluidos: number;
  onAlternar: (d: TopoSel) => void;
  onVerDevice: (id: string) => void;
  onReasentar: () => void;
  onQuitar: (d: TopoSel) => void;
}) {
  return (
    <section className="border border-edge bg-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          dispositivos en topología · {nIncluidos}/{seleccion.length}
        </h3>
        <span className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-dim">
            se registra poco a poco · lo integrado queda aunque deje de vigilarse · solo sale si lo quitas o reasentas
          </span>
          <button
            onClick={onReasentar}
            title="Borrar el grafo guardado y rehacerlo solo con los escaneos recientes de los dispositivos incluidos"
            className="shrink-0 border border-warn/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-warn transition-colors hover:bg-warn/10"
          >
            reasentar
          </button>
        </span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {seleccion.map((d) => (
          <div
            key={d.id}
            className={`flex items-center gap-2 border px-2.5 py-1.5 transition-colors ${
              d.incluido ? "border-acc/50 bg-acc/5" : "border-edge bg-void"
            }`}
          >
            <button
              onClick={() => onVerDevice(d.id)}
              title="Abrir el detalle del dispositivo"
              className="min-w-0 flex-1 truncate text-left font-mono text-xs text-mut transition-colors hover:text-fg"
            >
              <span className={`font-semibold ${d.incluido ? "text-fg" : ""}`}>{d.nombre}</span>
              <span className="ml-2 text-dim">{d.host}</span>
            </button>
            <button
              onClick={() => onAlternar(d)}
              title={d.incluido ? "Desmarcar: deja de alimentar el grafo con sus escaneos (su nodo registrado permanece)" : "Incluir: registra su nodo en el mapa y alimenta el grafo con sus traceroutes"}
              className={`shrink-0 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                d.incluido
                  ? "border-acc/60 text-acc hover:bg-acc/15"
                  : "border-edge text-mut hover:border-edgehi hover:text-fg"
              }`}
            >
              {d.incluido ? "incluido" : "añadir"}
            </button>
            <button
              onClick={() => onQuitar(d)}
              title="Quitar del mapa persistido: borra su nodo registrado y los enlaces que toca su ip"
              className="shrink-0 border border-edge px-1.5 py-0.5 font-mono text-[10px] text-dim transition-colors hover:border-crit/50 hover:text-crit"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// tarjeta del nodo enfocado: identidad, métricas, vecinos y acciones
function FocoCard({
  nodo,
  subs,
  bajs,
  mapNodos,
  onVerDevice,
  onQuien,
  onLimpiar,
  onQuitarNodo,
}: {
  nodo: TopoNodo;
  subs: TopoArista[];
  bajs: TopoArista[];
  mapNodos: Map<string, TopoNodo>;
  onVerDevice: (id: string) => void;
  onQuien: (ip: string) => void;
  onLimpiar: () => void;
  onQuitarNodo: (ip: string) => void;
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
            onClick={() => onQuitarNodo(nodo.ip)}
            title="Quitar este nodo del mapa persistido (borra también los enlaces que toca su ip)"
            className="border border-crit/40 bg-crit/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-crit transition-colors hover:bg-crit/15"
          >
            quitar del mapa
          </button>
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
  topo: TopologiaGeneral;
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
