export type DispOut = {
  id: string;
  nombre: string;
  host: string;
  tipo: "icmp" | "tcp" | "http" | "dns";
  puerto: number | null;
  texto_buscado: string | null;
  dns_servidor: string | null;
  intervalo_ping_s: number;
  hop_scan_interval_min: number;
  umbral_degradado_ms: number;
  n_fallos_down: number;
  silencio_hasta: string | null;
  activo: boolean;
  en_topologia: boolean;
};

export type Regla = {
  id?: string;
  tipo: "latencia" | "perdida" | "ruta";
  umbral: number;
  ventana_min: number;
  activo: boolean;
};

export type CambioRutaEvt = {
  ts: string;
  resumen: string;
  hops: Hop[] | null;
};

export type Estado = {
  device_id: string;
  nombre: string;
  host: string;
  tipo?: string;
  estado: "ok" | "degradado" | "down";
  ultimo_rtt_ms: number | null;
  fallos_consecutivos: number;
};

export type PuntoRaw = {
  ts: string;
  rtt_ms: number | null;
  ok: boolean;
  n: number | null;
  rtt_min_ms: number | null;
  rtt_max_ms: number | null;
  rtt_median_ms: number | null;
  rtt_p95_ms: number | null;
  rtt_std_ms: number | null;
  perdida_pct: number | null;
};

export type PuntoAgg = {
  ts: string;
  avg_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  p95_ms: number | null;
  std_ms: number | null;
  perdida_pct: number | null;
};

export type Stats = {
  media: number | null;
  mediana: number | null;
  min: number | null;
  max: number | null;
  jitter: number | null;
  /** % de pings sin respuesta medido solo mientras el dispositivo estaba encendido (excluye outages). */
  perdida_pct: number | null;
  /** % del rango seleccionado en outage (dispositivo caído). */
  down_pct: number | null;
};

const esAgg = (p: PuntoRaw | PuntoAgg): p is PuntoAgg => "avg_ms" in p;

export function calcularStats(
  puntos: (PuntoRaw | PuntoAgg)[],
  outages: Outage[] = [],
  opts?: { horas?: number; t0?: number; t1?: number },
): Stats {
  // % del rango en outage (informativo: no altera las demás métricas)
  let down_pct: number | null = null;
  const t1r = opts?.t1 ?? (opts?.horas != null ? Date.now() : null);
  const t0r = opts?.t0 ?? (opts?.horas != null ? t1r! - opts.horas * 3600e3 : null);
  if (t0r != null && t1r != null) {
    let caidoMs = 0;
    for (const o of outages) {
      const i = Math.max(new Date(o.inicio).getTime(), t0r);
      const f = Math.min(o.fin ? new Date(o.fin).getTime() : Date.now(), t1r);
      if (f > i) caidoMs += f - i;
    }
    down_pct = Math.min(100, (caidoMs / Math.max(1, t1r - t0r)) * 100);
  }

  // métricas del rango completo, tal cual: los buckets caídos cuentan como pérdida
  const lecturas: { v: number; w: number }[] = [];
  const mins: number[] = [];
  const maxs: number[] = [];
  let pings = 0;
  let perdidos = 0;
  for (const p of puntos) {
    const n = esAgg(p) ? 1 : (p as PuntoRaw).n ?? 1;
    const v = esAgg(p) ? p.avg_ms : p.rtt_median_ms != null ? p.rtt_median_ms : p.ok ? p.rtt_ms : null;
    if (v != null) lecturas.push({ v, w: n });
    const mn = esAgg(p) ? p.min_ms : p.rtt_min_ms;
    const mx = esAgg(p) ? p.max_ms : p.rtt_max_ms;
    if (mn != null) mins.push(mn);
    if (mx != null) maxs.push(mx);
    pings += n;
    perdidos += (n * (p.perdida_pct ?? 0)) / 100;
  }
  const perdida = pings > 0 ? (100 * perdidos) / pings : null;
  const min = mins.length ? Math.min(...mins) : null;
  const max = maxs.length ? Math.max(...maxs) : null;
  if (!lecturas.length)
    return { media: null, mediana: null, min, max, jitter: null, perdida_pct: perdida, down_pct };

  const s = lecturas.map((l) => l.v).sort((a, b) => a - b);
  const totalW = lecturas.reduce((a, l) => a + l.w, 0);
  const k = 0.5 * (s.length - 1);
  const fi = Math.floor(k);
  const mediana = s[fi] + (s[Math.min(fi + 1, s.length - 1)] - s[fi]) * (k - fi);
  let acc = 0;
  for (const l of lecturas) acc += l.v * l.w;
  const media = totalW > 0 ? acc / totalW : null;
  let wNum = 0;
  for (const l of lecturas) wNum += l.w * (l.v - (media ?? 0)) ** 2;
  const jitter = media != null && totalW > 0 ? Math.sqrt(wNum / totalW) : null;
  return { media, mediana, min, max, jitter, perdida_pct: perdida, down_pct };
}

export type Outage = {
  id: string;
  inicio: string;
  fin: string | null;
  duracion_s: number;
  activa: boolean;
  causa: string;
  /** dónde murió la conexión, ya clasificado por el backend */
  corte: string;
  /** hay snapshot de ruta disponible (se pide por api.outageDetalle) */
  tiene_ruta: boolean;
};

export type OutageDetalle = Outage & { hops_snapshot: Hop[] | null };

export type Hueco = { inicio: string; duracion_s: number };

export type Cobertura = {
  vigilado_desde: string | null;
  vigilado_hasta: string;
  vigilado_s: number;
  pings: number;
  pings_ok: number;
  cobertura_pct: number;
  n_huecos: number;
  huecos: Hueco[];
  caidas_n: number;
  caidas_s_acum: number;
  caida_max_s: number;
  disponibilidad_pct: number | null;
  degradado_s: number;
};

export type Disp24h = {
  device_id: string;
  caidas_n: number;
  caidas_s_acum: number;
  disponibilidad_pct: number | null;
};

export type Hop = { ttl: number; ip: string | null; hostname: string | null; rtt_ms: number | null; ok: boolean };

export type DiagHop = {
  ttl: number;
  ip: string | null;
  hostname: string | null;
  muestras: number;
  ok_pct: number | null;
  rtt_avg_ms: number | null;
  rtt_p95_ms: number | null;
  rtt_max_ms: number | null;
  tipo: string;
  pista: string | null;
  manual?: boolean;
};

export const ROLES_RED = [
  "gateway local",
  "router/agregador",
  "switch",
  "radio/antena",
  "celda",
  "borde público",
  "cámara",
  "DVR",
  "PC",
  "servidor",
  "equipo objetivo",
  "otro",
] as const;

export type RolRed = (typeof ROLES_RED)[number];

export type EquipoRed = {
  id: string;
  ip: string;
  nombre: string;
  rol: RolRed;
  notas: string | null;
  actualizado_en: string;
};

export type SondeoPuerto = {
  ip: string;
  abiertos: number[];
  rol_sugerido: RolRed | null;
  confianza: number | null;
  firma: string | null;
};

export type HostVivo = {
  ip: string;
  rtt_ms: number | null;
};

export type HostLibre = {
  ip: string;
};

export type HostSilencioso = {
  ip: string;
  /** de dónde salió la pista de que está en uso: icmp por arp · catalogo · monitoreado */
  evidencia: string[];
};

// ---- acciones sobre equipos (mikrotik y ubiquiti aireOS) ----

export type MarcaEquipo = "mikrotik" | "ubiquiti";

export type MikrotikFicha = {
  transporte: string;
  identity: string | null;
  version: string;
  board: string | null;
  cpu_load: number | null;
  uptime: string;
  memoria_libre_mb: number | null;
  disco_libre_mb?: number | null;
  serie?: string | null;
  firmware_actual?: string | null;
  firmware_pendiente?: string | null;
  voltaje?: string | null;
  temperatura?: string | null;
  ubiquiti?: false;
  mikrotik?: true;
};

// ficha de un radio airMAX (aireOS) vía SSH + mca-status.sh
export type UbiquitiFicha = {
  transporte: string;
  identity: string | null;
  version: string;
  board: string | null;
  cpu_load: number | null;
  /** ya formateado por el backend ('29 d 9 h 53 m') */
  uptime: string | null;
  memoria_libre_mb: number | null;
  serie?: string | null;
  firmware_actual?: string | null;
  /** señal del radio en dBm (None si el firmware no la reporta) */
  senal?: string | null;
  ccq?: string | null;
  stations_n?: number | null;
  essid?: string | null;
  /** 'ap' | 'sta' | 'ap-ptp' | … (rol de red: bridge/router) */
  modo?: string | null;
  ruido?: string | null;
  radio_modo?: string | null;
  frecuencia_mhz?: number | null;
  canal_mhz?: number | null;
  txpower_dbm?: number | null;
  /** potencial medio de estaciones (equivalente AC del ccq) */
  potencial?: string | null;
  /** ip de la eth no-loopback (mca-dump interfaces) */
  lan_ip?: string | null;
  ubiquiti?: true;
  mikrotik?: false;
};

export type FichaEquipo = MikrotikFicha | UbiquitiFicha;

export const esUbiquiti = (f: FichaEquipo | null): f is UbiquitiFicha =>
  f != null && f.ubiquiti === true;

export type PoePuerto = {
  id: string;
  nombre: string;
  poe_out: string | null;
  prioridad: string | null;
};

// fila cruda de RouterOS (REST/API entregan strings, a veces bool)
export type FilaRouteros = Record<string, string | number | boolean | null>;

export type RespuestaWireless = {
  ip: string;
  esquema: "classic" | "classic-fp" | "wifi-v7" | "nada";
  registros: FilaRouteros[];
  canal: FilaRouteros | null;
  radios: {
    nombre: string;
    ssid: string | null;
    banda: string | null;
    corriendo: boolean;
    deshabilitada: boolean;
  }[];
  detalle?: string | null;
};

// fila de wstalist normalizada a lo que pinta la tabla de CPEs aireOS
// (paridad con la Station List de la UI web de airOS: device model, link
// potential, señal remota, downlink/uplink capacity, airtime, throughput…)
export type EstacionAireOs = {
  nombre: string | null;
  devmodel: string | null;
  mac: string | null;
  ip: string | null;
  senal: string | null;
  senal_remota: string | null;
  ccq: string | null;
  potencial: string | null;
  downlink: string | null;
  uplink: string | null;
  airtime_tx: string | null;
  airtime_rx: string | null;
  put_rx: string | null;
  put_tx: string | null;
  tx: string | null;
  rx: string | null;
  distancia: string | null;
  uptime: string | null;
};

export type RespuestaWirelessAireOs = {
  ip: string;
  esquema: "aireOS";
  registros: EstacionAireOs[];
  canal: null;
  radios: never[];
  /** campos crudos (aplanados) del RADIO (mca-dump): esquema exacto del firmware */
  muestra?: Record<string, string> | null;
  detalle?: string | null;
};

export type RespuestaWirelessMixta = RespuestaWireless | RespuestaWirelessAireOs;

export const esWirelessAireOs = (
  r: RespuestaWirelessMixta | null
): r is RespuestaWirelessAireOs => r != null && (r as RespuestaWirelessAireOs).esquema === "aireOS";

export type RespuestaInterfaces = {
  ip: string;
  interfaces: (FilaRouteros & {
    id: string;
    nombre: string;
    tipo: string;
    corriendo: boolean;
    deshabilitada: boolean;
    mtu: string | null;
    mac?: string | null;
    rate?: string | number | boolean | null;
    "full-duplex"?: string | number | boolean | null;
    "sfp-rx-power"?: string | number | boolean | null;
    "sfp-tx-power"?: string | number | boolean | null;
  })[];
};

export type RespuestaRed = {
  ip: string;
  leases: FilaRouteros[] | null;
  direcciones: FilaRouteros[] | null;
  colas: FilaRouteros[] | null;
  conexiones_n: number | null;
};

export type RespuestaLogRouter = {
  ip: string;
  lineas: { hora: string | null; temas: string | string[] | null; mensaje: string | null }[];
};

export type DispositivoAfectado = { id: string; nombre: string };

export type AccionResultado = {
  ok: boolean;
  ip: string;
  accion: string;
  resultado: string;
  transporte: string;
  silenciados: (DispositivoAfectado & { silencio_hasta: string })[];
  en_ruta_de: string[];
};

export type EntradaAccionLog = {
  ts: string;
  accion: string;
  parametros: { puerto?: string; duracion?: number; transporte?: string | null } | null;
  resultado: string | null;
  ok: boolean;
};

export type Descubrimiento = {
  cidr: string;
  n_hosts: number;
  n_escaneados: number;
  vivos: HostVivo[];
  libres: HostLibre[];
  ocupadas_silenciosas: HostSilencioso[];
};

export type HostIdent = {
  ip: string;
  abiertos: number[];
  rol_sugerido: string | null;
  confianza: number | null;
  firma: string | null;
  catalogo_nombre: string | null;
  catalogo_rol: string | null;
};

export type TopoNodo = {
  ip: string;
  nombre: string | null;
  rol: string | null;
  catalogado: boolean;
  monitoreado: string | null; // id del dispositivo vivo cuyo host es esta ip
  device_id: string | null; // dispositivo REGISTRADO en el mapa (esta entrada es su nodo)
  host: string | null;
  vigilado: boolean; // el dispositivo registrado aún existe en el monitoreo
  rango: number;
  isla: boolean;
  vistos: number;
  dispositivos_n: number;
  rtt_avg_ms: number | null;
  primera: string | null;
  alta: string | null;
  ultima: string | null;
  inactiva?: boolean; // persistido sin escaneos recientes
};

export type TopoArista = {
  de: string;
  a: string;
  n_scans: number;
  dispositivos_n: number;
  delta_avg_ms: number | null;
  ultima: string | null;
  de_rango: number;
  a_rango: number;
  subida: boolean;
  inactiva?: boolean; // persistida sin escaneos recientes
};

export type Topologia = {
  horas: number;
  n_scans: number;
  raiz: string | null;
  nodos: TopoNodo[];
  aristas: TopoArista[];
};

// topología general: mismo grafo + selección de dispositivos del usuario
export type TopoSel = {
  id: string;
  nombre: string;
  host: string;
  incluido: boolean;
};

export type TopologiaGeneral = Topologia & {
  seleccion: TopoSel[];
};

export type DiagTramo = {
  de_ttl: number;
  a_ttl: number;
  a_ip: string | null;
  a_hostname: string | null;
  n: number;
  delta_avg_ms: number | null;
  delta_p95_ms: number | null;
  delta_max_ms: number | null;
};

export type Diagnostico = {
  horas: number;
  n_scans: number;
  ecos_destino: number;
  destino_alcanzado_pct: number | null;
  hasta_ttl: { ttl: number; scans: number }[];
  hops: DiagHop[];
  tramos: DiagTramo[];
};

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => {}))?.detail ?? res.statusText);
  return res.json();
}

export const api = {
  dispositivos: () => fetch("/api/devices").then((r) => j<DispOut[]>(r)),
  crear: (d: Partial<DispOut>) =>
    fetch("/api/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }).then((r) => j<DispOut>(r)),
  editar: (id: string, d: Partial<DispOut>) =>
    fetch(`/api/devices/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }).then((r) => j<DispOut>(r)),
  eliminar: (id: string) => fetch(`/api/devices/${id}`, { method: "DELETE" }).then((r) => r.ok),
  estado: () => fetch("/api/status").then((r) => j<{ dispositivos: Estado[]; version: number }>(r)),
  muestras: (id: string, h: number, resolucion = "raw") =>
    fetch(`/api/devices/${id}/samples?desde=${encodeURIComponent(new Date(Date.now() - h * 3600e3).toISOString())}&resolucion=${resolucion}`).then((r) => j<{ puntos: (PuntoRaw | PuntoAgg)[] }>(r)),
  muestrasRango: (id: string, desdeMs: number, hastaMs: number, resolucion = "raw") =>
    fetch(
      `/api/devices/${id}/samples?desde=${encodeURIComponent(new Date(desdeMs).toISOString())}&hasta=${encodeURIComponent(new Date(hastaMs).toISOString())}&resolucion=${resolucion}`
    ).then((r) => j<{ puntos: (PuntoRaw | PuntoAgg)[] }>(r)),
  outages: (id: string, horas: number) =>
    fetch(`/api/devices/${id}/outages?desde=${encodeURIComponent(new Date(Date.now() - horas * 3600e3).toISOString())}`).then((r) => j<Outage[]>(r)),
  outageDetalle: (id: string) =>
    fetch(`/api/outages/${id}`).then((r) => j<OutageDetalle>(r)),
  hops: (id: string) => fetch(`/api/devices/${id}/hops`).then((r) => j<Hop[]>(r)),
  cobertura: (id: string, horas = 24) =>
    fetch(`/api/devices/${id}/cobertura?horas=${horas}`).then((r) => j<Cobertura>(r)),
  disponibilidad: (horas = 24) =>
    fetch(`/api/disponibilidad?horas=${horas}`).then((r) => j<Disp24h[]>(r)),
  reglas: (id: string) => fetch(`/api/devices/${id}/reglas`).then((r) => j<Regla[]>(r)),
  guardarReglas: (id: string, reglas: Regla[]) =>
    fetch(`/api/devices/${id}/reglas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reglas),
    }).then((r) => j<Regla[]>(r)),
  silenciar: (id: string, horas: number) =>
    fetch(`/api/devices/${id}/silencio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ horas }),
    }).then((r) => j<DispOut>(r)),
  reiniciarHistorial: (id: string) =>
    fetch(`/api/devices/${id}/reiniciar`, { method: "POST" }).then((r) => r.ok),
  cambiosRuta: (id: string) => fetch(`/api/devices/${id}/cambios_ruta`).then((r) => j<CambioRutaEvt[]>(r)),
  rutaReferencia: (id: string) =>
    fetch(`/api/devices/${id}/ruta_referencia`).then((r) => j<{ ts: string | null; hops: Hop[] }>(r)),
  diagnostico: (id: string, horas: number) =>
    fetch(`/api/devices/${id}/diagnostico?horas=${horas}`).then((r) => j<Diagnostico>(r)),
  equipos: () => fetch("/api/equipos_red").then((r) => j<EquipoRed[]>(r)),
  crearEquipo: (e: { ip: string; nombre: string; rol: string; notas?: string | null }) =>
    fetch("/api/equipos_red", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(e),
    }).then((r) => j<EquipoRed>(r)),
  editarEquipo: (ip: string, e: { ip: string; nombre: string; rol: string; notas?: string | null }) =>
    fetch(`/api/equipos_red/${encodeURIComponent(ip)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(e),
    }).then((r) => j<EquipoRed>(r)),
  eliminarEquipo: (ip: string) =>
    fetch(`/api/equipos_red/${encodeURIComponent(ip)}`, { method: "DELETE" }).then((r) => r.ok),
  sondeoRuta: (id: string, horas = 24) =>
    fetch(`/api/devices/${id}/sondeo_ruta?horas=${horas}`).then((r) => j<{ horas: number; resultados: SondeoPuerto[] }>(r)),
  descubrir: (cidr: string) =>
    fetch("/api/descubrir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cidr }),
    }).then((r) => j<Descubrimiento>(r)),
  identificar: (ips: string[]) =>
    fetch("/api/identificar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ips }),
    }).then((r) => j<{ resultados: HostIdent[] }>(r)),
  // ---- acciones sobre equipos (mikrotik / ubiquiti aireOS) ----
  credencialAccion: (ip: string) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/credencial`).then((r) =>
      j<{ ip: string; existe: boolean; usuario: string | null; marca: MarcaEquipo | null }>(r),
    ),
  guardarCredencialAccion: (ip: string, datos: { usuario: string; password: string }) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/credencial`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(datos),
    }).then((r) => j<{ ok: boolean; marca: MarcaEquipo; transporte: string; version: string }>(r)),
  borrarCredencialAccion: (ip: string) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/credencial`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  infoEquipo: (ip: string, forzar = false) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/info${forzar ? "?forzar=1" : ""}`).then((r) =>
      j<{ ip: string; marca: MarcaEquipo; ficha: FichaEquipo; poe_puertos: PoePuerto[]; poe_menu_existe: boolean }>(r),
    ),
  reinicioEquipo: (ip: string, silenciar: boolean) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/reboot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ silenciar, confirmar: true }),
    }).then((r) => j<AccionResultado>(r)),
  wireless: (ip: string, forzar = false) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/wireless${forzar ? "?forzar=1" : ""}`).then((r) =>
      j<RespuestaWirelessMixta>(r)
    ),
  interfacesRouteros: (ip: string) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/interfaces`).then((r) => j<RespuestaInterfaces>(r)),
  redRouteros: (ip: string) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/red`).then((r) => j<RespuestaRed>(r)),
  logRouteros: (ip: string) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/log_router`).then((r) => j<RespuestaLogRouter>(r)),
  afectadosAccion: (ip: string) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/afectados`).then((r) => j<{ ip: string; afectados: DispositivoAfectado[] }>(r)),
  cicloPoe: (ip: string, puerto: string, silenciar: boolean) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/poe_cycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ puerto, duracion: 5, silenciar, confirmar: true }),
    }).then((r) => j<AccionResultado>(r)),
  logAcciones: (ip: string) =>
    fetch(`/api/acciones/${encodeURIComponent(ip)}/log`).then((r) => j<{ ip: string; acciones: EntradaAccionLog[] }>(r)),
  pruebaPing: (host: string, signal?: AbortSignal) =>
    fetch(`/api/prueba/ping?host=${encodeURIComponent(host)}`, { signal }).then((r) =>
      j<{ host: string; ok: boolean; rtt_ms: number | null; linea: string }>(r)
    ),
  pruebaRuta: (host: string, signal?: AbortSignal) =>
    fetch(`/api/prueba/ruta?host=${encodeURIComponent(host)}`, { signal }).then((r) =>
      j<{ host: string; hops: Hop[] }>(r)
    ),
  buscarEquipo: (ip: string, signal?: AbortSignal) =>
    fetch(`/api/equipos_red/${encodeURIComponent(ip)}`, { signal }).then((r) =>
      r.ok ? (j<EquipoRed>(r) as Promise<EquipoRed | null>) : (Promise.resolve(null) as Promise<EquipoRed | null>)
    ),
  topologia: (horas = 24) =>
    fetch(`/api/topologia?horas=${horas}`).then((r) => j<Topologia>(r)),
  topologiaGeneral: (horas = 24) =>
    fetch(`/api/topologia_general?horas=${horas}`).then((r) => j<TopologiaGeneral>(r)),
  reasentarTopologia: () =>
    fetch("/api/topologia_general/reasentar", { method: "POST" }).then((r) => j<TopologiaGeneral>(r)),
  quitarTopologia: (id: string) =>
    fetch(`/api/devices/${id}/topologia`, { method: "DELETE" }).then((r) => r.ok),
  quitarNodoTopo: (ip: string) =>
    fetch(`/api/topologia_general/nodos/${ip}`, { method: "DELETE" }).then((r) => r.ok),
  incluirTopologia: (id: string, incluir: boolean) =>
    fetch(`/api/devices/${id}/topologia`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ incluir }),
    }).then((r) => j<DispOut>(r)),
};

export const fmtDur = (s: number) => {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};

export const fmtHora = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
