import { useEffect, useRef, useState } from "react";

import { api, esUbiquiti, esWirelessAireOs, fmtHora } from "./api";
import type {
  AccionResultado,
  DispositivoAfectado,
  EntradaAccionLog,
  FichaEquipo,
  FilaRouteros,
  MarcaEquipo,
  PoePuerto,
  RespuestaInterfaces,
  RespuestaLogRouter,
  RespuestaRed,
  RespuestaWirelessMixta,
} from "./api";
import { BotonCopiar } from "./BotonCopiar";

type Pestana = "ficha" | "wireless" | "interfaces" | "red" | "log";

// helper tolerante a la variación de claves entre wireless clásico y wifi v7.13+
function campo(f: FilaRouteros, ...claves: string[]): string | null {
  for (const k of claves) {
    const v = f[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return null;
}

// RouterOS lleva el tiempo crudo ("1w1d3h55m57s", "980ms"): lo traduce a
// "1 sem 1 d 3h 55m 57s" para no mostrar cadenas de letras
function humaniza(v: string | null): string {
  if (!v) return "—";
  if (/^\d+(\.\d+)?ms$/.test(v)) return v; // milisegundos: queda como está
  const out = v.replace(
    /(\d+)(ms|w|d|h|m|s)/g,
    (_t: string, n: string, u: string): string =>
      u === "ms" ? ` ${n}ms` : ` ${n}${u === "w" ? "sem" : u}`,
  );
  return out.trim().replace(/\s+/g, " ") || v;
}

// confirmación enriquecida: obliga a escribir el nombre del objetivo (puerto o
// "reiniciar"), muestra los dispositivos que dependen de esta ip y el toggle de
// silencio de alertas (ON: los cortes intencionales no pintan falsos outages)
function ConfirmarAccion({
  ip,
  tipo,
  puerto,
  afectados,
  onCancelar,
  onHecho,
}: {
  ip: string;
  tipo: "poe_cycle" | "reboot";
  puerto: string | null;
  afectados: DispositivoAfectado[];
  onCancelar: () => void;
  onHecho: (r: AccionResultado) => void;
}) {
  const objetivo = tipo === "poe_cycle" ? (puerto ?? "") : "reiniciar";
  const [escrito, setEscrito] = useState("");
  const [silenciar, setSilenciar] = useState(true);
  const [error, setError] = useState("");
  const [ejecutando, setEjecutando] = useState(false);
  const valido = escrito.trim() === objetivo;

  const ejecutar = async () => {
    if (!valido) return;
    setEjecutando(true);
    setError("");
    try {
      const r =
        tipo === "poe_cycle"
          ? await api.cicloPoe(ip, objetivo, silenciar)
          : await api.reinicioEquipo(ip, silenciar);
      onHecho(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEjecutando(false);
    }
  };

  return (
    <div className="mt-3 space-y-2 border-l-2 border-warn/60 bg-warn/5 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-warn">
        {tipo === "poe_cycle"
          ? `ciclo poe en ${puerto}: el dispositivo conectado se reinicia (~30–90 s sin señal)`
          : "rebooteo del equipo: fuera 1–4 min (todo el tráfico que atiende se detiene)"}
      </p>
      {afectados.length > 0 && (
        <p className="font-mono text-[10px] text-mut" title="los dispositivos con esta ip en su ruta reciente pueden quedarse sin camino">
          ⚠ en la ruta de: {afectados.map((a) => a.nombre).join(", ")}
        </p>
      )}

      {/* confirmación: escribir el objetivo y ejecutar, en su propia fila */}
      <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-2">
        <input
          value={escrito}
          onChange={(e) => setEscrito(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valido && !ejecutando && ejecutar()}
          placeholder={`escribe «${objetivo}» para confirmar`}
          spellCheck={false}
          className="w-64 bg-void px-2 py-1 font-mono text-xs text-fg ring-1 ring-edge transition-shadow outline-none placeholder:text-dim focus:ring-warn/70"
        />
        <button
          onClick={ejecutar}
          disabled={!valido || ejecutando}
          className="border border-crit/50 bg-crit/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-crit transition-colors hover:bg-crit/20 disabled:opacity-50"
        >
          {ejecutando ? "ejecutando…" : (<><span className="ico">⚡</span> ejecutar</>)}
        </button>
        <button
          onClick={onCancelar}
          className="border border-edge px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
        >
          <span className="ico">×</span> cancelar
        </button>
      </div>

      {/* silencio de alertas: fila propia y commutador visible (ON por defecto:
          los cortes intencionales no pintan falsas desconexiones) */}
      <button
        onClick={() => setSilenciar(!silenciar)}
        title="Con silencio activo, las alertas de los equipos afectados se posponen durante la ventana (10/15 min) y no se registran como caídas falsas"
        className={`flex items-center gap-2 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${
          silenciar
            ? "border-ok/50 bg-ok/10 text-ok"
            : "border-edge text-mut hover:text-fg"
        }`}
      >
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${silenciar ? "bg-ok shadow-[0_0_6px] shadow-ok/70" : "bg-edge"}`}
        />
        {silenciar
          ? `silencio activo · ${tipo === "poe_cycle" ? "10" : "15"} min para las alertas de los equipos afectados`
          : "sin silencio · las alertas verán el corte y se registra la caída falsa"}
      </button>

      {error && <p className="font-mono text-[10px] text-crit">{error}</p>}
    </div>
  );
}

// mini-form de credencial: valida contra el equipo real antes de guardar
function FormCredencial({
  ip,
  usuarioInicial,
  onGuardado,
}: {
  ip: string;
  usuarioInicial: string | null;
  onGuardado: (transporte: string, version: string) => void;
}) {
  const [usuario, setUsuario] = useState(usuarioInicial ?? "");
  const [password, setPassword] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const guardar = async () => {
    setGuardando(true);
    setError("");
    try {
      const r = await api.guardarCredencialAccion(ip, { usuario: usuario.trim(), password: password });
      onGuardado(r.transporte, r.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGuardando(false);
    }
  };

  return (
    <div className="mt-3 border border-edge bg-void p-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
        credencial de acceso · se valida contra el equipo (mikrotik o ubiquiti) antes de guardar · la contraseña puede quedar vacía si el equipo no usa password · la contraseña viaja cifrada y no se vuelve a mostrar
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={usuario}
          onChange={(e) => setUsuario(e.target.value)}
          placeholder="usuario (ej. admin)"
          spellCheck={false}
          maxLength={100}
          className="w-44 bg-void px-2 py-1 font-mono text-xs text-fg ring-1 ring-edge transition-shadow outline-none placeholder:text-dim focus:ring-acc/60"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && usuario.trim() && !guardando && guardar()}
          placeholder="contraseña (vacía = sin password)"
          maxLength={100}
          className="w-44 bg-void px-2 py-1 font-mono text-xs text-fg ring-1 ring-edge transition-shadow outline-none placeholder:text-dim focus:ring-acc/60"
        />
        <button
          onClick={guardar}
          disabled={guardando || !usuario.trim()}
          className="border border-acc/50 bg-acc/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
        >
          {guardando ? "validando…" : (<><span className="ico">✓</span> validar y guardar</>)}
        </button>
      </div>
      {error && <p className="mt-2 font-mono text-[10px] text-crit">{error}</p>}
    </div>
  );
}

const ETIQUETA_PESTANA: Record<Pestana, string> = {
  ficha: "ficha",
  wireless: "wireless",
  interfaces: "interfaces",
  red: "red",
  log: "log router",
};

const NOMBRE_MARCA: Record<MarcaEquipo, string> = {
  mikrotik: "Mikrotik",
  ubiquiti: "Ubiquiti airMAX",
};

// aireOS reporta la señal a veces con unidades ("-67 dBm") y a veces cruda
// ("-67"): completa unidades solo si el valor es un número puro
function conUnidad(v: string | null, unidad: string): string {
  if (v == null || v === "") return "—";
  return /[a-zA-Z]/.test(v) ? v : `${v} ${unidad}`;
}

// Panel de acceso a equipos (despacho por marca de la credencial): MikroTik
// RouterOS (ficha, wireless, interfaces, red, log, PoE, reinicio) o Ubiquiti
// airMAX/aireOS (ficha de radio, tabla de estaciones vía wstalist y reinicio;
// sin pestañas interfaces/red/log). Las pestañas PoE/interfaces/etc.
// solo existen en RouterOS.
export function PanelEquipos({
  ip,
  nombre,
  onCerrar,
}: {
  ip: string;
  nombre: string;
  onCerrar: () => void;
}) {
  const [cred, setCred] = useState<{ existe: boolean; usuario: string | null } | null>(null);
  const [afectados, setAfectados] = useState<DispositivoAfectado[]>([]);
  const [bitacora, setBitacora] = useState<EntradaAccionLog[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [confirmando, setConfirmando] = useState<{ tipo: "poe_cycle" | "reboot"; puerto: string | null } | null>(null);
  const [resultado, setResultado] = useState<AccionResultado | null>(null);
  // edición de credencial existente (el form también sirve para rotarla)
  const [editandoCred, setEditandoCred] = useState(false);

  // datos por pestaña: cargan en la primera visita y persisten mientras cargan
  const [pestana, setPestana] = useState<Pestana>("ficha");
  const [cargandoPestana, setCargandoPestana] = useState(false);
  const [errorPestana, setErrorPestana] = useState("");
  const [ficha, setFicha] = useState<FichaEquipo | null>(null);
  const [marca, setMarca] = useState<MarcaEquipo>("mikrotik");
  const [poe, setPoe] = useState<PoePuerto[]>([]);
  const [poeMenuExiste, setPoeMenuExiste] = useState(true);
  const [wireless, setWireless] = useState<RespuestaWirelessMixta | null>(null);
  const [interfacesD, setInterfacesD] = useState<RespuestaInterfaces | null>(null);
  const [red, setRed] = useState<RespuestaRed | null>(null);
  const [logRouter, setLogRouter] = useState<RespuestaLogRouter | null>(null);
  const visitadas = useRef<Set<Pestana>>(new Set(["ficha"]));

  const cargarFicha = async (forzar = false) => {
    const i = await api.infoEquipo(ip, forzar);
    setMarca(i.marca);
    setFicha(i.ficha);
    setPoe(i.poe_puertos);
    setPoeMenuExiste(i.poe_menu_existe);
  };

  const cargarPestana = async (p: Pestana, forzar = false) => {
    setCargandoPestana(true);
    setErrorPestana("");
    try {
      if (p === "ficha") await cargarFicha(forzar);
      else if (p === "wireless") setWireless(await api.wireless(ip, forzar));
      else if (p === "interfaces") setInterfacesD(await api.interfacesRouteros(ip));
      else if (p === "red") setRed(await api.redRouteros(ip));
      else if (p === "log") setLogRouter(await api.logRouteros(ip));
      visitadas.current.add(p);
    } catch (e) {
      setErrorPestana(e instanceof Error ? e.message : String(e));
    } finally {
      setCargandoPestana(false);
    }
  };

  const cambiarPestana = (p: Pestana) => {
    setPestana(p);
    if (!visitadas.current.has(p)) void cargarPestana(p);
  };

  const cargar = async () => {
    setCargando(true);
    setError("");
    try {
      const c = await api.credencialAccion(ip);
      setCred(c);
      if (c.existe) {
        await cargarFicha();
        visitadas.current.add("ficha");
      } else {
        setFicha(null);
        setPoe([]);
      }
      const [a, lg] = await Promise.all([api.afectadosAccion(ip), api.logAcciones(ip)]);
      setAfectados(a.afectados);
      setBitacora(lg.acciones);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ip]);

  const fichas = !ficha
    ? []
    : esUbiquiti(ficha)
      ? ([
          ["hostname", ficha.identity ?? "—"],
          ["versión aireos", ficha.version || "—"],
          ["placa", ficha.board ?? "—"],
          ["ssid", ficha.essid ?? "—"],
          ["modo radio", ficha.radio_modo ?? "—"],
          ["frecuencia", ficha.frecuencia_mhz != null ? `${ficha.frecuencia_mhz} MHz` : "—"],
          // ancho de canal: solo si el firmware lo reporta (la clave cambia
          // por familia y algunos cfg no lo incluyen)
          ...(ficha.canal_mhz != null ? ([["ancho de canal", `${ficha.canal_mhz} MHz`]] as [string, string][]) : []),
          ["txpower", ficha.txpower_dbm != null ? `${ficha.txpower_dbm} dBm` : "—"],
          ["rol de red", ficha.modo ?? "—"],
          ["señal", conUnidad(ficha.senal ?? null, "dBm")],
          ["ruido", conUnidad(ficha.ruido ?? null, "dBm")],
          // ccq: métrica de los M-series; en AC el equivalente es el link
          // potencial (ya viene como media del backend)
          ...(ficha.ccq
            ? ([["ccq", ficha.ccq]] as [string, string][])
            : ficha.potencial
              ? ([["potencial (media de estaciones)", ficha.potencial]] as [string, string][])
              : ([] as [string, string][])),
          ["estaciones", ficha.stations_n != null ? String(ficha.stations_n) : "—"],
          ["uptime", ficha.uptime || "—"],
          ["cpu", ficha.cpu_load != null ? `${ficha.cpu_load}%` : "—"],
          ["transporte", ficha.transporte || "—"],
          ["memoria libre", ficha.memoria_libre_mb != null ? `${ficha.memoria_libre_mb} MB` : "—"],
          ...(ficha.lan_ip ? ([["ip lan", ficha.lan_ip]] as [string, string][]) : []),
        ] as [string, string][])
      : ([
          ["identidad", ficha.identity ?? "—"],
          ["versión routeros", ficha.version || "—"],
          ["placa", ficha.board ?? "—"],
          ["uptime", ficha.uptime || "—"],
          ["cpu", ficha.cpu_load != null ? `${ficha.cpu_load}%` : "—"],
          ["transporte", ficha.transporte || "—"],
          ["memoria libre", ficha.memoria_libre_mb != null ? `${ficha.memoria_libre_mb} MB` : "—"],
          ["disco libre", ficha.disco_libre_mb != null ? `${ficha.disco_libre_mb} MB` : "—"],
          ["serie", ficha.serie ?? "—"],
          ["firmware actual", ficha.firmware_actual ?? "—"],
          ["firmware pendiente", ficha.firmware_pendiente ?? "—"],
          ["voltaje", ficha.voltaje ?? "—"],
          ["temperatura", ficha.temperatura ?? "—"],
        ] as [string, string][]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 sm:p-8" onClick={onCerrar}>
      <div
        className="max-h-full w-full max-w-5xl overflow-y-auto border border-edgehi bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-edge pb-3">
          <h3 className="text-lg font-semibold tracking-[0.06em] text-fg">
            {NOMBRE_MARCA[marca]} <span className="text-mut">· {nombre}</span>
          </h3>
          <span className="font-mono text-xs text-mut">{ip}</span>
          <BotonCopiar texto={ip} titulo="copiar ip" />
          {cred?.existe && !editandoCred && (
            <span className="flex items-center gap-2 border border-edge bg-void px-2 py-1 font-mono text-[10px] text-mut">
              cred: <span className="text-fg">{cred.usuario}</span>
              <button
                onClick={() => setEditandoCred(true)}
                title="Cambiar credencial del equipo (se valida contra el equipo antes de guardar)"
                className="text-mut transition-colors hover:text-acc"
              >
                <span className="ico">✎</span>
              </button>
              <button
                onClick={async () => {
                  if (!confirm(`¿Borrar la credencial guardada de ${ip}?\n\nEl panel dejará de poder entrar a este equipo hasta que registres otra.`)) return;
                  try {
                    await api.borrarCredencialAccion(ip);
                    setEditandoCred(false);
                    await cargar();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
                title="Borrar credencial guardada"
                className="text-mut transition-colors hover:text-crit"
              >
                <span className="ico">🗑</span>
              </button>
            </span>
          )}
          <button
            onClick={() => cred?.existe && void cargarPestana(pestana, true)}
            disabled={cargandoPestana}
            title="Reconsulta al equipo ahora (forzando el refresco: salta la caché de 20 s del backend)"
            className="ml-auto border border-edge bg-void px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg disabled:opacity-50"
          >
            <span className="ico">⟳</span> {cargandoPestana ? "consultando…" : "actualizar"}
          </button>
          <button
            onClick={onCerrar}
            className="border border-edge bg-void px-3 py-1 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
          >
            <span className="ico">×</span> cerrar
          </button>
        </div>

        {cargando && <p className="mt-4 font-mono text-xs text-mut">consultando…</p>}
        {error && <p className="mt-4 font-mono text-xs text-crit">error: {error}</p>}

        {cred && !cred.existe && !cargando && (
          <FormCredencial
            ip={ip}
            usuarioInicial={cred.usuario}
            onGuardado={() => {
              setResultado(null);
              setConfirmando(null);
              cargar();
            }}
          />
        )}

        {cred?.existe && editandoCred && (
          <FormCredencial
            ip={ip}
            usuarioInicial={cred.usuario}
            onGuardado={() => {
              setEditandoCred(false);
              setResultado(null);
              setConfirmando(null);
              cargar();
            }}
          />
        )}

        {cred?.existe && (
          <>
            <div className="mt-3 flex flex-wrap gap-1">
              {(Object.keys(ETIQUETA_PESTANA) as Pestana[])
                .filter((p) => marca !== "ubiquiti" || p === "ficha" || p === "wireless")
                .map((p) => (
                <button
                  key={p}
                  onClick={() => cambiarPestana(p)}
                  className={
                    "px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors " +
                    (pestana === p
                      ? "border border-acc/60 bg-acc/10 text-acc"
                      : "border border-edge text-mut hover:text-fg")
                  }
                >
                  {ETIQUETA_PESTANA[p]}
                </button>
              ))}
            </div>

            {errorPestana && (
              <p className="mt-3 font-mono text-xs text-crit">error: {errorPestana}</p>
            )}

            {/* ------------------------------------------------ pestaña ficha */}
            {pestana === "ficha" && (
              <>
                {ficha && (
                  <>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      {fichas.map(([k, v]) => (
                        <div key={k} className="border border-edge bg-void p-2">
                          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-dim">{k}</p>
                          <p className="mt-0.5 font-mono text-xs text-fg">{k === "uptime" ? humaniza(v) : v}</p>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => setConfirmando({ tipo: "reboot", puerto: null })}
                        title="Reinicia el equipo completo (1–4 min): interrumpe el servicio que atiende"
                        className="border border-warn/50 bg-warn/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-warn transition-colors hover:bg-warn/20"
                      >
                        <span className="ico">↺</span> reiniciar equipo
                      </button>
                      {afectados.length > 0 && (
                        <span className="font-mono text-[10px] text-mut" title="dispositivos que dependen de esta ip según las rutas recientes">
                          en ruta de: {afectados.map((a) => a.nombre).join(", ")}
                        </span>
                      )}
                    </div>

                    {/* ciclo poe: solo RouterOS tiene el menú; aireOS no gestiona
                        poe-out por puerto (su consejo/salida ya está en la ficha) */}
                    {marca === "mikrotik" && (
                    <div className="mt-4 border border-edge bg-void p-3">
                      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                        puertos poe <span className="text-mut">({poe.length})</span> · el ciclo corta y re-enciende la alimentación del puerto
                      </p>
                      {poe.length === 0 ? (
                        poeMenuExiste ? (
                          <p className="font-mono text-xs text-mut">
                            el menú poe existe pero no hay puertos con poe-out visible: el ciclo no está disponible
                          </p>
                        ) : (
                          <p className="font-mono text-xs text-mut">
                            esta placa no tiene el menú poe (routerboard sin poe-out): el ciclo no está disponible
                          </p>
                        )
                      ) : (
                        <table className="min-w-full text-sm">
                          <thead>
                            <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                              <th className="pb-1 pr-3">puerto</th>
                              <th className="pb-1 pr-3">poe-out</th>
                              <th className="pb-1 pr-3">prioridad</th>
                              <th className="pb-1 pr-3"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {poe.map((p) => (
                              <tr key={p.id} className="border-t border-edge/40">
                                <td className="py-1.5 pr-3 font-mono text-xs text-fg">{p.nombre}</td>
                                <td className="py-1.5 pr-3 font-mono text-xs text-acc">{p.poe_out ?? "—"}</td>
                                <td className="py-1.5 pr-3 font-mono text-xs text-mut">{p.prioridad ?? "—"}</td>
                                <td className="py-1.5 pr-3 text-right">
                                  <button
                                    onClick={() => setConfirmando({ tipo: "poe_cycle", puerto: p.nombre })}
                                    title="Corta y re-enciende el PoE de este puerto (el dispositivo conectado se reinicia)"
                                    className="font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-warn"
                                  >
                                    <span className="ico">⚡</span> ciclar
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                    )}
                  </>
                )}

                {confirmando && (
                  <ConfirmarAccion
                    ip={ip}
                    tipo={confirmando.tipo}
                    puerto={confirmando.puerto}
                    afectados={afectados}
                    onCancelar={() => setConfirmando(null)}
                    onHecho={(r) => {
                      setResultado(r);
                      setConfirmando(null);
                      void cargar();
                    }}
                  />
                )}

                {resultado && (
                  <div className="mt-3 border border-ok/40 bg-ok/5 p-3 font-mono text-xs">
                    <p className="text-ok">✓ {resultado.accion}: {resultado.resultado} · vía {resultado.transporte}</p>
                    {resultado.silenciados.length > 0 && (
                      <p className="mt-1 text-mut">
                        alertas silenciadas hasta {new Date(resultado.silenciados[0].silencio_hasta).toLocaleString()} ·{" "}
                        {resultado.silenciados.map((s) => s.nombre).join(", ")}
                      </p>
                    )}
                  </div>
                )}

                {bitacora.length > 0 && (
                  <div className="mt-4 border border-edge bg-void p-3">
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">bitácora de acciones</p>
                    <ul className="divide-y divide-edge/40">
                      {bitacora.map((a, i) => (
                        <li key={i} className="flex flex-wrap items-baseline gap-2 py-1 font-mono text-[10px]">
                          <span className="text-dim">{fmtHora(a.ts)}</span>
                          <span className={a.ok ? "text-ok" : "text-crit"}>{a.accion}{a.ok ? "" : " ✗"}</span>
                          {a.parametros?.puerto && <span className="text-mut">{a.parametros.puerto}</span>}
                          {a.parametros?.duracion && <span className="text-mut">{a.parametros.duracion}s</span>}
                          {a.resultado && <span className="text-mut">{a.resultado}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            {/* --------------------------------------------- pestaña wireless */}
            {pestana === "wireless" && wireless && (
              esWirelessAireOs(wireless) ? (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                      esquema aireOS (wstalist)
                    </span>
                    <span className="font-mono text-[10px] text-mut">
                      {wireless.registros.length} estación{wireless.registros.length === 1 ? "" : "es"}
                    </span>
                  </div>
                  {wireless.registros.length === 0 ? (
                    <>
                      <p className="mt-3 font-mono text-xs text-mut">sin estaciones conectadas ahora mismo</p>
                      {wireless.detalle && (
                        <p className="mt-1 font-mono text-[10px] text-dim">detalle del equipo: {wireless.detalle}</p>
                      )}
                    </>
                  ) : (
                    <>
                    <div className="mt-2 overflow-x-auto">
                    <table className="mt-2 min-w-full text-sm">
                      <thead>
                        <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                          <th className="pb-1 pr-3">cpe (device name)</th>
                          <th className="pb-1 pr-3">device model</th>
                          <th className="pb-1 pr-3">mac</th>
                          <th className="pb-1 pr-3" title="señal con que el ap escucha a la estación">señal</th>
                          <th className="pb-1 pr-3" title="señal bajo la vista de la estación remota">señal remota</th>
                          <th className="pb-1 pr-3" title="link potential (capacidad ATPC estimada del enlace)">link potencial</th>
                          <th className="pb-1 pr-3" title="downlink / uplink capacity que negocia el firmware">capacidad dn/up</th>
                          <th className="pb-1 pr-3" title="airtime aéreo rx / tx (%)">airtime rx/tx</th>
                          <th className="pb-1 pr-3" title="throughput actual rx / tx">throughput rx/tx</th>
                          <th className="pb-1 pr-3">last ip</th>
                          <th className="pb-1 pr-3">conectado</th>
                          <th className="pb-1 pr-3">rate tx/rx</th>
                          <th className="pb-1 pr-3">distancia</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wireless.registros.map((r, i) => (
                          <tr key={String(r.mac ?? i)} className="border-t border-edge/40">
                            <td className="py-1.5 pr-3 font-mono text-xs text-fg">{r.nombre ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.devmodel ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-fg">{r.mac ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-acc">{conUnidad(r.senal, "dBm")}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-acc">{conUnidad(r.senal_remota, "dBm")}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.potencial ?? "n/a"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.downlink ?? "—"} / {r.uplink ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.airtime_rx ?? "—"} / {r.airtime_tx ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.put_rx ?? "—"} / {r.put_tx ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.ip ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.uptime ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.tx ?? "—"} / {r.rx ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{r.distancia ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                    {/* expander de campos crudos del RADIO (mca-dump): validación
                        en vivo del esquema exacto que entrega este firmware */}
                    {wireless.muestra && Object.keys(wireless.muestra).length > 0 && (
                      <details className="mt-3 border border-edge bg-void p-2">
                        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.15em] text-mut hover:text-fg">
                          campos crudos del radio ({Object.keys(wireless.muestra).length} claves)
                        </summary>
                        <ul className="mt-2 grid gap-x-6 gap-y-0.5 sm:grid-cols-2 font-mono text-[10px]">
                          {Object.entries(wireless.muestra).map(([k, v]) => (
                            <li key={k} className="flex gap-2">
                              <span className="text-dim">{k}</span>
                              <span className="text-fg break-all">{v === null || v === "" ? "∅" : String(v)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    </>
                  )}
                </>
              ) : (
                <>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                    esquema {wireless.esquema === "nada" ? "sin radio detectado" : wireless.esquema}
                  </span>
                  {wireless.radios?.map((r) => (
                    <span
                      key={r.nombre}
                      className="border border-edge px-2 py-0.5 font-mono text-[10px] text-fg"
                      title={r.banda ?? undefined}
                    >
                      {r.nombre}
                      {r.ssid && <span className="text-mut"> · ssid: {r.ssid}</span>}
                      {r.banda && <span className="text-mut"> · {r.banda}</span>}
                      <span className={r.deshabilitada ? "text-mut" : r.corriendo ? "text-ok" : "text-warn"}>
                        {r.deshabilitada ? " · disabled" : r.corriendo ? "" : " · sin running"}
                      </span>
                    </span>
                  ))}
                  {wireless.canal && (
                    <>
                      <span className="font-mono text-[10px] text-mut">
                        frecuencia: <span className="text-fg">{campo(wireless.canal, "frequency", "channel") ?? "—"}</span>
                      </span>
                      <span className="font-mono text-[10px] text-mut">
                        señal ap: <span className="text-fg">{campo(wireless.canal, "signal-strength", "signal") ?? "—"}</span>
                      </span>
                    </>
                  )}
                </div>
                {wireless.esquema === "nada" ? (
                  <>
                    <p className="mt-3 font-mono text-xs text-mut">
                      este equipo no respondió con menú wireless clásico, wireless-fp ni wifi v7
                    </p>
                    {wireless.detalle && (
                      <p className="mt-1 font-mono text-[10px] text-dim">detalle del equipo: {wireless.detalle}</p>
                    )}
                  </>
                ) : wireless.registros.length === 0 ? (
                  <p className="mt-3 font-mono text-xs text-mut">sin clientes conectados ahora mismo</p>
                ) : (
                  <>
                    <table className="mt-2 min-w-full text-sm">
                      <thead>
                        <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                          <th className="pb-1 pr-3">interfaz</th>
                          <th className="pb-1 pr-3">radio</th>
                          <th className="pb-1 pr-3">mac</th>
                          <th className="pb-1 pr-3" title="potencia con que el cliente escucha al ap (tx-signal-strength / tx-signal)">señal tx</th>
                          <th className="pb-1 pr-3" title="señal con que el ap escucha al cliente (signal-strength / rx-signal; en hover el snr)">señal rx</th>
                          <th className="pb-1 pr-3">rate tx/rx</th>
                          <th className="pb-1 pr-3">ccq</th>
                          <th className="pb-1 pr-3">conectado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wireless.registros.map((r, i) => {
                          // "-66@6Mbps" → "-66": la señal pura va antes de la @ del rate
                          const senal = (v: string | number | boolean | null) =>
                            v == null ? null : String(v).split("@")[0] || null;
                          const snr = campo(r, "signal-to-noise");
                          return (
                            <tr key={String(campo(r, "mac-address") ?? i)} className="border-t border-edge/40">
                              <td className="py-1.5 pr-3 font-mono text-xs text-fg">{campo(r, "interface") ?? "—"}</td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-mut">{campo(r, "ssid", "radio-name") ?? "—"}</td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-fg">{campo(r, "mac-address", "mac") ?? "—"}</td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-acc">
                                {senal(campo(r, "tx-signal-strength", "tx-signal")) ?? "—"}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-acc" title={snr ? `snr: ${snr} dB` : undefined}>
                                {senal(campo(r, "signal-strength", "rx-signal", "signal")) ?? "—"}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-mut">
                                {(() => {
                                  const tx = campo(r, "tx-rate");
                                  const rx = campo(r, "rx-rate");
                                  if (tx != null || rx != null) return `TX ${tx ?? "—"} · RX ${rx ?? "—"}`;
                                  return campo(r, "rate") ?? "—";
                                })()}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-mut">
                                {(() => {
                                  const tx = campo(r, "tx-ccq");
                                  const rx = campo(r, "rx-ccq");
                                  if (tx != null || rx != null) return `TX ${tx ?? "—"} · RX ${rx ?? "—"}`;
                                  return campo(r, "ccq") ?? "—";
                                })()}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-mut">{humaniza(campo(r, "uptime", "connected-time"))}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {/* expander de campos crudos del primer registro: validación en
                        vivo de las claves exactas que entrega este RouterOS */}
                    {wireless.registros.length > 0 && (
                      <details className="mt-3 border border-edge bg-void p-2">
                        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.15em] text-mut hover:text-fg">
                          campos crudos del primer registro ({Object.keys(wireless.registros[0]).length} claves)
                        </summary>
                        <ul className="mt-2 grid gap-x-6 gap-y-0.5 sm:grid-cols-2 font-mono text-[10px]">
                          {Object.entries(wireless.registros[0]).map(([k, v]) => (
                            <li key={k} className="flex gap-2">
                              <span className="text-dim">{k}</span>
                              <span className="text-fg break-all">{v === null || v === "" ? "∅" : String(v)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </>
              )
            )}

            {/* ------------------------------------------- pestaña interfaces */}
            {pestana === "interfaces" && interfacesD && (
              <table className="mt-3 min-w-full text-sm">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                    <th className="pb-1 pr-3">puerto</th>
                    <th className="pb-1 pr-3">tipo</th>
                    <th className="pb-1 pr-3">estado</th>
                    <th className="pb-1 pr-3">mtu</th>
                    <th className="pb-1 pr-3">velocidad</th>
                    <th className="pb-1 pr-3">sfp rx/tx</th>
                  </tr>
                </thead>
                <tbody>
                  {interfacesD.interfaces.map((f) => (
                    <tr key={f.id} className="border-t border-edge/40">
                      <td className="py-1.5 pr-3 font-mono text-xs text-fg">{f.nombre}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-mut">{f.tipo}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        <span className={f.deshabilitada ? "text-mut" : f.corriendo ? "text-ok" : "text-crit"}>
                          {f.deshabilitada ? "disabled" : f.corriendo ? "running" : "down"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-mut">{f.mtu ?? "—"}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-acc">
                        {campo(f as FilaRouteros, "rate") ?? "—"}
                        {String(f["full-duplex"] ?? "").toLowerCase() === "true" ? " fdx" : ""}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-mut">
                        {campo(f as FilaRouteros, "sfp-rx-power")
                          ? `${campo(f as FilaRouteros, "sfp-rx-power")} / ${campo(f as FilaRouteros, "sfp-tx-power") ?? "—"}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* -------------------------------------------------- pestaña red */}
            {pestana === "red" && red && (
              <>
                <p className="mt-3 font-mono text-[10px] text-mut">
                  conexiones firewall activas:{" "}
                  <span className="text-fg">{red.conexiones_n != null ? red.conexiones_n : "no disponible"}</span>
                </p>

                <div className="mt-3 border border-edge bg-void p-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                    direcciones propias <span className="text-mut">({red.direcciones?.length ?? 0} en /50)</span>
                  </p>
                  {red.direcciones === null ? (
                    <p className="font-mono text-xs text-mut">el menú /ip/address no existe (¿config en otro esquema?)</p>
                  ) : red.direcciones.length === 0 ? (
                    <p className="font-mono text-xs text-mut">sin direcciones ip</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {red.direcciones.map((d, i) => (
                        <li key={i} className="border border-edge px-2 py-1 font-mono text-[10px] text-fg">
                          {campo(d, "address") ?? "—"}
                          <span className="text-mut"> · {campo(d, "interface") ?? "?"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mt-3 border border-edge bg-void p-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                    leases dhcp <span className="text-mut">({red.leases?.length ?? 0} en /200)</span>
                  </p>
                  {red.leases === null ? (
                    <p className="font-mono text-xs text-mut"> este equipo no tiene servidor dhcp</p>
                  ) : red.leases.length === 0 ? (
                    <p className="font-mono text-xs text-mut">_DHCP sin leases</p>
                  ) : (
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                          <th className="pb-1 pr-3">host</th>
                          <th className="pb-1 pr-3">ip</th>
                          <th className="pb-1 pr-3">mac</th>
                          <th className="pb-1 pr-3">estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {red.leases.map((l, i) => (
                          <tr key={i} className="border-t border-edge/40">
                            <td className="py-1.5 pr-3 font-mono text-xs text-fg">{campo(l, "host-name", "comment") ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-fg">{campo(l, "active-address", "address") ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{campo(l, "mac-address") ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{campo(l, "status") ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="mt-3 border border-edge bg-void p-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                    colas simple <span className="text-mut">({red.colas?.length ?? 0} en /100)</span>
                  </p>
                  {red.colas === null ? (
                    <p className="font-mono text-xs text-mut">el menú /queue/simple no existe</p>
                  ) : red.colas.length === 0 ? (
                    <p className="font-mono text-xs text-mut">sin colas configuradas</p>
                  ) : (
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                          <th className="pb-1 pr-3">cola</th>
                          <th className="pb-1 pr-3">destino</th>
                          <th className="pb-1 pr-3">bytes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {red.colas.map((q, i) => (
                          <tr key={i} className="border-t border-edge/40">
                            <td className="py-1.5 pr-3 font-mono text-xs text-fg">{campo(q, "name", "target") ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-mut">{campo(q, "target") ?? "—"}</td>
                            <td className="py-1.5 pr-3 font-mono text-xs text-acc">{campo(q, "bytes") ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}

            {/* --------------------------------------- pestaña log del router */}
            {pestana === "log" && logRouter && (
              <div className="mt-3 border border-edge bg-void p-3">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                  log del routeros <span className="text-mut">(últimas {logRouter.lineas.length})</span>
                </p>
                {logRouter.lineas.length === 0 ? (
                  <p className="font-mono text-xs text-mut">log vacío</p>
                ) : (
                  <ul className="divide-y divide-edge/40 font-mono text-[10px]">
                    {logRouter.lineas.map((l, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-2 py-1">
                        <span className="w-14 shrink-0 text-dim">{l.hora ?? "—"}</span>
                        {l.temas != null && (
                          <span className="text-acc">{Array.isArray(l.temas) ? l.temas.join(",") : String(l.temas)}</span>
                        )}
                        <span className="text-fg">{l.mensaje ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
