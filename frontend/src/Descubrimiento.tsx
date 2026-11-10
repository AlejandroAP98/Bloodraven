import { useMemo, useState } from "react";

import { api, ROLES_RED } from "./api";
import type { DispOut, HostIdent, HostLibre, HostSilencioso, HostVivo, RolRed } from "./api";
import { BotonCopiar } from "./BotonCopiar";

// mini-form de alta en el catálogo: autónomo (estado propio), se desmonta solo
// al guardar bien porque onGuardado cierra el form
function FormaCatalogo({
  ip,
  sugerido,
  onGuardado,
  onCerrar,
}: {
  ip: string;
  sugerido: string | null;
  onGuardado: (ip: string, datos: { nombre: string; rol: string }) => void;
  onCerrar: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [rol, setRol] = useState<RolRed>(ROLES_RED.find((r) => r === sugerido) ?? "otro");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const guardar = async () => {
    if (!nombre.trim()) return;
    setGuardando(true);
    try {
      await api.crearEquipo({ ip, nombre: nombre.trim(), rol, notas: null });
      onGuardado(ip, { nombre: nombre.trim(), rol });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGuardando(false);
    }
  };

  return (
    <div className="ml-2 mt-2 flex flex-wrap items-center gap-2 border-l-2 border-edgehi pl-3">
      <input
        value={nombre}
        onChange={(e) => setNombre(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !guardando && guardar()}
        placeholder={`nombre (ej. ${sugerido ?? "equipo"} ${ip.split(".").pop()})`}
        maxLength={100}
        className="w-52 bg-void px-2 py-1 font-mono text-xs text-fg ring-1 ring-edge transition-shadow outline-none placeholder:text-dim focus:ring-acc/60"
      />
      <select
        value={rol}
        onChange={(e) => setRol(e.target.value as RolRed)}
        className="bg-void px-2 py-1 font-mono text-xs text-fg ring-1 ring-edge transition-shadow outline-none focus:ring-acc/60"
      >
        {ROLES_RED.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        onClick={guardar}
        disabled={guardando || !nombre.trim()}
        className="border border-acc/50 bg-acc/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
      >
        {guardando ? "guardando…" : (<><span className="ico">✓</span> guardar</>)}
      </button>
      <button
        onClick={onCerrar}
        className="border border-edge px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
      >
        <span className="ico">×</span> cancelar
      </button>
      {error && <span className="font-mono text-[10px] text-crit">{error}</span>}
    </div>
  );
}

// conmutador entre las dos listas del descubrimiento: hosts respondiendo y ips disponibles
function ConmutadorVista({
  vista,
  setVista,
  nVivos,
  nLibres,
}: {
  vista: "vivos" | "libres";
  setVista: (v: "vivos" | "libres") => void;
  nVivos: number;
  nLibres: number;
}) {
  const clase = (activa: boolean) =>
    `px-3 py-1 font-mono text-xs transition-colors ${activa ? "bg-acc/15 text-acc" : "text-mut hover:bg-panel2 hover:text-fg"}`;
  return (
    <div className="flex border border-edge">
      <button onClick={() => setVista("vivos")} disabled={vista === "vivos"} className={clase(vista === "vivos")}>
        respondiendo <span>{nVivos}</span>
      </button>
      <button
        onClick={() => setVista("libres")}
        disabled={vista === "libres"}
        className={`border-l border-edge ${clase(vista === "libres")}`}
      >
        disponibles <span>{nLibres}</span>
      </button>
    </div>
  );
}

export function Descubrimiento({
  dispositivos,
  onAgregar,
  onVolver,
}: {
  dispositivos: DispOut[];
  onAgregar: (host: string) => void;
  onVolver: () => void;
}) {
  const [cidr, setCidr] = useState("");
  const [vivos, setVivos] = useState<HostVivo[] | null>(null);
  const [libres, setLibres] = useState<HostLibre[] | null>(null);
  const [ocupadas, setOcupadas] = useState<HostSilencioso[]>([]);
  const [vista, setVista] = useState<"vivos" | "libres">("vivos");
  const [escaneando, setEscaneando] = useState(false);
  const [ident, setIdent] = useState<Record<string, HostIdent> | null>(null);
  const [identificando, setIdentificando] = useState(false);
  const [errorIdent, setErrorIdent] = useState("");
  const [filtro, setFiltro] = useState("");
  const [catalogados, setCatalogados] = useState<Record<string, { nombre: string; rol: string }>>({});
  const [alta, setAlta] = useState<string | null>(null); // ip con mini-form de catálogo abierto
  const [error, setError] = useState("");

  const yaRegistrado = (ip: string) =>
    dispositivos.some((d) => {
      const h = d.host.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
      return h === ip;
    });

  // etapa 1: barrido ICMP (rápido, con rtt); trae vivos y libres a la vez
  const escanear = async () => {
    setEscaneando(true);
    setError("");
    setIdent(null);
    setErrorIdent("");
    try {
      const r = await api.descubrir(cidr);
      setVivos(r.vivos);
      setLibres(r.libres);
      setOcupadas(r.ocupadas_silenciosas);
      setVista("vivos");
      setFiltro("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVivos(null);
      setLibres(null);
      setOcupadas([]);
    } finally {
      setEscaneando(false);
    }
  };

  // etapa 2: sondeo de puertos + banners (opcional, identifica cada host)
  const identificar = async () => {
    if (!vivos?.length) return;
    setIdentificando(true);
    setErrorIdent("");
    try {
      const r = await api.identificar(vivos.map((v) => v.ip));
      setIdent(Object.fromEntries(r.resultados.map((x) => [x.ip, x])));
    } catch (e) {
      setErrorIdent(e instanceof Error ? e.message : String(e));
    } finally {
      setIdentificando(false);
    }
  };

  // alta rápida al catálogo (el mini-form vive en <FormaCatalogo />)
  const abrirAlta = (ip: string) => setAlta(ip);

  const guardadoEnCatalogo = (ip: string, datos: { nombre: string; rol: string }) => {
    setCatalogados((c) => ({ ...c, [ip]: datos }));
    setAlta(null);
  };

  const visibles = useMemo(() => {
    if (!vivos) return [];
    const t = filtro.trim().toLowerCase();
    return t ? vivos.filter((v) => v.ip.includes(t)) : vivos;
  }, [vivos, filtro]);

  // libres del escaneo, sin las que ya se reservaron en esta sesión, con filtro
  const libresVisibles = useMemo(() => {
    if (!libres) return [];
    const t = filtro.trim().toLowerCase();
    const base = libres.filter((l) => !catalogados[l.ip]);
    return t ? base.filter((l) => l.ip.includes(t)) : base;
  }, [libres, filtro, catalogados]);

  // resumen por rol sugerido (solo cuando hay identificación)
  const resumen = useMemo(() => {
    if (!ident) return null;
    const c: Record<string, number> = {};
    for (const v of vivos ?? []) {
      const x = ident[v.ip];
      const k = x?.rol_sugerido ?? (x?.abiertos.length ? "otro" : "silencioso");
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [ident, vivos]);

  const colorConf = (conf: number | null) => (conf == null ? "text-dim" : conf >= 0.75 ? "text-ok" : conf >= 0.5 ? "text-warn" : "text-dim");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge pb-4">
        <button
          onClick={onVolver}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
        >
                    <span className="ico">◂</span> Volver
        </button>
        <h2 className="text-xl font-semibold tracking-[0.06em] text-fg">Descubrimiento de red</h2>
        <span className="font-mono text-xs text-mut">
          barrido icmp (máx /22) · ips disponibles · sondeo de puertos opcional para identificar
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !escaneando && escanear()}
          placeholder="192.168.1.0/24"
          spellCheck={false}
          className="inp w-56"
        />
        <button
          onClick={escanear}
          disabled={escaneando || !cidr}
          className="border border-acc/50 bg-acc/10 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
        >
          {escaneando ? "escaneando…" : (<><span className="ico">◎</span> Escanear</>)}
        </button>
        {vivos != null && vivos.length > 0 && ident == null && (
          <button
            onClick={identificar}
            disabled={identificando}
            title="Sondea 21 puertos TCP por host y clasifica por firma (activos más 1.5 s por puerto)"
            className="border border-edge px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/50 hover:bg-acc/10 hover:text-acc disabled:opacity-50"
          >
            {identificando ? "identificando…" : (<><span className="ico">☰</span> identificar (puertos)</>)}
          </button>
        )}
      </div>

      {error && <p className="font-mono text-xs text-crit">error: {error}</p>}

      {vivos != null && vista === "vivos" && (
        <section className="border border-edge bg-panel p-4">
          <div className="mb-3 flex flex-wrap items-center gap-4">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
              <span className="text-fg">{vivos.length}</span> hosts respondiendo en {cidr}
            </h3>
            <ConmutadorVista
              vista={vista}
              setVista={setVista}
              nVivos={vivos.length}
              nLibres={libres?.length ?? 0}
            />
            {resumen && Object.keys(resumen).length > 0 && (
              <span className="flex flex-wrap gap-x-3 font-mono text-[10px] text-mut">
                {Object.entries(resumen)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => (
                    <span key={k}>
                      {k} <span className="text-fg">{n}</span>
                    </span>
                  ))}
              </span>
            )}
            {vivos.length > 6 && (
              <input
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="filtrar ip…"
                spellCheck={false}
                className="ml-auto w-36 bg-void px-2 py-1 font-mono text-xs text-fg placeholder:text-dim ring-1 ring-edge transition-shadow outline-none focus:ring-acc/60"
              />
            )}
          </div>

          {vivos.length === 0 ? (
            <p className="font-mono text-xs text-mut">Ningún host respondió al ICMP (pueden tenerlo bloqueado).</p>
          ) : (
            <ul className="divide-y divide-edge/40">
              {visibles.map((v) => {
                const ya = yaRegistrado(v.ip);
                const cat = ident?.[v.ip]?.catalogo_nombre ?? catalogados[v.ip]?.nombre ?? null;
                const catRol = ident?.[v.ip]?.catalogo_rol ?? catalogados[v.ip]?.rol ?? null;
                const sugerido = ident?.[v.ip]?.rol_sugerido ?? null;
                const conf = ident?.[v.ip]?.confianza ?? null;
                const firma = ident?.[v.ip]?.firma ?? null;
                return (
                  <li key={v.ip} className="py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-sm text-fg">{v.ip}</span>
                      <BotonCopiar texto={v.ip} />
                      {v.rtt_ms != null && (
                        <span className="font-mono text-xs text-mut" title="rtt del ping del barrido">
                          {v.rtt_ms.toFixed(1)} ms
                        </span>
                      )}
                      {sugerido && (
                        <span
                          className={`border border-edge px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] ${colorConf(conf)}`}
                          title={firma ?? undefined}
                        >
                          {sugerido}
                          {conf != null ? ` · ${Math.round(conf * 100)}%` : ""}
                        </span>
                      )}
                      {!sugerido && ident?.[v.ip] && ident[v.ip].abiertos.length > 0 && (
                        <span
                          className="border border-edge px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-dim"
                          title={`puertos abiertos: ${ident[v.ip].abiertos.join(", ")}`}
                        >
                          puertos {ident[v.ip].abiertos.length}
                        </span>
                      )}
                      {cat && (
                        <span
                          className="border border-ok/40 bg-ok/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ok"
                          title={`ya está en el catálogo: ${cat}${catRol ? ` · rol ${catRol}` : ""}`}
                        >
                          {cat.length > 28 ? `${cat.slice(0, 27)}…` : cat}
                          {catRol ? ` · ${catRol}` : ""}
                        </span>
                      )}
                      {ya ? (
                        <span className="border border-ok/40 bg-ok/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ok">
                          ya registrado
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => onAgregar(v.ip)}
                            title="Crear dispositivo monitoreado con ping y ruta cada 5 s"
                            className="border border-edge px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/50 hover:bg-acc/10 hover:text-acc"
                          >
                            <span className="ico">＋</span> agregar
                          </button>
                          {!cat && (
                            <button
                              onClick={() => abrirAlta(v.ip)}
                              title="Darlo de alta en el catálogo de equipos de red"
                              className="border border-edge px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/50 hover:bg-acc/10 hover:text-acc"
                            >
                              <span className="ico">＋</span> catálogo
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {alta === v.ip && (
                      <FormaCatalogo
                        ip={v.ip}
                        sugerido={sugerido}
                        onGuardado={guardadoEnCatalogo}
                        onCerrar={() => setAlta(null)}
                      />
                    )}
                  </li>
                );
              })}
              {visibles.length === 0 && vivos.length > 0 && (
                <li className="py-2 font-mono text-xs text-mut">ninguna ip coincide con el filtro</li>
              )}
            </ul>
          )}

          {ident && vivos.length > 24 && (
            <p className="mt-2 font-mono text-[10px] text-dim">
              identificación limitada a los primeros 24 hosts (el resto solo tiene icmp/rtt)
            </p>
          )}
          {errorIdent && <p className="mt-2 font-mono text-xs text-crit">identificación: {errorIdent}</p>}
        </section>
      )}

      {libres != null && vista === "libres" && (
        <section className="border border-edge bg-panel p-4">
          <div className="mb-3 flex flex-wrap items-center gap-4">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
              <span className="text-fg">{libres.length}</span> ips disponibles (sin uso) en {cidr}
            </h3>
            <ConmutadorVista
              vista={vista}
              setVista={setVista}
              nVivos={vivos?.length ?? 0}
              nLibres={libres.length}
            />
            {ocupadas.length > 0 && (
              <span className="font-mono text-[10px] text-mut" title="ip con evidencia de estar en uso aunque no respondan al icmp; no cuentan como libres">
                {ocupadas.length} ip en uso sin respuesta icmp
              </span>
            )}
            {libres.length > 6 && (
              <input
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="filtrar ip…"
                spellCheck={false}
                className="ml-auto w-36 bg-void px-2 py-1 font-mono text-xs text-fg ring-1 ring-edge transition-shadow outline-none placeholder:text-dim focus:ring-acc/60"
              />
            )}
          </div>

          {libres.length === 0 ? (
            <p className="font-mono text-xs text-mut">
              Ninguna ip libre en el rango escaneado (todo respondió o tiene registro conocido).
            </p>
          ) : libresVisibles.length === 0 ? (
            <p className="font-mono text-xs text-mut">
              {filtro.trim() ? "ninguna ip coincide con el filtro" : "todas las libres ya están reservadas en esta sesión"}
            </p>
          ) : (
            <ul className="divide-y divide-edge/40">
              {libresVisibles.map((l) => (
                <li key={l.ip} className="py-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm text-fg">{l.ip}</span>
                    <BotonCopiar texto={l.ip} />
                    <button
                      onClick={() => abrirAlta(l.ip)}
                      title="Reservar la ip dándola de alta en el catálogo (nombre + rol)"
                      className="border border-edge px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/50 hover:bg-acc/10 hover:text-acc"
                    >
                      <span className="ico">＋</span> reservar
                    </button>
                  </div>
                  {alta === l.ip && (
                    <FormaCatalogo
                      ip={l.ip}
                      sugerido={null}
                      onGuardado={guardadoEnCatalogo}
                      onCerrar={() => setAlta(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          {ocupadas.length > 0 && (
            <div className="mt-3 border-t border-edge/40 pt-3">
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
                en uso sin respuesta icmp ({ocupadas.length})
              </p>
              <ul className="divide-y divide-edge/40">
                {ocupadas.map((o) => (
                  <li key={o.ip} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="font-mono text-sm text-mut">{o.ip}</span>
                    <BotonCopiar texto={o.ip} />
                    {o.evidencia.map((e) => (
                      <span
                        key={e}
                        className="border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-warn"
                        title="no se lista como disponible: hay evidencia de que la ip está en uso"
                      >
                        {e}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-3 font-mono text-[10px] text-dim">
            una ip "libre" puede estar ocupada por un equipo apagado o con icmp y arp bloqueados
          </p>
        </section>
      )}

      {vivos == null && !escaneando && (
        <div className="border border-dashed border-edgehi p-8 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-mut">sin escaneo</p>
          <p className="mt-2 text-sm text-dim">
            Ingresa la subred y presiona Escanear (el icmp tarda unos segundos; la identificación de
            puertos es un paso extra opcional).
          </p>
        </div>
      )}
    </div>
  );
}
