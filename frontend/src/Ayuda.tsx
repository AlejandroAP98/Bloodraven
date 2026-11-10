import type { ReactNode } from "react";

// tooltip de ayuda: aparece al mantener el cursor sobre el texto etiqueta
export function Ayuda({ texto, children }: { texto: string; children: ReactNode }) {
  return (
    <span className="group ayuda relative inline-flex cursor-help items-baseline">
      {children}
      <span aria-hidden className="ml-1 text-[9px] text-dim opacity-70 transition-opacity group-hover:opacity-100">
        ?
      </span>
      <span className="pointer-events-none invisible absolute left-0 top-full z-30 mt-1 w-52 border border-edgehi bg-panel p-2 font-mono text-[10px] normal-case leading-snug tracking-normal text-fg opacity-0 shadow-lg transition-opacity delay-400 duration-150 group-hover:visible group-hover:opacity-100">
        {texto}
      </span>
    </span>
  );
}
