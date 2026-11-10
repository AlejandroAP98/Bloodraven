import { Fragment, useEffect, useState } from "react";

import { api, fmtDur, fmtHora } from "./api";
import type { CambioRutaEvt, DispOut, Estado, Hop, Outage } from "./api";
import { ListadoHops } from "./ListadoHops";
import { BotonCopiar } from "./BotonCopiar";
import { ConsolaPing } from "./ConsolaPing";
import GraficaLatencia from "./GraficaLatencia";
import { Diagnostico } from "./Diagnostico";
import { PanelHistorial } from "./PanelHistorial";
import { Informe } from "./Informe";
import PanelVigilancia from "./PanelVigilancia";
import TarjetaStats from "./TarjetaStats";
import { PanelEquipos } from "./PanelEquipos";

const RANGOS = [
  { label: "10m", h: 1 / 6, res: "raw" },
  { label: "30m", h: 0.5, res: "raw" },
  { label: "1h", h: 1, res: "raw" },
  { label: "3h", h: 3, res: "1m" },
  { label: "6h", h: 6, res: "1m" },
  { label: "12h", h: 12, res: "1m" },
];

// refresco adaptativo: ventanas cortas casi en vivo, rangos largos sin churn inútil
const refrescoMs = (h: number) => (h <= 6 ? 5000 : 60000);

const LED: Record<string, string> = {
  ok: "bg-ok shadow-[0_0_6px] shadow-ok/70",
  degradado: "bg-warn shadow-[0_0_6px] shadow-warn/70",
  down: "bg-crit animate-pulse shadow-[0_0_6px] shadow-crit/80",
};

function Panel({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="border border-edge bg-panel p-4">
      <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">{titulo}</h3>
      {children}
    </section>
  );
}

// agrupa paneles bajo una banda numerada (01 vigilancia, 02 diagnóstico…)
function Seccion({ num, titulo, children }: { num: string; titulo: string; children: React.ReactNode }) {
  return (
    <section aria-label={`sección ${num} · ${titulo}`}>
      <div className="mb-3 flex items-baseline gap-3 border-b border-edge pb-2">
        <span aria-hidden className="font-mono text-base font-bold leading-none text-blood">
          {num}
        </span>
        <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.3em] text-fg">{titulo}</h2>
        <span aria-hidden className="mb-1 grow border-b border-dashed border-edge/60" />
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function Detalle({
  dispositivo,
  estados,
  onVolver,
  onEditar,
  onEliminar,
}: {
  dispositivo: DispOut | null;
  estados: Estado[];
  onVolver: () => void;
  onEditar: () => void;
  onEliminar: () => void;
}) {
  const [horas, setHoras] = useState(3);
  const [outages, setOutages] = useState<Outage[]>([]);
  const [cambios, setCambios] = useState<CambioRutaEvt[]>([]);
  const [rutaRef, setRutaRef] = useState<{ ts: string | null; hops: Hop[] } | null>(null);
  // modal único "ver ruta": cambio de ruta, ruta de caída o primer escaneo
  const [rutaSel, setRutaSel] = useState<{ titulo: string; hops: Hop[] } | null>(null);
  const [informeAbierto, setInformeAbierto] = useState(false);
  const [reiniciando, setReiniciando] = useState(false);
  // inclusión del dispositivo en la topología general (sincronizado con el servidor)
  const [enTopo, setEnTopo] = useState(dispositivo?.en_topologia ?? false);
  const [tick, setTick] = useState(0);
  // panel de acceso a equipos (solo si el host es una ip: el panel va por ip)
  const [panelMk, setPanelMk] = useState(false);
  const hostEsIp = !!dispositivo && /^(\d{1,3}\.){3}\d{1,3}$/.test(dispositivo.host);
  // silencio de alertas del dispositivo (las curvas siguen registrando)
  const [silencioHasta, setSilencioHasta] = useState(dispositivo?.silencio_hasta ?? null);
  const [silencioActivo, setSilencioActivo] = useState(false);
  const [menuSilencio, setMenuSilencio] = useState(false);

  const aplicarSilencio = async (horas: number) => {
    setMenuSilencio(false);
    try {
      const d = await api.silenciar(id, horas);
      setSilencioHasta(d.silencio_hasta);
      setSilencioActivo(!!d.silencio_hasta && new Date(d.silencio_hasta).getTime() > Date.now());
    } catch {
      /* el chip conserva el estado anterior */
    }
  };

  const estado = estados.find((e) => e.device_id === dispositivo?.id);
  const id = dispositivo?.id ?? "";
  const est = estado?.estado ?? "ok";

  useEffect(() => {
    setEnTopo(dispositivo?.en_topologia ?? false);
    setSilencioHasta(dispositivo?.silencio_hasta ?? null);
    setMenuSilencio(false);
    setSilencioActivo(
      !!dispositivo?.silencio_hasta && new Date(dispositivo.silencio_hasta).getTime() > Date.now(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispositivo?.id, dispositivo?.en_topologia, dispositivo?.silencio_hasta]);

  const alternarTopologia = async () => {
    const nuevo = !enTopo;
    setEnTopo(nuevo); // actualización optimista
    try {
      const d = await api.incluirTopologia(id, nuevo);
      setEnTopo(d.en_topologia);
    } catch {
      setEnTopo(!nuevo);
    }
  };

  const reiniciarHistorial = async () => {
    if (
      !confirm(
        "¿Reiniciar el historial de este dispositivo?\n\nSe borrarán muestras, hops, caídas y cambios de ruta, y la supervisión volverá a empezar de cero."
      )
    )
      return;
    setReiniciando(true);
    try {
      const ok = await api.reiniciarHistorial(id);
      if (ok) {
        setOutages([]);
        setCambios([]);
        setRutaRef(null);
        setTick((t) => t + 1);
      }
    } catch {
      /* el intervalo de refresco seguirá intentando */
    } finally {
      setReiniciando(false);
    }
  };

  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      if (!id) return;
      const [o, cr, rf] = await Promise.all([
        api.outages(id, 24),
        api.cambiosRuta(id).catch(() => [] as CambioRutaEvt[]),
        api.rutaReferencia(id).catch(() => null),
      ]);
      if (!vivo) return;
      setOutages(o);
      setCambios(cr);
      setRutaRef(rf);
      setTick((t) => t + 1);
    };
    cargar();
    const t = setInterval(cargar, refrescoMs(horas));
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [id, horas]);

  if (!dispositivo) return <p className="font-mono text-sm text-mut">Selecciona un dispositivo del listado.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge pb-4">
        <button
          onClick={onVolver}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
        >
                    <span className="ico">◂</span> Volver
        </button>
        <span className={`h-2.5 w-2.5 ${LED[est]}`} />
        <h2 className="text-xl font-semibold tracking-[0.06em] text-fg">{dispositivo.nombre}</h2>
        <span className="flex items-center gap-2 font-mono text-sm text-mut">
          {dispositivo.host}
          <BotonCopiar texto={dispositivo.host} />
          {dispositivo.tipo && dispositivo.tipo !== "icmp" && (
            <span className="border border-edge px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-mut">
              {dispositivo.tipo}
              {dispositivo.tipo === "tcp" && dispositivo.puerto ? `:${dispositivo.puerto}` : ""}
            </span>
          )}
        </span>
        <span className={`font-mono text-sm text-fg`}>{estado?.ultimo_rtt_ms != null ? `${estado.ultimo_rtt_ms.toFixed(0)} ms` : estado?.estado}</span>
        <div className="ml-auto flex gap-2">
          {hostEsIp && (
            <button
              onClick={() => setPanelMk(true)}
              title="Panel de acceso: ficha del equipo (mikrotik o ubiquiti), lecturas RouterOS y acciones (PoE, reinicio)"
              className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/60 hover:text-acc"
            >
              <span className="ico">◆</span> acceso
            </button>
          )}
          <button
            onClick={() => setInformeAbierto(true)}
            title="Informe de comportamiento del dispositivo, con opción de exportar a .md o .txt"
            className="border border-acc/40 bg-acc/10 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-acc transition-colors hover:border-acc/70 hover:bg-acc/20"
          >
            Informe
          </button>
          <button
            onClick={alternarTopologia}
            title="Incluir o quitar este dispositivo de la topología general (el grafo sale de sus traceroutes)"
            className={`border px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
              enTopo
                ? "border-acc/60 bg-acc/10 text-acc hover:bg-acc/20"
                : "border-edge bg-panel text-mut hover:border-edgehi hover:text-fg"
            }`}
          >
            {enTopo ? "En topología" : "Añadir a topología"}
          </button>
          <button
            onClick={onEditar}
            className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
          >
            Editar
          </button>
          <button
            onClick={onEliminar}
            className="border border-crit/40 bg-crit/5 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-crit transition-colors hover:border-crit/70 hover:bg-crit/15"
          >
            Eliminar
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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

        {/* acciones secundarias: reinicio de historial + silencio de alertas,
            sin apretar la cabecera */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            onClick={reiniciarHistorial}
            disabled={reiniciando}
            title="Borrar historial (muestras, hops, caídas) y reiniciar la supervisión de este dispositivo"
            className="flex items-center gap-2 border border-warn/40 bg-warn/5 px-3 py-1 font-mono text-xs text-warn transition-colors hover:border-warn/70 hover:bg-warn/15 disabled:opacity-50"
          >
            {reiniciando ? "Reiniciando…" : "Reiniciar historial"}
          </button>

          {/* silencio de alertas: chip con duraciones, sin apretar la cabecera */}
          <div className="relative" onMouseLeave={() => setMenuSilencio(false)}>
          <button
            onClick={() => setMenuSilencio((m) => !m)}
            title={
              silencioActivo
                ? "Supervisión en PAUSA hasta la fecha indicada: sin pings ni medición (habrá huecos en las curvas) y avisos callados"
                : "Silencio con pausa real de supervisión: durante las horas elegidas el dispositivo deja de medirse (habrá huecos en las curvas) y no recibe avisos"
            }
            className={`flex items-center gap-2 border px-3 py-1 font-mono text-xs transition-colors ${
              silencioActivo
                ? "border-warn/50 bg-warn/10 text-warn"
                : "border-edge text-mut hover:border-edgehi hover:text-fg"
            }`}
          >
            <span
              aria-hidden
              className={`h-2 w-2 rounded-full ${silencioActivo ? "bg-warn shadow-[0_0_6px] shadow-warn/70" : "bg-edge"}`}
            />
            {silencioActivo ? `silenciado · hasta ${silencioHasta ? fmtHora(silencioHasta) : ""}` : "silenciar alertas"}
          </button>
          {menuSilencio && (
            <div className="absolute right-0 top-full z-30 mt-1 w-52 border border-edgehi bg-panel p-1 shadow-lg">
              {[1, 4, 8, 24].map((h) => (
                <button
                  key={h}
                  onClick={() => void aplicarSilencio(h)}
                  className="block w-full px-3 py-1.5 text-left font-mono text-xs text-mut transition-colors hover:bg-acc/10 hover:text-acc"
                >
                  silenciar {h} h {h === 8 && <span className="text-dim">· mantenimiento</span>}
                </button>
              ))}
              {silencioActivo && (
                <button
                  onClick={() => void aplicarSilencio(0)}
                  className="block w-full border-t border-edge px-3 py-1.5 text-left font-mono text-xs text-crit transition-colors hover:bg-crit/10"
                >
                  ✕ cancelar silencio
                </button>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      <TarjetaStats deviceId={id} horas={horas} resolucion={RANGOS.find((r) => r.h === horas)?.res ?? "raw"} tick={tick} outages={outages} />

      <Seccion num="01" titulo="vigilancia">
      <PanelVigilancia
        deviceId={id}
        horas={horas}
        etiqueta={RANGOS.find((r) => r.h === horas)?.label ?? `${horas}h`}
        tick={tick}
      />

      <Panel titulo={`telemetría · ${RANGOS.find((r) => r.h === horas)?.label}`}>
        <GraficaLatencia
          deviceId={id}
          horas={horas}
          resolucion={RANGOS.find((r) => r.h === horas)?.res ?? "raw"}
          outages={outages}
          refresco={tick}
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ConsolaPing dispositivo={dispositivo} />

        <Panel titulo="cambios de ruta · hops">
          {!rutaRef?.ts && cambios.length === 0 ? (
            <p className="font-mono text-xs text-mut">Sin escaneos de ruta aún: el primer escaneo se hará al arrancar la vigilancia.</p>
          ) : (
            <ul className="divide-y divide-edge/40">
              {rutaRef?.ts && (
                <li className="border-l-2 border-l-acc/70 bg-acc/5 px-3 py-2.5">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-fg">{fmtHora(rutaRef.ts)}</span>
                    <span
                      title="Primer escaneo registrado: contra esta ruta se comparan las sucesivas para detectar cambios"
                      className="border border-acc/40 bg-acc/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-acc"
                    >
                      referencia
                    </span>
                    <span className="font-mono text-[10px] text-mut">{rutaRef.hops.length} saltos</span>
                    <span className="grow" />
                    {rutaRef.hops.length > 0 && (
                      <button
                        onClick={() =>
                          setRutaSel({ titulo: `primer escaneo · referencia · ${fmtHora(rutaRef!.ts!)}`, hops: rutaRef!.hops })
                        }
                        className="border border-edge px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-acc transition-colors hover:border-acc/50 hover:bg-acc/10"
                      >
                        ver
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                    {rutaRef.hops.map((h, i) => (
                      <Fragment key={h.ttl}>
                        {i > 0 && (
                          <span aria-hidden className="font-mono text-[10px] text-dim">
                            →
                          </span>
                        )}
                        <span
                          title={`hop ${h.ttl}${h.rtt_ms != null ? ` · ${h.rtt_ms.toFixed(1)} ms` : ""}`}
                          className={`border px-1.5 py-0.5 font-mono text-[11px] ${
                            h.ok ? "border-edge bg-void/60 text-fg" : "border-crit/40 bg-crit/10 text-crit"
                          }`}
                        >
                          {h.ip ?? h.hostname ?? "timeout"}
                        </span>
                      </Fragment>
                    ))}
                    {rutaRef.hops.length === 0 && (
                      <span className="font-mono text-[11px] text-dim">sin salto identificable</span>
                    )}
                  </div>
                </li>
              )}
              {cambios.length === 0 && rutaRef?.ts && (
                <li className="px-3 py-2 font-mono text-xs text-mut">Ruta estable: sin cambios desde la referencia.</li>
              )}
              {cambios.slice(0, 20).map((c, i) => (
                <li key={i} className="border-l-2 border-l-edge px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-fg">{fmtHora(c.ts)}</span>
                    <span className="border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-warn">
                      cambio
                    </span>
                    <span className="grow" />
                    {c.hops && (
                      <button
                        onClick={() => setRutaSel({ titulo: `ruta tras el cambio · ${fmtHora(c.ts)}`, hops: c.hops ?? [] })}
                        className="border border-edge px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-acc transition-colors hover:border-acc/50 hover:bg-acc/10"
                      >
                        ver
                      </button>
                    )}
                  </div>
                  <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-mut">{c.resumen}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      </Seccion>

      <Seccion num="02" titulo="diagnóstico de red">
        <Diagnostico deviceId={id} />
      </Seccion>

      <Seccion num="03" titulo="caídas">
      <Panel titulo="historial de desconexiones · 24h">
        {outages.length === 0 ? (
          <p className="font-mono text-xs text-mut">Sin desconexiones registradas en 24 horas.</p>
        ) : (
          <>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                  <th className="pb-2 pr-4 font-medium">Inicio</th>
                  <th className="pb-2 pr-4 font-medium">Duración</th>
                  <th className="pb-2 pr-4 font-medium">dónde se cortó la conexión</th>
                  <th className="pb-2 font-medium">Ruta</th>
                </tr>
              </thead>
              <tbody className="border-t border-edge/60">
                {outages.slice(0, 30).map((o) => (
                  <tr key={o.id} className={`${o.activa ? "bg-crit/10" : ""} border-b border-edge/40`}>
                    <td className="py-1.5 pr-4 font-mono text-xs text-fg">
                      {fmtHora(o.inicio)}
                      {o.activa && <span className="ml-2 border border-crit/50 bg-crit/15 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.15em] text-crit">activa</span>}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-xs text-mut">{fmtDur(o.duracion_s)}</td>
                    <td className="py-1.5 pr-4 text-xs text-fg">
                      {o.corte}
                      <span className="ml-2 border border-edge px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-dim">{o.causa}</span>
                    </td>
                    <td className="py-1.5">
                      {o.tiene_ruta ? (
                        <button
                          onClick={async () => {
                            try {
                              const det = await api.outageDetalle(o.id);
                              setRutaSel({ titulo: `ruta durante la caída · ${fmtHora(o.inicio)}`, hops: det.hops_snapshot ?? [] });
                            } catch {
                              /* el modal simplemente no abre */
                            }
                          }}
                          className="font-mono text-xs text-acc underline decoration-acc/40 underline-offset-2 hover:decoration-acc"
                        >
                          ver
                        </button>
                      ) : (
                        <span className="font-mono text-xs text-dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {outages.length > 30 && (
              <p className="mt-2 font-mono text-[10px] text-dim">… y {outages.length - 30} más (las antiguas se consultan por rango en la sección 04).</p>
            )}
          </>
        )}
      </Panel>
      </Seccion>

      <Seccion num="04" titulo="métricas por rango">
        <PanelHistorial deviceId={id} outages={outages} />
      </Seccion>

      {informeAbierto && (
        <Informe dispositivo={dispositivo} estado={estado} onCerrar={() => setInformeAbierto(false)} />
      )}

      {rutaSel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-4 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRutaSel(null);
          }}
        >
          <div className="tick tick-acc max-h-[80vh] w-[34rem] overflow-auto border border-edgehi bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 border-b border-edge pb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-mut">
              {rutaSel.titulo}
            </h3>
            <ListadoHops hops={rutaSel.hops} />
          </div>
        </div>
      )}

      {panelMk && dispositivo && (
        <PanelEquipos ip={dispositivo.host} nombre={dispositivo.nombre} onCerrar={() => setPanelMk(false)} />
      )}
    </div>
  );
}
