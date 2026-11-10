import { useEffect, useState } from "react";

import { api } from "./api";
import type { DispOut, Regla } from "./api";

const vacio = {
  nombre: "",
  host: "",
  tipo: "icmp" as DispOut["tipo"],
  puerto: null as number | null,
  texto_buscado: "" as string | null,
  dns_servidor: "" as string | null,
  intervalo_ping_s: 30,
  hop_scan_interval_min: 10,
  umbral_degradado_ms: 150,
  n_fallos_down: 3,
  activo: true,
};

const REGLAS_DEF: Regla[] = [
  { tipo: "latencia", umbral: 200, ventana_min: 5, activo: false },
  { tipo: "perdida", umbral: 5, ventana_min: 10, activo: false },
  { tipo: "ruta", umbral: 1, ventana_min: 10, activo: false },
];

const PLACEHOLDER: Record<string, string> = {
  icmp: "IP o dominio (ej. 8.8.8.8)",
  tcp: "IP o dominio (chequeo de puerto)",
  http: "URL completa (https://sitio.com/salud)",
  dns: "Dominio a resolver (ej. ejemplo.com)",
};

export function FormDispositivo({
  inicial,
  prefill,
  onGuardar,
  onCerrar,
}: {
  inicial?: DispOut | null;
  prefill?: { nombre: string; host: string } | null;
  onGuardar: (d: Partial<DispOut>, reglas: Regla[]) => Promise<void>;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<Partial<DispOut>>(
    inicial
      ? {
          ...inicial,
          texto_buscado: inicial.texto_buscado ?? "",
          dns_servidor: inicial.dns_servidor ?? "",
        }
      : { ...vacio, ...(prefill ?? {}) }
  );
  const [reglas, setReglas] = useState<Regla[]>(REGLAS_DEF);
  const [error, setError] = useState("");
  const campo = (k: keyof DispOut) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) =>
    setForm({
      ...form,
      [k]:
        k === "nombre" || k === "host" || k === "texto_buscado" || k === "dns_servidor" || k === "tipo"
          ? (e.target.value as string)
          : Number(e.target.value),
    });

  useEffect(() => {
    if (!inicial?.id) return;
    api.reglas(inicial.id)
      .then((rows) => {
        const porTipo = new Map(rows.map((r) => [r.tipo, r]));
        setReglas(REGLAS_DEF.map((d) => porTipo.get(d.tipo) ?? d));
      })
      .catch(() => {});
  }, [inicial?.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        // cerrar solo si la pulsación empieza directamente en el fondo;
        // evita cierres al arrastrar fuera del modal tras seleccionar texto en un input
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <form
        className="tick tick-acc max-h-[85vh] w-[30rem] space-y-4 overflow-auto border border-edgehi bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (form.tipo === "tcp" && !form.puerto) {
            setError("El chequeo TCP necesita un puerto.");
            return;
          }
          onGuardar(form, reglas);
        }}
      >
        <h2 className="border-b border-edge pb-3 text-lg font-semibold tracking-[0.06em]">
          {inicial ? "Editar dispositivo" : "Nuevo dispositivo"}
        </h2>
        <label className="block">
          <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Nombre</span>
          <input required autoFocus value={form.nombre ?? ""} onChange={campo("nombre")} className="inp" />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Tipo de chequeo</span>
            <select value={form.tipo ?? "icmp"} onChange={campo("tipo")} className="inp">
              <option value="icmp">ICMP ping</option>
              <option value="tcp">TCP puerto</option>
              <option value="http">HTTP página</option>
              <option value="dns">DNS resolución</option>
            </select>
          </label>
          <label>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">
              {form.tipo === "tcp" ? "Puerto *" : form.tipo === "http" ? "Puerto" : "—"}
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              value={form.puerto ?? ""}
              onChange={campo("puerto")}
              disabled={form.tipo === "icmp" || form.tipo === "dns"}
              className="inp disabled:opacity-40"
            />
          </label>
          {form.tipo === "dns" ? (
            <label>
              <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Servidor DNS</span>
              <input placeholder="(sistema)" value={form.dns_servidor ?? ""} onChange={campo("dns_servidor")} className="inp" />
            </label>
          ) : form.tipo === "http" ? (
            <label>
              <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Texto esperado</span>
              <input placeholder="(ninguno)" value={form.texto_buscado ?? ""} onChange={campo("texto_buscado")} className="inp" />
            </label>
          ) : (
            <div />
          )}
        </div>

        <label className="block">
          <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">
            {form.tipo === "http" ? "URL completa" : "Host"}
          </span>
          <input required value={form.host ?? ""} onChange={campo("host")} placeholder={PLACEHOLDER[form.tipo ?? "icmp"]} className="inp" />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Chequeo cada (s)</span>
            <input type="number" min={1} max={3600} value={form.intervalo_ping_s ?? 30} onChange={campo("intervalo_ping_s")} className="inp" />
          </label>
          <label>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Escaneo de ruta (min)</span>
            <input type="number" min={1} max={1440} value={form.hop_scan_interval_min ?? 10} onChange={campo("hop_scan_interval_min")} className="inp" />
          </label>
          <label>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Umbral degradado (ms)</span>
            <input type="number" min={10} max={10000} value={form.umbral_degradado_ms ?? 150} onChange={campo("umbral_degradado_ms")} className="inp" />
          </label>
          <label>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-mut">Fallos para DOWN</span>
            <input type="number" min={1} max={30} value={form.n_fallos_down ?? 3} onChange={campo("n_fallos_down")} className="inp" />
          </label>
        </div>

        <div className="space-y-2 border-t border-edge pt-4">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">Reglas de alerta</h3>
          {reglas.map((r, i) => (
            <div key={r.tipo} className={`grid grid-cols-[auto_1fr_1fr_1fr] items-center gap-2 ${r.activo ? "" : "opacity-50"}`}>
              <label className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] cursor-pointer ${r.activo ? "text-fg" : "text-mut"}`}>
                <input
                  type="checkbox"
                  checked={r.activo}
                  onChange={(e) => setReglas(reglas.map((x, j) => (j === i ? { ...x, activo: e.target.checked } : x)))}
                />
                {r.tipo === "perdida" ? "pérdida" : r.tipo}
              </label>
              {r.tipo === "ruta" ? (
                <>
                  <span className="text-center font-mono text-[10px] text-dim">diff de hops</span>
                </>
              ) : (
                <input
                  type="number"
                  min={1}
                  value={r.umbral}
                  onChange={(e) => setReglas(reglas.map((x, j) => (j === i ? { ...x, umbral: Number(e.target.value) } : x)))}
                  className="inp !py-1 text-xs"
                  title={r.tipo === "latencia" ? "umbral en ms" : "umbral en %"}
                />
              )}
              <input
                type="number"
                min={1}
                max={720}
                value={r.ventana_min}
                onChange={(e) => setReglas(reglas.map((x, j) => (j === i ? { ...x, ventana_min: Number(e.target.value) } : x)))}
                className="inp !py-1 text-xs"
                title={r.tipo === "ruta" ? "minutos de cooldown entre avisos" : "ventana en minutos"}
              />
              <span className="font-mono text-[10px] text-dim">{r.tipo === "ruta" ? "min cooldown" : r.tipo === "latencia" ? "min · ms" : "min · %"}</span>
            </div>
          ))}
        </div>

        {error && <p className="font-mono text-xs text-crit">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-edge pt-4">
          <button
            type="button"
            onClick={onCerrar}
            className="px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] text-mut transition-colors hover:text-fg"
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="border border-acc/50 bg-acc/10 px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.15em] text-acc transition-colors hover:bg-acc/20"
          >
            Guardar
          </button>
        </div>
      </form>
    </div>
  );
}
