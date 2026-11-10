import { useEffect, useRef, useState } from "react";

export function BotonCopiar({ texto, titulo }: { texto: string; titulo?: string }) {
  const [listo, setListo] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copiar = async (e: React.MouseEvent) => {
    // evita que el clic suba a contenedores interactivos (filas del listado, etc.)
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = texto;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setListo(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setListo(false), 1200);
  };

  return (
    <button
      onClick={copiar}
      title={titulo ?? `Copiar ${texto}`}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center border border-edge font-mono text-[9px] leading-none transition-colors hover:border-edgehi hover:text-fg ${
        listo ? "border-ok/50 text-ok" : "text-dim"
      }`}
    >
      <span className="ico">{listo ? "✓" : "⧉"}</span>
    </button>
  );
}
