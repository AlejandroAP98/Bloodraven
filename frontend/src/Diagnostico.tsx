import { Fragment, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { ROLES_RED } from "./api";
import type { Diagnostico, EquipoRed, Hop, RolRed, SondeoPuerto } from "./api";
import { BotonCopiar } from "./BotonCopiar";

const REFRESCO_MS = 60_000;

// fila inline para catalogar una IP de un hop desde la propia tabla de diagnóstico
function EditFilaHop({
  ip,
  inicial,
  onGuardar,
  onCancelar,
}: {
  ip: string;
  inicial: EquipoRed | undefined;
  onGuardar: (dato: { ip: string; nombre: string; rol: RolRed; notas: string | null }) => Promise<void>;
  onCancelar: () => void;
}) {
  const [nombre, setNombre] = useState(inicial?.nombre ?? "");
  const [rol, setRol] = useState<RolRed>(inicial?.rol ?? "otro");
  const [notas, setNotas] = useState(inicial?.notas ?? "");
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    if (!nombre.trim()) {
      setError("Nombre obligatorio");
      return;
    }
    setGuardando(true);
    try {
      await onGuardar({ ip, nombre: nombre.trim(), rol, notas: notas.trim() || null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGuardando(false);
    }
  };

  return (
    <tr>
      <td colSpan={8} className="border-b border-acc/30 bg-acc/5 py-2 pl-3 pr-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-dim">catalogar {ip}</span>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="nombre (ej. radio torre norte)"
            className="inp w-56"
            maxLength={100}
            autoFocus
          />
          <select value={rol} onChange={(e) => setRol(e.target.value as RolRed)} className="inp w-40">
            {ROLES_RED.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <input value={notas ?? ""} onChange={(e) => setNotas(e.target.value)} placeholder="notas (opcional)" className="inp w-52" maxLength={255} />
          <button
            onClick={guardar}
            disabled={guardando}
            className="border border-acc/50 bg-acc/10 px-3 py-1 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
          >
            {guardando ? "guardando…" : inicial ? "actualizar" : "agregar"}
          </button>
          <button
            onClick={onCancelar}
            className="border border-edge bg-panel px-3 py-1 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
          >
            cancelar
          </button>
          {error && <span className="font-mono text-xs text-crit">{error}</span>}
        </div>
      </td>
    </tr>
  );
}

// clasifica una caída a partir de su snapshot de ruta: ¿dónde murió el paquete?
// (la consume también la sección de caídas del detalle)
export function clasificarCorte(hops: Hop[] | null | undefined): string {
  if (!hops || hops.length === 0) return "sin trazado de ruta";
  const oks = hops.filter((h) => h.ok);
  if (oks.length === 0) return "sin respuesta ni del gateway: corte en la red local";
  const ultimoTtl = Math.max(...oks.map((h) => h.ttl));
  const ultimo = oks.find((h) => h.ttl === ultimoTtl);
  const maxTtl = Math.max(...hops.map((h) => h.ttl));
  const quien = ultimo ? ultimo.hostname || ultimo.ip || `hop ${ultimoTtl}` : `hop ${ultimoTtl}`;
  if (ultimoTtl === maxTtl) return `la ruta completa respondió: ${quien} (destino) no contesta al ping`;
  return `corte aguas abajo del hop ${ultimoTtl} (${quien})`;
}

export function Diagnostico({
  deviceId,
}: {
  deviceId: string;
}) {
  const [diag, setDiag] = useState<Diagnostico | null>(null);
  const [cat, setCat] = useState<Record<string, EquipoRed>>({});
  const [editando, setEditando] = useState<{ ttl: number; ip: string } | null>(null);
  // sondeo de puertos de la ruta (sugerencias de rol -> catálogo)
  const [sondeo, setSondeo] = useState<SondeoPuerto[] | null>(null);
  const [sondeando, setSondeando] = useState(false);
  const [sondeoError, setSondeoError] = useState("");

  // ventana fija: 24 h es el mínimo con suficiente muestra estadística por hop (~144 scans)
  const horas = 24;

  useEffect(() => {
    let vivo = true;
    setDiag(null);
    setEditando(null);
    const cargar = async () => {
      try {
        const d = await api.diagnostico(deviceId, horas);
        if (vivo) setDiag(d);
      } catch {
        if (vivo) setDiag(null);
      }
    };
    cargar();
    const t = setInterval(cargar, REFRESCO_MS);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [deviceId, horas]);

  // catálogo manual de equipos de red (para catalogar hops y saber qué IP ya existen)
  const recargarCat = async () => {
    try {
      const es = await api.equipos();
      setCat(Object.fromEntries(es.map((e) => [e.ip.toLowerCase(), e])));
    } catch {
      /* sin catálogo siguen funcionando las pistas inferidas */
    }
  };
  useEffect(() => {
    recargarCat();
  }, []);

  const sondearRuta = async () => {
    setSondeando(true);
    setSondeoError("");
    try {
      const r = await api.sondeoRuta(deviceId, horas);
      setSondeo(r.resultados);
    } catch (e) {
      setSondeoError(e instanceof Error ? e.message : String(e));
    } finally {
      setSondeando(false);
    }
  };

  // promueve una sugerencia del sondeo al catálogo con un clic
  const promover = async (s: SondeoPuerto) => {
    if (!s.rol_sugerido) return;
    // la firma ahora trae banners largos: el validar de notas en el backend es máx 255
    const notas = `sugerido por sondeo tcp+banners: ${s.firma ?? ""}`.slice(0, 255);
    const e = await api.crearEquipo({ ip: s.ip, nombre: s.ip, rol: s.rol_sugerido, notas });
    setCat((c) => ({ ...c, [e.ip.toLowerCase()]: e }));
    setSondeo((r) => (r ? r.filter((x) => x.ip !== s.ip) : r));
    try {
      setDiag(await api.diagnostico(deviceId, horas));
    } catch {
      /* el refresco periódico lo corrige */
    }
  };

  const catalogar = async (dato: { ip: string; nombre: string; rol: RolRed; notas: string | null }) => {
    const existente = cat[dato.ip.toLowerCase()];
    const guardado = existente ? await api.editarEquipo(existente.ip, dato) : await api.crearEquipo(dato);
    setCat((c) => ({ ...c, [guardado.ip.toLowerCase()]: guardado }));
    setEditando(null);
    try {
      setDiag(await api.diagnostico(deviceId, horas));
    } catch {
      /* el refresco periódico lo corrige */
    }
  };

  // tramo con más latencia acumulada: se marca como el sospechoso principal
  const tramoFuerte = useMemo(() => {
    if (!diag?.tramos.length) return null;
    return [...diag.tramos].sort((a, b) => (b.delta_avg_ms ?? 0) - (a.delta_avg_ms ?? 0))[0];
  }, [diag]);

  // prioriza el nombre del catálogo una IP ya está catalogada
  const dir = (ip: string | null, hostname: string | null) => {
    const e = ip ? cat[ip.toLowerCase()] : undefined;
    if (e) return e.nombre;
    return hostname || ip || "—";
  };

  if (!diag?.n_scans) {
    return (
      <section className="space-y-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          diagnóstico de red · ruta y tramos
        </h3>
        <p className="font-mono text-xs text-mut">
          Sin sondeos de ruta en las últimas {horas} h. El primer escaneo se hace al momento de arrancar la vigilancia…
        </p>
      </section>
    );
  }

  // "repite": mismo router en dos saltos consecutivos (interfaces múltiples / MPLS)
  let ant_ip: string | null = null;
  const repetidos = diag.hops.map((h) => {
    const es = h.ip != null && h.ip === ant_ip;
    ant_ip = h.ip ?? ant_ip;
    return es;
  });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          diagnóstico de red · ruta y tramos
        </h3>
        <span className="ml-auto font-mono text-[10px] text-mut">
          últimas 24 h · {diag.n_scans} sondeos
          {diag.destino_alcanzado_pct != null && ` · destino alcanzado ${diag.destino_alcanzado_pct}%`}
          {diag.ecos_destino > 0 && ` · ${diag.ecos_destino} eco${diag.ecos_destino === 1 ? "" : "s"} del destino (colapsado${diag.ecos_destino === 1 ? "" : "s"})`}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="border border-edge bg-panel p-3">
          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
            hops · latencia acumulada y respuesta
          </div>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                <th className="pb-1 pr-3 font-medium">hop</th>
                <th className="pb-1 pr-3 font-medium">dirección</th>
                <th className="pb-1 pr-3 font-medium">tipo (inferido)</th>
                <th className="pb-1 pr-3 font-medium">responde</th>
                <th className="pb-1 pr-3 font-medium">avg</th>
                <th className="pb-1 pr-3 font-medium">p95</th>
                <th className="pb-1 pr-3 font-medium">máx</th>
                <th className="pb-1 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {diag.hops.map((h, idx) => {
                const equipoCat = h.ip ? cat[h.ip.toLowerCase()] : undefined;
                const filaEditando = editando && editando.ttl === h.ttl;
                return (
                <Fragment key={h.ttl}>
                  <tr className="border-t border-edge/40">
                    <td className="py-1 pr-3 font-mono text-xs text-fg">{h.ttl}</td>
                    <td className="py-1 pr-3 font-mono text-xs text-mut">
                      {dir(h.ip, h.hostname)}
                      {h.ip && (
                        <span className="ml-1.5 inline-flex align-middle">
                          <BotonCopiar texto={h.ip} />
                        </span>
                      )}
                      {repetidos[idx] && (
                        <span
                          className="ml-1.5 border border-warn/40 bg-warn/10 px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.1em] text-warn"
                          title="El mismo router respondió el salto anterior (interfaces múltiples / MPLS)"
                        >
                          repite
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3 font-mono text-xs" title={h.pista ?? undefined}>
                      <span className={`${h.manual || h.tipo === "equipo objetivo" ? "text-acc" : h.tipo === "gateway local" ? "text-fg" : "text-mut"}`}>{h.tipo}</span>
                      {h.manual && <span title={h.pista ?? undefined} className="ml-1 border border-acc/40 bg-acc/10 px-1 py-px font-mono text-[8px] uppercase tracking-[0.1em] text-acc">manual</span>}
                    </td>
                    <td className={`py-1 pr-3 font-mono text-xs ${h.ok_pct != null && h.ok_pct < 95 ? "text-crit" : "text-ok"}`}>
                      {h.ok_pct != null ? `${h.ok_pct}%` : "—"}
                    </td>
                    <td className="py-1 pr-3 font-mono text-xs text-fg">{h.rtt_avg_ms != null ? `${h.rtt_avg_ms.toFixed(1)} ms` : "—"}</td>
                    <td className="py-1 pr-3 font-mono text-xs text-mut">{h.rtt_p95_ms != null ? `${h.rtt_p95_ms.toFixed(1)}` : "—"}</td>
                    <td className="py-1 pr-3 font-mono text-xs text-mut">{h.rtt_max_ms != null ? `${h.rtt_max_ms.toFixed(1)}` : "—"}</td>
                    <td className="py-1 text-right">
                      {h.ip || editando?.ttl === h.ttl ? (
                        <button
                          onClick={() => {
                            if (filaEditando) {
                              setEditando(null);
                            } else {
                              const previo = h.ip ? cat[h.ip.toLowerCase()] : undefined;
                              setEditando({ ttl: h.ttl, ip: previo?.ip ?? h.ip ?? "" });
                            }
                          }}
                          title={equipoCat ? "editar entrada del catálogo" : "catalogar esta IP"}
                          className={`font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${equipoCat ? "text-acc" : "text-mut hover:text-acc"}`}
                        >
                          {equipoCat ? (<><span className="ico">✎</span> edit</>) : (<><span className="ico">＋</span> cat</>)}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                    {filaEditando && (
                      <EditFilaHop
                        ip={editando.ip}
                        inicial={equipoCat}
                        onGuardar={catalogar}
                        onCancelar={() => setEditando(null)}
                      />
                    )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border border-edge bg-panel p-3">
          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
            tramos · latencia que añade cada tramo
          </div>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                <th className="pb-1 pr-3 font-medium">tramo</th>
                <th className="pb-1 pr-3 font-medium">hacia</th>
                <th className="pb-1 pr-3 font-medium">suma</th>
                <th className="pb-1 pr-3 font-medium">p95</th>
                <th className="pb-1 font-medium">n</th>
              </tr>
            </thead>
            <tbody>
              {diag.tramos.map((t) => {
                const esFuerte = tramoFuerte && t.de_ttl === tramoFuerte.de_ttl;
                return (
                  <tr key={t.de_ttl} className={esFuerte ? "border-t border-crit/40 bg-crit/5" : "border-t border-edge/40"}>
                    <td className="py-1 pr-3 font-mono text-xs text-fg">
                      {t.de_ttl} → {t.a_ttl}
                    </td>
                    <td className="py-1 pr-3 font-mono text-xs text-mut">{dir(t.a_ip, t.a_hostname)}</td>
                    <td className={`py-1 pr-3 font-mono text-xs ${esFuerte ? "text-crit" : "text-fg"}`}>
                      {t.delta_avg_ms != null ? `+${t.delta_avg_ms.toFixed(1)} ms` : "—"}
                    </td>
                    <td className="py-1 pr-3 font-mono text-xs text-mut">{t.delta_p95_ms != null ? `${t.delta_p95_ms.toFixed(1)}` : "—"}</td>
                    <td className="py-1 font-mono text-xs text-mut">{t.n}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {tramoFuerte && (
            <p className="mt-2 font-mono text-[10px] text-mut">
              mayor contribución: hop {tramoFuerte.de_ttl} → {tramoFuerte.a_ttl} hacia{" "}
              {dir(tramoFuerte.a_ip, tramoFuerte.a_hostname)} (+{(tramoFuerte.delta_avg_ms ?? 0).toFixed(1)} ms promedio)
            </p>
          )}
        </div>
      </div>

      <div className="border border-edge bg-panel p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mb-0 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
            borde · sondeo de puertos de la ruta
          </div>
          <span className="font-mono text-[10px] text-mut">firma TCP + banners: PC (RDP/VNC/Samba·OpenSSH), cámara y DVR (RTSP, Hikvision/Dahua, Boa/GoAhead), RouterOS (winbox 8291, ROSSSH), gestión web/ssh…</span>
          <button
            onClick={sondearRuta}
            disabled={sondeando}
            className="ml-auto border border-acc/50 bg-acc/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
          >
            {sondeando ? "sondeando…" : sondeo ? "repetir sondeo" : "sondear ruta"}
          </button>
        </div>
        {sondeoError && <p className="mt-2 font-mono text-xs text-crit">error: {sondeoError}</p>}
        {sondeando && <p className="mt-2 font-mono text-xs text-mut">abriendo TCP a los pulsos característicos de cada hop… (hasta ~15 s)</p>}
        {sondeo != null && (
          sondeo.length === 0 ? (
            <p className="mt-2 font-mono text-xs text-mut">Sin IPs que sondear en la ventana de 24 h.</p>
          ) : (
            <table className="mt-2 min-w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                  <th className="pb-1 pr-3 font-medium">dirección</th>
                  <th className="pb-1 pr-3 font-medium">abiertos</th>
                  <th className="pb-1 pr-3 font-medium">sugerencia</th>
                  <th className="pb-1 pr-3 font-medium">confianza</th>
                  <th className="pb-1 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {sondeo.map((s) => {
                  const enCat = s.ip ? cat[s.ip.toLowerCase()] : undefined;
                  const conf = s.confianza;
                  return (
                    <tr key={s.ip} className="border-t border-edge/40">
                      <td className="py-1 pr-3 font-mono text-xs text-fg">{s.ip}</td>
                      <td className="py-1 pr-3">
                        {s.abiertos.length ? (
                          <span className="flex flex-wrap gap-1">
                            {s.abiertos.map((p) => (
                              <span key={p} className="border border-edge px-1 py-px font-mono text-[10px] text-fg">{p}</span>
                            ))}
                          </span>
                        ) : (
                          <span className="font-mono text-xs text-dim">ninguno</span>
                        )}
                      </td>
                      <td className="py-1 pr-3 font-mono text-xs" title={s.firma ?? undefined}>
                        {s.rol_sugerido ? <span className={conf != null && conf >= 0.7 ? "text-acc" : conf != null && conf >= 0.4 ? "text-warn" : "text-mut"}>{s.rol_sugerido}</span> : "—"}
                        {s.firma && <span className="ml-1 text-[10px] text-dim">{s.firma.split(":")[0]}</span>}
                      </td>
                      <td className="py-1 pr-3 font-mono text-xs text-mut">{conf != null ? `${Math.round(conf * 100)}%` : "—"}</td>
                      <td className="py-1 text-right">
                        {enCat ? (
                          <span className="border border-ok/40 bg-ok/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ok">en catálogo</span>
                        ) : s.rol_sugerido ? (
                          <button
                            onClick={() => promover(s)}
                            title={`agregar al catálogo como ${s.rol_sugerido}`}
                            className="font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-acc"
                          >
                            <span className="ico">＋</span> cat
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
        {sondeo != null && (
          <p className="mt-2 font-mono text-[10px] text-dim">
            la sugerencia no es definitiva: corrige el rol desde el catálogo o con «＋ cat» del hop; el propio dispositivo vigilado queda identificado como «equipo objetivo»
          </p>
        )}
      </div>
    </section>
  );
}
