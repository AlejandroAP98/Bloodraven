import { useEffect, useRef, useState } from "react";

import type { DispOut } from "./api";

type Linea = { t: number; texto: string; ok: boolean };

export function ConsolaPing({ dispositivo }: { dispositivo: DispOut }) {
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [pausa, setPausa] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let vivo = true;
    const ciclo = async () => {
      while (vivo) {
        if (!pausa) {
          try {
            const r = await fetch(`/api/devices/${dispositivo.id}/ping_ahora`);
            if (r.ok) {
              const d = await r.json();
              setLineas((prev) => [...prev.slice(-199), { t: Date.now(), texto: d.linea, ok: d.ok }]);
            }
          } catch {
            setLineas((prev) => [...prev.slice(-199), { t: Date.now(), texto: "Sin conexión con el servidor Bloodraven.", ok: false }]);
          }
        }
        await new Promise((res) => setTimeout(res, Math.max(dispositivo.intervalo_ping_s, 1) * 1000));
      }
    };
    ciclo();
    return () => {
      vivo = false;
    };
  }, [dispositivo.id, dispositivo.intervalo_ping_s, pausa]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lineas]);

  return (
    <section className="border border-edge bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          consola · ping en vivo <span className="text-edgehi">/</span> cada {dispositivo.intervalo_ping_s}s
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLineas([])}
            className="border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-mut transition-colors hover:border-edgehi hover:text-fg"
          >
            Limpiar
          </button>
          <button
            onClick={() => setPausa(!pausa)}
            className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${
              pausa ? "border-ok/50 bg-ok/10 text-ok hover:bg-ok/20" : "border-edgehi text-fg hover:bg-panel2"
            }`}
          >
            {pausa ? "Reanudar" : "Pausar"}
          </button>
        </div>
      </div>
      <div ref={box} className="term h-56 overflow-y-auto border border-edge bg-void p-3 text-acc">
        {lineas.length === 0 && <p className="text-dim">▍ esperando primeras respuestas…</p>}
        {lineas.map((l) => (
          <p key={l.t} className={l.ok ? "" : "text-crit"}>
            <span className="text-dim">{new Date(l.t).toLocaleTimeString()}</span>  {l.texto}
          </p>
        ))}
      </div>
    </section>
  );
}
