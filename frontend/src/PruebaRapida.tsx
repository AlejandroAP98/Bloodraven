import { useEffect, useRef, useState } from "react";

import { api } from "./api";
import type { EquipoRed, Hop } from "./api";
import { ListadoHops } from "./ListadoHops";
import { BANNER, LogoTerm, MAPAS } from "./LogoTerm";

type Linea = { t: number; texto: string; ok: boolean };

const H_RE = /^[a-zA-Z0-9._-]+$/;

export function PruebaRapida({
  onAgregar,
  amplicado = false,
  hostInicial = "",
  autoIniciar = false,
  banner = false,
}: {
  /** agrega el host en prueba como dispositivo de seguimiento (abre el formulario precargado) */
  onAgregar?: (host: string, nombre: string | null) => void;
  /** pestaña dedicada: consola y ruta ocupan todo el tamaño disponible */
  amplicado?: boolean;
  /** host con el que precargar el campo (pestaña ?prueba=…) */
  hostInicial?: string;
  /** arranca el sondeo al montar usando hostInicial */
  autoIniciar?: boolean;
  /** página de inicio: la consola vacía muestra el banner de la marca en vez del cuervo */
  banner?: boolean;
}) {
  const [host, setHost] = useState("");
  const [activo, setActivo] = useState<string | null>(null);
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [hops, setHops] = useState<Hop[]>([]);
  const [rutaEstado, setRutaEstado] = useState("");
  const [equipo, setEquipo] = useState<EquipoRed | null>(null);
  const [error, setError] = useState("");

  // el ciclo de ping muere comparando la corrida contra este contador; el
  // controller corta el fetch en vuelo para que detener sea instantáneo
  const corrida = useRef(0);
  const aborta = useRef<AbortController | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const catalogo = useRef<Map<string, { nombre: string; rol: string }>>(new Map());

  // catálogo (una sola carga): para etiquetar saltos y el host ingresado
  useEffect(() => {
    let vivo = true;
    api
      .equipos()
      .then((es) => {
        if (!vivo) return;
        catalogo.current = new Map(es.map((e) => [e.ip, { nombre: e.nombre, rol: e.rol }]));
      })
      .catch(() => /* el panel vive sin catálogo */ {});
    return () => {
      vivo = false;
    };
  }, []);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lineas]);

  // corta la corrida anterior: aborta el fetch en vuelo y avanza el contador
  const cortarPrevio = () => {
    corrida.current += 1;
    aborta.current?.abort();
    aborta.current = null;
  };

  const detener = () => {
    cortarPrevio();
    setActivo(null);
    setRutaEstado("");
  };

  const lanzar = async (h: string) => {
    setError("");
    if (!H_RE.test(h)) {
      setError("ingresa una IP o host válido (letras, dígitos, punto y guion)");
      return;
    }
    cortarPrevio();
    const id = corrida.current;
    aborta.current = new AbortController();
    const senal = aborta.current.signal;
    setActivo(h);
    setLineas([]);
    setHops([]);
    setRutaEstado("");
    api
      .buscarEquipo(h, senal)
      .then((e) => setEquipo(e))
      .catch(() => setEquipo(null));

    const ciclo = async () => {
      while (corrida.current === id) {
        try {
          const r = await api.pruebaPing(h, senal);
          if (corrida.current === id)
            setLineas((prev) => [...prev.slice(-199), { t: Date.now(), texto: r.linea, ok: r.ok }]);
        } catch {
          if (corrida.current === id)
            setLineas((prev) => [
              ...prev.slice(-199),
              { t: Date.now(), texto: "sin conexión con el servidor Bloodraven.", ok: false },
            ]);
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    };
    ciclo();

    // traceroute en paralelo (una sola vez por corrida)
    try {
      setRutaEstado("trazando ruta… (hasta ~90 s si el destino no responde)");
      const r = await api.pruebaRuta(h, senal);
      if (corrida.current === id) {
        setHops(r.hops);
        setRutaEstado(r.hops.length ? "" : "sin saltos alcanzables");
      }
    } catch (e) {
      if (corrida.current === id) setRutaEstado(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const iniciar = (ev: React.FormEvent) => {
    ev.preventDefault();
    lanzar(host.trim());
  };

  // pestaña dedicada: precarga el host y arranca el sondeo al montar
  useEffect(() => {
    const h = hostInicial.trim();
    if (!h) return;
    setHost(h);
    if (autoIniciar) lanzar(h);
    // solo al montar: el host de la pestaña no cambia después
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section
      className={
        amplicado ? "flex min-h-0 flex-1 flex-col border border-edge bg-panel p-4" : "border border-edge bg-panel p-4"
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          prueba rápida <span className="text-edgehi">/</span> ping + ruta ad-hoc
        </h3>
        <form onSubmit={iniciar} className="flex items-center gap-2">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.1 o router.local"
            spellCheck={false}
            className="w-72 border border-edge bg-void px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-dim focus:border-acc/60 focus:outline-none"
          />
          {activo ? (
            <button
              key="detener"
              type="button"
              onClick={(e) => {
                // preventDefault: al re-render se reutiliza el mismo <button> y
                // quedaría type=submit; el default del clic lanzaría el submit
                e.preventDefault();
                e.stopPropagation();
                detener();
              }}
              className="border border-crit/50 bg-crit/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-crit transition-colors hover:bg-crit/20"
            >
              detener
            </button>
          ) : (
            <button
              key="iniciar"
              type="submit"
              disabled={!host.trim()}
              className="border border-acc/50 bg-acc/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
            >
              iniciar
            </button>
          )}
        </form>
        <button
          type="button"
          title="abrir esta prueba en una pestaña propia, a todo el tamaño disponible"
          onClick={() => {
            window.open(
              `${location.pathname}?prueba=${encodeURIComponent(host.trim())}`,
              "_blank",
              "noopener",
            );
          }}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
        >
          <span className="ico">⤢</span> ampliar
        </button>
        {activo && onAgregar && (
          <button
            type="button"
            onClick={() => onAgregar(activo, equipo?.nombre ?? null)}
            title="agregar a la lista de seguimiento continuo"
            className="border border-acc/40 bg-acc/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20"
          >
            <span className="ico">+</span> dispositivo
          </button>
        )}
        {equipo ? (
          <span
            title={`catálogo · ${equipo.rol}${equipo.notas ? ` — ${equipo.notas}` : ""}`}
            className="border border-ok/40 bg-ok/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ok"
          >
            catálogo: {equipo.nombre} · {equipo.rol}
          </span>
        ) : activo ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-dim">no está en el catálogo</span>
        ) : null}
        {activo && (
          <span className="ml-auto font-mono text-[10px] text-mut">
            sondeando <span className="text-fg">{activo}</span> · 1 s
          </span>
        )}
      </div>
      {error && <p className="mb-2 font-mono text-xs text-crit">{error}</p>}
      <div
        className={
          amplicado
            ? "grid min-h-0 flex-1 grid-rows-2 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-1"
            : "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        }
      >
        <div className={amplicado ? "flex min-h-0 flex-col" : ""}>
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">consola · ping en vivo</div>
          <div
            ref={box}
            className={`term overflow-y-auto border border-edge bg-void p-3 text-acc ${amplicado ? "min-h-0 flex-1" : "h-44"}`}
          >
            {lineas.length === 0 &&
              (banner ? (
                <LogoTerm arte={BANNER} tamano={10} mapa={MAPAS.banner}>
                  <span className="font-mono text-[10px] text-dim">ingresa una IP y pulsa iniciar…</span>
                </LogoTerm>
              ) : (
                <LogoTerm tamano={7}>
                  <span className="font-mono text-[10px] text-dim">ingresa una IP y pulsa iniciar…</span>
                </LogoTerm>
              ))}
            {lineas.map((l) => (
              <p key={l.t} className={l.ok ? "" : "text-crit"}>
                <span className="text-dim">{new Date(l.t).toLocaleTimeString()}</span> {l.texto}
              </p>
            ))}
          </div>
        </div>
        <div className={amplicado ? "flex min-h-0 flex-col" : ""}>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-dim">ruta · salto a salto</span>
            {rutaEstado && <span className="font-mono text-[10px] text-mut">{rutaEstado}</span>}
          </div>
          <div
            className={`overflow-y-auto border border-edge bg-panel2/30 p-2 ${amplicado ? "min-h-0 flex-1" : "max-h-44"}`}
          >
            {hops.length ? (
              <ListadoHops hops={hops} equipos={catalogo.current} />
            ) : (
              <p className="p-2 font-mono text-xs text-dim">{rutaEstado || "sin ruta trazada aún"}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
