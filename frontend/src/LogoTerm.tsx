import type { ReactNode } from "react";

// marca de Bloodraven dibujada con caracteres: se muestra como marca de agua
// centrada en las consolas mientras están vacías (sin respuestas todavía)

export const LOGO = `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    @@@@@@@@@@@@@@%###@@@@@@@@@@@@@@@@
    @@@@@@@@@@@@#############@@@@@@@@@
    @@@@@@@@@@##########@@@@@@@@@@@@@@
    @@@@@@@@@##########@@@@@@@@@@@@@@@
    @@@@@@@@@##########@@@@@@@@@@@@@@@
    @@@@@@%############@@@@@@@@@@@@@@@
    @@@@@################@@@@@@@@@@@@@
    @@@@@#################@@@@@@@@@@@@
    @@@@@#################@@@@@@@@@@@@
    @@@@@@#################@@@@@@@@@@@
    @@@@@@#################@@@@@@@@@@@
    @@@@@@@################@@@@@@@@@@@
    @@@@@@@%#################@@@@@@@@@
    @@@@@@@@@@%@################@@@@@@
    @@@@@@@@@@@@%##################@@@
    @@@@@@@@@@@@@######%@@#####%@@@@@@
    @@@@@@@@@@@@######@@@@@@@@@@@@@@@@
    @@@@@@@@@@@#######@#@@@@@@@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@`;

// versión reducida para consolas bajas (secciones del comparador con poco alto)
export const LOGO_MINI = `@@@@@@@@@@@@@@@@@@@
  @@@@@@######@@@@@
  @@@@@#####@@@@@@@
  @@@@######@@@@@@@
  @@#########@@@@@@
  @@@########@@@@@@
  @@@#########@@@@@
  @@@@##########@@@
  @@@@@@#########@@
  @@@@@@###@@@@@@@@
  @@@@@@@@@@@@@@@@@`;

// banner de la página de inicio: cabecera de la consola de prueba rápida
export const BANNER = `████  █      ███   ███  ████  ████   ███  █   █ █████ █   █
█░░░█ █░    █ ░░█ █ ░░█ █░░░█ █░░░█ █ ░░█ █░  █░█░░░░░██  █░
████░░█░░   █░ ░█░█░ ░█░█░░░█░████░░█████░█░░ █░████░░█░█ █░░
█░░░█ █░░   █░░ █░█░░ █░█░░ █░█░░█░ █░░░█░░█░█ ░█░░░░ █░░██░░
████░░█████  ███ ░░███ ░████ ░█░░░█░█░░░█░░ █ ░ █████░█░░ █░░
 ░░░░ ░░░░░  ░░░ ░ ░░░ ░░░░░ ░░░  ░ ░░  ░░  ░ ░ ░░░░░ ░░  ░░
  ░░░░  ░░░░░  ░░░   ░░░  ░░░░  ░   ░ ░   ░   ░   ░░░░░ ░   ░`;

// mapas de color por carácter: cada símbolo del arte toma una clase de texto;
// el cuerpo (@) va transparente (solo aflora el dibujo interior) y el % acompaña
// al tono de los numerales
const MAPA_CUERVO: Record<string, string> = { "@": "text-transparent", "#": "text-mut", "%": "text-mut" };
const MAPA_CUERVO_SANGRE: Record<string, string> = { "@": "text-transparent", "#": "text-blood", "%": "text-blood" };
const MAPA_BANNER: Record<string, string> = { "█": "text-acc", "░": "text-edgehi" };
export const MAPAS = { cuervo: MAPA_CUERVO, sangre: MAPA_CUERVO_SANGRE, banner: MAPA_BANNER };

// pinta el arte a dos tonos: cada tramo de un mismo carácter toma su clase del
// mapa; va dentro de un <pre> para conservar el alineado
function Arte({ fuente, mapa }: { fuente: string; mapa: Record<string, string> }) {
  return (
    <>
      {fuente.split("\n").map((linea, i) => (
        <span key={i} className="block whitespace-pre">
          {(linea.match(/ +|(\S)\1*/g) ?? []).map((tramo, j) => {
            const clase = mapa[tramo[0]];
            return clase ? (
              <span key={j} className={clase}>{tramo}</span>
            ) : (
              <span key={j}>{tramo}</span>
            );
          })}
        </span>
      ))}
    </>
  );
}

// arte centrado con un texto opcional debajo (la pista de la consola);
// `tamano` es el alto de cada carácter en px: el arte completo mide 21
// líneas, el mini 11 y el banner 7, así se elige para que quepa
export function LogoTerm({
  arte = LOGO,
  tamano = 8,
  mapa = MAPAS.cuervo,
  children,
}: {
  arte?: string;
  tamano?: number;
  mapa?: Record<string, string>;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full w-full select-none flex-col items-center justify-center gap-3" aria-hidden="true">
      <pre className="font-mono" style={{ fontSize: tamano, lineHeight: `${tamano + 1}px` }}>
        <Arte fuente={arte} mapa={mapa} />
      </pre>
      {children}
    </div>
  );
}
