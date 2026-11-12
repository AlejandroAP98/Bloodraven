import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";
import { LOGO, LogoTerm, MAPAS } from "./LogoTerm";

type Muestra = { t: number; ms: number | null; ok: boolean; texto: string };

// modo de visualización de cada sección: consola de respuestas (por defecto)
// o mini gráfica del comportamiento
type Modo = "respuesta" | "grafica";

// rango de secciones: arranca en 2 y se puede subir hasta 8 (rejilla 2 columnas)
const MIN_SEC = 2;
const MAX_SEC = 8;
// ventana visible: últimas N muestras (~2 min a 1 muestra por segundo)
const MAX_PUNTOS = 120;
const INTERVALO_MS = 1000;
const H_RE = /^[a-zA-Z0-9._-]+$/;

// alto fijo del apartado que no es cuerpo de panel (cabeceras, paddings,
// stats): se resta del alto visible de la ventana para repartir el resto
const CHROME_CUERPO = 152;
const ALTO_MIN = 92;

// mini gráfica SVG del comportamiento de ping: línea de RTT y marcas rojas
// en los pings perdidos; escala 0..techo automático
function Spark({ datos, alto }: { datos: Muestra[]; alto: number }) {
  const W = 600;
  const H = 110;
  const PAD = 6;
  const validos = datos.filter((d) => d.ms != null).map((d) => d.ms as number);
  const techo = Math.max(1, ...(validos.length ? validos : [1])) * 1.15;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, MAX_PUNTOS - 1);
  const y = (v: number) => H - PAD - (v / techo) * (H - 2 * PAD);

  // tramos continuos de RTT válido: los huecos (ping perdido) cortan la línea
  const tramos: string[] = [];
  let actual: string[] = [];
  datos.forEach((d, i) => {
    if (d.ms != null) {
      actual.push(`${actual.length ? "L" : "M"}${x(i).toFixed(1)},${y(d.ms).toFixed(1)}`);
    } else if (actual.length) {
      tramos.push(actual.join(" "));
      actual = [];
    }
  });
  if (actual.length) tramos.push(actual.join(" "));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: alto }} className="w-full text-acc">
      <line
        x1={PAD}
        y1={H - PAD}
        x2={W - PAD}
        y2={H - PAD}
        stroke="currentColor"
        className="text-edge"
        strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
      />
      {tramos.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {datos.map((d, i) =>
        !d.ok ? (
          <line
            key={i}
            x1={x(i)}
            y1={H - PAD - 6}
            x2={x(i)}
            y2={H - PAD}
            stroke="currentColor"
            className="text-crit"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
    </svg>
  );
}

// consola de respuestas al estilo de la prueba rápida: una línea por ping con
// hora y el texto que entrega el backend; auto-scroll al final
function Consola({ lineas, alto }: { lineas: Muestra[]; alto: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lineas]);
  return (
    <div
      ref={box}
      style={{ height: alto }}
      className="term overflow-y-auto border border-edge bg-void p-2 font-mono text-[10px] text-acc"
    >
      {lineas.map((l) => (
        <p key={l.t} className={l.ok ? "" : "text-crit"}>
          <span className="text-dim">{new Date(l.t).toLocaleTimeString()}</span> {l.texto}
        </p>
      ))}
    </div>
  );
}

function SeccionPing({
  indice,
  host,
  onHost,
  onQuitar,
  puedeQuitar,
  corriendo,
  alto,
}: {
  indice: number;
  host: string;
  onHost: (v: string) => void;
  onQuitar: () => void;
  puedeQuitar: boolean;
  corriendo: boolean;
  /** altura del cuerpo (gráfica/consola): la fija el padre según la cantidad de secciones */
  alto: number;
}) {
  const [muestras, setMuestras] = useState<Muestra[]>([]);
  const [aviso, setAviso] = useState("");
  const [modo, setModo] = useState<Modo>("respuesta");
  const hostRef = useRef(host);
  hostRef.current = host;

  // ciclo de ping de esta sección: vive mientras `corriendo` esté activo; el
  // cleanup corta el fetch en vuelo para que detener sea instantáneo
  useEffect(() => {
    if (!corriendo) {
      setAviso("");
      return;
    }
    const h = hostRef.current.trim();
    if (!h) {
      setAviso("sin IP: escribe una dirección para monitorearla");
      return;
    }
    if (!H_RE.test(h)) {
      setAviso("IP o host no válido (letras, dígitos, punto y guion)");
      return;
    }
    setAviso("");
    setMuestras([]);
    let vivo = true;
    const aborta = new AbortController();
    const ciclo = async () => {
      while (vivo) {
        try {
          const r = await api.pruebaPing(h, aborta.signal);
          if (vivo)
            setMuestras((prev) => [
              ...prev.slice(-(MAX_PUNTOS - 1)),
              {
                t: Date.now(),
                ms: r.ok && r.rtt_ms != null ? r.rtt_ms : null,
                ok: r.ok,
                texto: r.linea,
              },
            ]);
        } catch {
          if (vivo)
            setMuestras((prev) => [
              ...prev.slice(-(MAX_PUNTOS - 1)),
              { t: Date.now(), ms: null, ok: false, texto: "sin conexión con el servidor Bloodraven." },
            ]);
        }
        await new Promise((res) => setTimeout(res, INTERVALO_MS));
      }
    };
    ciclo();
    return () => {
      vivo = false;
      aborta.abort();
    };
  }, [corriendo]);

  // métricas de la ventana visible
  const total = muestras.length;
  const rtts = muestras.filter((m) => m.ms != null).map((m) => m.ms as number);
  const ultimo = muestras.length ? (muestras[muestras.length - 1].ms ?? null) : null;
  const media = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
  const max = rtts.length ? Math.max(...rtts) : null;
  const perdida = total ? (100 * (total - rtts.length)) / total : null;
  const num = (v: number | null) => (v != null ? `${v.toFixed(1)} ms` : "—");

  return (
    <div className="border border-edge bg-void/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[10px] text-dim">0{indice + 1}</span>
        <input
          value={host}
          onChange={(e) => onHost(e.target.value)}
          placeholder="192.168.1.1 o router.local"
          spellCheck={false}
          className="min-w-0 flex-1 border border-edge bg-void px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-dim focus:border-acc/60 focus:outline-none"
        />
        <div className="flex shrink-0 border border-edge">
          <button
            type="button"
            title="mostrar las respuestas del ping una por una"
            onClick={() => setModo("respuesta")}
            className={`px-2 py-1.5 font-mono text-[10px] uppercase not-last:border-r transition-colors ${
              modo === "respuesta" ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"
            }`}
          >
            respuesta
          </button>
          <button
            type="button"
            title="mostrar la mini gráfica del comportamiento"
            onClick={() => setModo("grafica")}
            className={`px-2 py-1.5 font-mono text-[10px] uppercase transition-colors ${
              modo === "grafica" ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"
            }`}
          >
            gráfica
          </button>
        </div>
        {puedeQuitar && (
          <button
            type="button"
            title="quitar esta sección"
            onClick={onQuitar}
            className="border border-edge bg-panel px-2 py-1.5 font-mono text-xs text-mut transition-colors hover:border-crit/50 hover:text-crit"
          >
            ×
          </button>
        )}
      </div>

      {total ? (
        modo === "grafica" ? (
          <Spark datos={muestras} alto={alto} />
        ) : (
          <Consola lineas={muestras} alto={alto} />
        )
      ) : (
        <div style={{ height: alto }} className="flex items-center justify-center overflow-hidden">
          <LogoTerm
            arte={LOGO}
            tamano={Math.max(5, Math.min(11, Math.floor((alto - 44) / 21)))}
            mapa={MAPAS.sangre}
          >
            <span className={`font-mono text-[10px] ${aviso ? "text-crit" : "text-dim"}`}>
              {aviso || (corriendo ? "esperando primeras muestras…" : "escribe una IP y pulsa iniciar")}
            </span>
          </LogoTerm>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[10px] text-mut">
        {total ? (
          <>
            <span>
              último <b className="text-fg">{num(ultimo)}</b>
            </span>
            <span>
              media <b className="text-fg">{num(media)}</b>
            </span>
            <span>
              máx <b className="text-fg">{num(max)}</b>
            </span>
            <span className={perdida && perdida > 0 ? "text-crit" : undefined}>
              pérdida <b>{perdida != null ? `${perdida.toFixed(0)} %` : "—"}</b>
            </span>
          </>
        ) : (
          <span className={aviso ? "text-crit" : undefined}>{aviso || "\u00a0"}</span>
        )}
      </div>
    </div>
  );
}

// apartado de la vista Comparar: N secciones de ping en vivo (ad-hoc), cada
// una con su input de IP y un botón al lado para aumentar la cantidad
export function ComparadorPing() {
  const [hosts, setHosts] = useState<string[]>(Array(MIN_SEC).fill(""));
  const [corriendo, setCorriendo] = useState(false);
  const [alto, setAlto] = useState(200);
  const sec = useRef<HTMLElement>(null);
  const n = hosts.length;
  const algunoEscrito = hosts.some((h) => h.trim());

  // el cuerpo de cada sección se adapta al alto real de la ventana: mide
  // dónde queda el apartado y reparte el resto entre las filas de la rejilla
  const medir = useCallback(() => {
    const el = sec.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const cols = window.innerWidth >= 768 ? 2 : 1;
    const filas = Math.ceil(n / cols);
    const cuerpo = Math.round((window.innerHeight - top - CHROME_CUERPO) / filas);
    setAlto(Math.max(ALTO_MIN, cuerpo));
  }, [n]);

  useEffect(() => {
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [medir]);

  const agregar = () => {
    if (n >= MAX_SEC) return;
    setHosts((hs) => [...hs, ""]);
  };
  const quitar = (i: number) => {
    if (n <= MIN_SEC) return;
    setHosts((hs) => hs.filter((_, k) => k !== i));
  };

  return (
    <section ref={sec} className="border border-edge bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          ping en vivo <span className="text-edgehi">/</span> comparación ad-hoc
        </h3>
        <span className="font-mono text-xs text-mut">{n} secciones</span>
        <button
          type="button"
          title="agregar otra sección de ping"
          onClick={agregar}
          disabled={n >= MAX_SEC}
          className="border border-acc/40 bg-acc/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-40"
        >
          <span className="ico">+</span> sección
        </button>
        {corriendo ? (
          <button
            type="button"
            onClick={() => setCorriendo(false)}
            className="border border-crit/50 bg-crit/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-crit transition-colors hover:bg-crit/20"
          >
            detener
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setCorriendo(true)}
            disabled={!algunoEscrito}
            className="border border-acc/50 bg-acc/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
          >
            iniciar
          </button>
        )}
        <span className="ml-auto font-mono text-[10px] text-mut">
          1 s por muestra · ventana de ~2 min · cada IP se sondea en paralelo
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {hosts.map((h, i) => (
          <SeccionPing
            key={i}
            indice={i}
            host={h}
            onHost={(v) => setHosts((hs) => hs.map((x, k) => (k === i ? v : x)))}
            onQuitar={() => quitar(i)}
            puedeQuitar={n > MIN_SEC}
            corriendo={corriendo}
            alto={alto}
          />
        ))}
      </div>
    </section>
  );
}
