import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { EquipoRed, RolRed } from "./api";
import { ROLES_RED } from "./api";
import { BotonCopiar } from "./BotonCopiar";
import { PanelEquipos } from "./PanelEquipos";

// comparación de IP por octetos (10.9.x sortea antes que 10.10.x numéricamente
// correcto; el orden string del backend lo dejaría al revés)
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

type CampoOrden = "ip" | "nombre" | "rol";


// formulario de alta/edición de una entrada del catálogo
function FormEquipo({
  inicial,
  onGuardar,
  onCancelar,
}: {
  inicial: EquipoRed | null;
  onGuardar: (dato: { ip: string; nombre: string; rol: RolRed; notas: string | null }) => Promise<string | null>;
  onCancelar: () => void;
}) {
  const [ip, setIp] = useState(inicial?.ip ?? "");
  const [nombre, setNombre] = useState(inicial?.nombre ?? "");
  const [rol, setRol] = useState<RolRed>(inicial?.rol ?? "otro");
  const [notas, setNotas] = useState(inicial?.notas ?? "");
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    if (!ip.trim() || !nombre.trim()) {
      setError("IP y nombre son obligatorios");
      return;
    }
    setGuardando(true);
    setError("");
    const err = await onGuardar({ ip: ip.trim(), nombre: nombre.trim(), rol, notas: notas.trim() || null });
    setGuardando(false);
    if (err) setError(err);
  };

  const campo = "w-40";
  return (
    <div className="border border-acc/40 bg-acc/5 p-3">
      <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
        {inicial ? "editar equipo" : "nuevo equipo en el catálogo"}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="10.0.0.1" className={`inp ${campo}`} maxLength={45} />
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="nombre (ej. router cruces)"
          className="inp w-56"
          maxLength={100}
        />
        <select value={rol} onChange={(e) => setRol(e.target.value as RolRed)} className={`inp ${campo}`}>
          {ROLES_RED.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <input value={notas ?? ""} onChange={(e) => setNotas(e.target.value)} placeholder="notas (opcional)" className="inp w-56" maxLength={255} />
        <button
          onClick={guardar}
          disabled={guardando}
          className="border border-acc/50 bg-acc/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20 disabled:opacity-50"
        >
          {guardando ? "guardando…" : (<><span className="ico">✓</span> guardar</>)}
        </button>
        <button
          onClick={onCancelar}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
        >
          <span className="ico">×</span> cancelar
        </button>
      </div>
      {error && <p className="mt-2 font-mono text-xs text-crit">{error}</p>}
    </div>
  );
}

export function EquiposRed({ onVolver }: { onVolver: () => void }) {
  const [equipos, setEquipos] = useState<EquipoRed[]>([]);
  const [orden, setOrden] = useState<{ campo: CampoOrden; asc: boolean }>({ campo: "ip", asc: true });
  // buscador en vivo: filtra por ip, nombre, rol o notas (sin acentos)
  const [filtro, setFiltro] = useState("");
  const [alta, setAlta] = useState(false);
  const [editando, setEditando] = useState<EquipoRed | null>(null);
  const [error, setError] = useState("");
  // importador de The Dude
  const [importando, setImportando] = useState(false);
  const [resumenImport, setResumenImport] = useState<null | {
    n_xml: number;
    insertadas: number;
    omitidas: number;
    duplicados_xml: number;
    sin_ip: number;
    ip_invalida: number;
    por_rol: Record<string, number>;
  }>(null);
  // exportar / importar el catálogo completo como JSON portable
  const [importandoCat, setImportandoCat] = useState(false);  const [resumenCatalogo, setResumenCatalogo] = useState<null | {
    n_archivo: number;
    insertadas: number;
    actualizadas: number;
    omitidas: number;
    ip_invalida: number;
    rol_invalido: number;
    sin_nombre: number;
    por_rol: Record<string, number>;
  }>(null);
  // panel de acceso a equipos (credencial, ficha, poe_cycle, reinicio)
  const [panel, setPanel] = useState<{ ip: string; nombre: string } | null>(null);

  const cargar = async () => {
    try {
      setEquipos(await api.equipos());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    cargar();
  }, []);

  const toggleOrden = (campo: CampoOrden) =>
    setOrden((o) => (o.campo === campo ? { campo, asc: !o.asc } : { campo, asc: true }));

  const ordenados = useMemo(() => {
    const esc = orden.asc ? 1 : -1;
    const cmpBase: Record<CampoOrden, (a: EquipoRed, b: EquipoRed) => number> = {
      ip: (a, b) => cmpIp(a.ip, b.ip),
      nombre: (a, b) => a.nombre.localeCompare(b.nombre, "es") || cmpIp(a.ip, b.ip),
      rol: (a, b) => a.rol.localeCompare(b.rol, "es") || cmpIp(a.ip, b.ip),
    };
    return [...equipos].sort((a, b) => esc * cmpBase[orden.campo](a, b));
  }, [equipos, orden]);

  // quita diacríticos para que «celda» encuentre «cámara» etc.
  const normaliza = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const visibles = useMemo(() => {
    const q = normaliza(filtro.trim());
    if (!q) return ordenados;
    return ordenados.filter(
      (e) =>
        normaliza(e.ip).includes(q) ||
        normaliza(e.nombre).includes(q) ||
        normaliza(e.rol).includes(q) ||
        (e.notas ? normaliza(e.notas).includes(q) : false),
    );
  }, [ordenados, filtro]);

  const guardar = async (dato: { ip: string; nombre: string; rol: RolRed; notas: string | null }): Promise<string | null> => {
    try {
      if (editando) await api.editarEquipo(editando.ip, dato);
      else await api.crearEquipo(dato);
      setEditando(null);
      setAlta(false);
      await cargar();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const eliminar = async (e: EquipoRed) => {
    if (!confirm(`¿Quitar «${e.nombre}» (${e.ip}) del catálogo?`)) return;
    await api.eliminarEquipo(e.ip);
    await cargar();
  };

  // importa el XML de The Dude: agrega IPs nuevas, no toca lo catalogado a mano
  const importarDude = async (archivo: File) => {
    setImportando(true);
    setResumenImport(null);
    setError("");
    try {
      const texto = await archivo.text();
      const r = await fetch("/api/equipos_red/importado", {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: texto,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail ?? r.statusText);
      setResumenImport(data);
      await cargar();
    } catch (e) {
      setError(`importación: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportando(false);
    }
  };

  // descarga el catálogo completo como JSON portable (para otro Bloodraven)
  const exportar = async () => {
    setError("");
    try {
      const es = await api.equipos();
      if (!es.length) {
        setError("exportación: el catálogo está vacío, nada que exportar");
        return;
      }
      const doc = {
        aplicacion: "Bloodraven",
        tipo: "catalogo",
        version: 1,
        exportado_en: new Date().toISOString(),
        equipos: es.map((e) => ({ ip: e.ip, nombre: e.nombre, rol: e.rol, notas: e.notas })),
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `bloodraven-catalogo-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`exportación: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // importa el JSON exportado por otra instalación de Bloodraven
  const importarCatalogo = async (archivo: File) => {
    const reemplaza = confirm(
      "¿Actualizar también los equipos que ya estén en tu catálogo local?\n\n" +
        "Aceptar = reemplazar · nombre/rol/notas toman el valor del archivo (fiel a la otra instalación)\n" +
        "Cancelar = combinar · solo agrega las IPs nuevas, no se toca lo catalogado aquí",
    );
    setImportandoCat(true);
    setResumenCatalogo(null);
    setError("");
    try {
      const r = await fetch(`/api/equipos_red/exportacion?modo=${reemplaza ? "reemplazar" : "combinar"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await archivo.text(),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail ?? r.statusText);
      setResumenCatalogo(data);
      await cargar();
    } catch (e) {
      setError(`importación del catálogo: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportandoCat(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge pb-4">
        <button
          onClick={onVolver}
          className="border border-edge bg-panel px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
        >
                    <span className="ico">◂</span> Volver
        </button>
        <h2 className="text-xl font-semibold tracking-[0.06em] text-fg">Catálogo de equipos de red</h2>
        <span className="font-mono text-xs text-mut">
          ip → nombre y rol; lo declarado aquí anula la clasificación inferida del diagnóstico
        </span>
        {alta ? (
          <span className="ml-auto" />
        ) : (
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={exportar}
              title="Descarga todo el catálogo como JSON portable para cargarlo en otra instalación de Bloodraven"
              className="border border-edge px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/50 hover:bg-acc/10 hover:text-acc"
            >
              <span className="ico">⭱</span> exportar (.json)
            </button>
            <label
              className={`cursor-pointer border border-edge px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/50 hover:bg-acc/10 hover:text-acc ${importandoCat ? "pointer-events-none opacity-50" : ""}`}
              title="Toma el JSON exportado por otra instalación de Bloodraven y lo agrega a tu catálogo"
            >
              {importandoCat ? "importando…" : (<><span className="ico">⭳</span> importar catálogo (.json)</>)}
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                disabled={importandoCat}
                onChange={(ev) => {
                  const f = ev.target.files?.[0];
                  if (f) importarCatalogo(f);
                  ev.target.value = "";
                }}
              />
            </label>
            <label
              className={`cursor-pointer border border-edge px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:border-acc/50 hover:bg-acc/10 hover:text-acc ${importando ? "pointer-events-none opacity-50" : ""}`}
              title="Agregar las IPs del export XML de The Dude (no se toca lo catalogado a mano)"
            >
              {importando ? "importando…" : (<><span className="ico">⭳</span> importar dude (.xml)</>)}
              <input
                type="file"
                accept=".xml,text/xml,application/xml"
                className="hidden"
                disabled={importando}
                onChange={(ev) => {
                  const f = ev.target.files?.[0];
                  if (f) importarDude(f);
                  ev.target.value = "";
                }}
              />
            </label>
            <button
              onClick={() => setAlta(true)}
              className="border border-acc/50 bg-acc/10 px-4 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20"
            >
              <span className="ico">+</span> Equipo
            </button>
          </span>
        )}
      </div>

      {importando && (
        <p className="border border-edge bg-panel p-3 font-mono text-xs text-mut">
          leyendo el XML de The Dude… (el archivo pesa ~100 MB; puede tardar unos segundos)
        </p>
      )}

      {resumenImport && (
        <div className="border border-ok/40 bg-ok/5 p-3 font-mono text-xs">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">resumen importación dude</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className="text-fg">equipos en el XML <span className="text-acc">{resumenImport.n_xml}</span></span>
            <span className="text-ok">agregadas <span className="text-fg">{resumenImport.insertadas}</span></span>
            <span className="text-mut">omitidas (ya catalogadas) <span className="text-fg">{resumenImport.omitidas}</span></span>
            <span className="text-dim">duplicadas en XML <span className="text-fg">{resumenImport.duplicados_xml}</span></span>
            {resumenImport.sin_ip > 0 && <span className="text-warn">sin IP <span className="text-fg">{resumenImport.sin_ip}</span></span>}
            {resumenImport.ip_invalida > 0 && <span className="text-warn">IP inválida <span className="text-fg">{resumenImport.ip_invalida}</span></span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 text-dim">
            {Object.entries(resumenImport.por_rol).map(([rol, n]) => (
              <span key={rol}>{rol}: <span className="text-mut">{n}</span></span>
            ))}
          </div>
        </div>
      )}

      {resumenCatalogo && (
        <div className="border border-ok/40 bg-ok/5 p-3 font-mono text-xs">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-dim">
            resumen importación del catálogo
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className="text-fg">equipos en el archivo <span className="text-acc">{resumenCatalogo.n_archivo}</span></span>
            <span className="text-ok">agregadas <span className="text-fg">{resumenCatalogo.insertadas}</span></span>
            {resumenCatalogo.actualizadas > 0 && (
              <span className="text-acc">actualizadas <span className="text-fg">{resumenCatalogo.actualizadas}</span></span>
            )}
            <span className="text-mut">omitidas (ya catalogadas) <span className="text-fg">{resumenCatalogo.omitidas}</span></span>
          </div>
          {resumenCatalogo.ip_invalida > 0 || resumenCatalogo.rol_invalido > 0 || resumenCatalogo.sin_nombre > 0 ? (
            <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
              {resumenCatalogo.ip_invalida > 0 && <span className="text-warn">IP inválida <span className="text-fg">{resumenCatalogo.ip_invalida}</span></span>}
              {resumenCatalogo.rol_invalido > 0 && <span className="text-warn">rol desconocido <span className="text-fg">{resumenCatalogo.rol_invalido}</span></span>}
              {resumenCatalogo.sin_nombre > 0 && <span className="text-warn">sin nombre <span className="text-fg">{resumenCatalogo.sin_nombre}</span></span>}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-x-4 text-dim">
            {Object.entries(resumenCatalogo.por_rol).map(([rol, n]) => (
              <span key={rol}>{rol}: <span className="text-mut">{n}</span></span>
            ))}
          </div>
        </div>
      )}

      {error && <p className="font-mono text-xs text-crit">error: {error}</p>}

      {(alta || editando) && (
        <FormEquipo
          inicial={editando}
          onGuardar={guardar}
          onCancelar={() => {
            setAlta(false);
            setEditando(null);
          }}
        />
      )}

      <section className="border border-edge bg-panel p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
            <span className="text-fg">{visibles.length}</span> equipos catalogados
            {filtro && (
              <span className="text-mut">
                {" "}· filtrando «{filtro.trim()}» ({equipos.length} en total)
              </span>
            )}{" "}
            <span className="text-edgehi">/</span> clic en <span className="text-mut">ip · nombre · rol</span> para ordenar
          </h3>
        </div>
        <div className="mb-3 flex items-center gap-2">
          <input
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="buscar por ip o nombre…"
            title="Filtra en vivo por ip, nombre, rol o notas (ignora acentos)"
            className="inp w-full max-w-96"
            maxLength={100}
          />
          {filtro && (
            <button
              onClick={() => setFiltro("")}
              title="Limpiar el filtro"
              className="font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
            >
              <span className="ico">✕</span> limpiar
            </button>
          )}
        </div>
        {equipos.length === 0 ? (
          <p className="font-mono text-xs text-mut">
            Catálogo vacío. Agrega los equipos de tu red (routers, radios, PCs, cámaras, DVR) o cataloga un hop
            directamente desde el panel de diagnóstico en el detalle de cada dispositivo.
          </p>
        ) : visibles.length === 0 ? (
          <p className="font-mono text-xs text-mut">
            Ningún equipo coincide con «{filtro.trim()}». Prueba con otra IP o nombre.
          </p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-dim">
                {(
                  [
                    ["ip", "IP"],
                    ["nombre", "nombre"],
                    ["rol", "rol"],
                    ["notas", "notas"],
                    ["actualizado", "actualizado"],
                  ] as [CampoOrden | "notas" | "actualizado", string][]
                ).map(([campo, label]) => (
                  <th key={campo} className="pb-1 pr-3 font-medium">
                    {campo === "ip" || campo === "nombre" || campo === "rol" ? (
                      <button
                        onClick={() => toggleOrden(campo)}
                        title={orden.campo === campo ? `Ordenado por ${label} · ${orden.asc ? "ascendente" : "descendente"} — clic para invertir` : `Ordenar por ${label}`}
                        className={`transition-colors hover:text-acc ${orden.campo === campo ? "text-acc" : ""}`}
                      >
                        {label}
                        {orden.campo === campo && <span className="ico ml-1">{orden.asc ? "▲" : "▼"}</span>}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                ))}
                <th className="pb-1 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((e) => (
                <tr key={e.id} className="border-t border-edge/40">
                  <td className="py-1.5 pr-3 font-mono text-xs text-fg">
                    <span className="flex items-center gap-1.5">
                      {e.ip}
                      <BotonCopiar texto={e.ip} titulo={`copiar ${e.ip}`} />
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-fg">{e.nombre}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-acc">{e.rol}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-mut">{e.notas || "—"}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-dim">
                    {new Date(e.actualizado_en).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => setPanel({ ip: e.ip, nombre: e.nombre })}
                      title="Panel de acceso: credenciales, ficha del equipo (mikrotik o ubiquiti) y acciones (poe_cycle, reinicio)"
                      className="mr-2 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:text-acc"
                    >
                      <span className="ico">◆</span> acceso
                    </button>
                    <button
                      onClick={() => {
                        setAlta(false);
                        setEditando(e);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                      className="mr-2 font-mono text-[10px] uppercase tracking-[0.15em] text-mut underline decoration-edgehi underline-offset-4 transition-colors hover:text-fg"
                    >
                      <span className="ico">✎</span> editar
                    </button>
                    <button
                      onClick={() => eliminar(e)}
                      className="font-mono text-[10px] uppercase tracking-[0.15em] text-crit/70 transition-colors hover:text-crit"
                    >
                      <span className="ico">✕</span> quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {panel && <PanelEquipos ip={panel.ip} nombre={panel.nombre} onCerrar={() => setPanel(null)} />}
    </div>
  );
}
