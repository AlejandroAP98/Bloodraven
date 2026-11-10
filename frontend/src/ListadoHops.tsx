import type { Hop } from "./api";
import { BotonCopiar } from "./BotonCopiar";

type EquipoMini = { nombre: string; rol: string };

export function ListadoHops({
  hops,
  equipos,
}: {
  hops: Hop[];
  equipos?: Map<string, EquipoMini>;
}) {
  if (!hops || !hops.length) return null;
  let antIp: string | null = null;
  const repetido: (number | null)[] = hops.map((h) => {
    const es = h.ip != null && h.ip === antIp;
    antIp = h.ip ?? antIp;
    return es ? 1 : null;
  });
  return (
    <table className="min-w-full text-sm">
      <thead>
        <tr className="text-left font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
          <th className="pb-2 pr-4 font-medium">#</th>
          <th className="pb-2 pr-4 font-medium">IP</th>
          <th className="pb-2 pr-4 font-medium">Host</th>
          <th className="pb-2 font-medium">RTT</th>
        </tr>
      </thead>
      <tbody className="border-t border-edge/60 font-mono text-xs">
        {hops.map((h, i) => (
          <tr
            key={h.ttl}
            className={`${i % 2 ? "bg-panel2/40" : ""} border-b border-edge/40 ${h.ok ? "" : "bg-crit/10 text-crit"}`}
          >
            <td className="py-1.5 pr-4 text-dim">{h.ttl}</td>
            <td className="py-1.5 pr-4 text-fg">
              {h.ip ?? "timeout"}
              {h.ip && (
                <span className="ml-1.5 inline-flex align-middle">
                  <BotonCopiar texto={h.ip} />
                </span>
              )}
              {repetido[i] != null && (
                <span
                  className="ml-2 border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-warn"
                  title="El mismo router respondió el salto anterior (interfaces múltiples / MPLS)"
                >
                  repite
                </span>
              )}
              {h.ip && equipos?.get(h.ip) && (
                <span
                  className="ml-2 border border-ok/30 bg-ok/5 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-ok/80"
                  title={`catálogo: ${equipos.get(h.ip)!.rol}`}
                >
                  {equipos.get(h.ip)!.nombre}
                </span>
              )}
            </td>
            <td className="py-1.5 pr-4 text-mut">{h.hostname ?? ""}</td>
            <td className="py-1.5">
              {h.rtt_ms != null ? `${h.rtt_ms.toFixed(1)} ms` : <span className="text-dim">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
