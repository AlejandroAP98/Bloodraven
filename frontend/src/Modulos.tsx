import type { ReactNode } from "react";

export type Vista = "comparar" | "descubrir" | "catalogo" | "topologia";

/* ── Iconografía de módulo (trazo 1.5, estilo técnico) ── */

function IconoComparar() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden>
      <path d="M3 4v16h18" />
      <path d="M7 14c2.5-7 3.5-8 6-5 2 2.5 3.5 1 6.5-3.5" />
      <path d="M7 17.5c3-3 5-3.5 7.5-2 2 1.2 3.5 1 5.5-.5" strokeDasharray="2.5 2.5" />
    </svg>
  );
}

function IconoDescubrir() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="5.5" strokeDasharray="2 2.5" />
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 12l6-6" />
    </svg>
  );
}

function IconoCatalogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" />
      <rect x="13.5" y="3.5" width="7" height="7" />
      <rect x="3.5" y="13.5" width="7" height="7" />
      <rect x="13.5" y="13.5" width="7" height="7" />
    </svg>
  );
}

function IconoTopologia() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden>
      <rect x="9" y="3" width="6" height="5.5" />
      <rect x="3" y="15.5" width="6" height="5.5" />
      <rect x="15" y="15.5" width="6" height="5.5" />
      <path d="M12 8.5V12M12 12l-5.5 3.5M12 12l5.5 3.5" />
    </svg>
  );
}

/* ── Catálogo de módulos ── */

interface Modulo {
  id: Vista;
  etiqueta: string;
  descripcion: string;
  icono: ReactNode;
}

const MODULOS: Modulo[] = [
  { id: "comparar", etiqueta: "Comparar", descripcion: "ping en vivo de varias ips al tiempo · latencia de nodos", icono: <IconoComparar /> },
  { id: "descubrir", etiqueta: "Descubrir", descripcion: "barrido icmp + identificación por puertos", icono: <IconoDescubrir /> },
  { id: "catalogo", etiqueta: "Catálogo", descripcion: "inventario de equipos de la red", icono: <IconoCatalogo /> },
  { id: "topologia", etiqueta: "Topología", descripcion: "mapa de la red · rutas y selección", icono: <IconoTopologia /> },
];

export function Modulos({ onAbrir }: { onAbrir: (v: Vista) => void }) {
  return (
    <nav aria-label="Módulos del sistema" className="mb-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.28em] text-dim">módulos</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {MODULOS.map((m) => (
          <button
            key={m.id}
            onClick={() => onAbrir(m.id)}
            title={m.etiqueta}
            className="group tick flex items-center gap-3 border border-edge bg-panel px-3.5 py-3 text-left transition-colors hover:border-acc/60 hover:bg-panel2"
          >
            <span className="ico flex h-9 w-9 shrink-0 items-center justify-center border border-edge text-dim transition-colors group-hover:border-blood/60">
              {m.icono}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs font-semibold uppercase tracking-[0.18em] text-fg transition-colors group-hover:text-acc">
                {m.etiqueta}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10px] tracking-[0.04em] text-mut">{m.descripcion}</span>
            </span>
            <span aria-hidden className="shrink-0 font-mono text-xs text-dim transition-all group-hover:translate-x-0.5 group-hover:text-acc">
              ▸
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
