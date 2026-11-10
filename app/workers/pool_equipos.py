"""Reutilización de sesiones y clientes por dispositivo (rendimiento).

Antes, cada conexión a un equipo pagaba el handshake completo por cada
comando u operación: SSH (~1-5 s de auth en dropbear viejo) por cada
`mca-status`/`wstalist`, y un cliente HTTP nuevo por cada grupo de peticiones
REST. Este módulo mantiene:

- `PoolSesion`: sesiones/clientes vivos por clave (ip±usuario) con bloqueo por
  dispositivo, reuso hasta un TTL de inactividad y un celador que cierra las
  expiradas. Ante una sesión muerta (el equipo reinició, red cortada) el
  worker la descarta y reconecta; nada queda en el pool.
- `memo_ttl`: caché de lecturas por (operación, ip) con TTL corto para que un
  refresco seguido del panel no reconecte. `vaciar_memo(ip)` invalida tras
  acciones destructivas o cambios de credencial."""

import asyncio
import time
from typing import Any, Awaitable, Callable


class PoolSesion:
    """Sesiones por clave con lock, TTL de inactividad y celador periódico.

    `guardar()` remplaza la sesión anterior cerrándola en otro task; `tirar`
    saca sin cerrar (el caller la cerrará tras usarla o tras un fallo)."""

    def __init__(self, cerrar: Callable[[Any], Awaitable[None]], ttl_inactiva: float = 30.0):
        self._cerrar = cerrar
        self._ttl = ttl_inactiva
        self._sesiones: dict[str, Any] = {}
        self._bloqueos: dict[str, asyncio.Lock] = {}
        self._ultimo: dict[str, float] = {}
        self._celador: asyncio.Task | None = None

    def bloqueo(self, clave: str) -> asyncio.Lock:
        blo = self._bloqueos.get(clave)
        if blo is None:
            blo = self._bloqueos.setdefault(clave, asyncio.Lock())
        return blo

    def obtener(self, clave: str) -> Any:
        return self._sesiones.get(clave)

    def guardar(self, clave: str, sesion: Any) -> None:
        vieja = self._sesiones.get(clave)
        if vieja is not None and vieja is not sesion:
            asyncio.get_running_loop().create_task(self._cerrar(vieja))
        self._sesiones[clave] = sesion
        self._ultimo[clave] = time.monotonic()
        self._asegurar_celador()

    def tocar(self, clave: str) -> None:
        self._ultimo[clave] = time.monotonic()

    def tirar(self, clave: str) -> Any:
        ses = self._sesiones.pop(clave, None)
        self._ultimo.pop(clave, None)
        return ses

    def claves(self) -> list[str]:
        return list(self._sesiones)

    async def tirar_y_cerrar(self, clave: str) -> None:
        ses = self.tirar(clave)
        if ses is not None:
            await self._cerrar(ses)

    def _asegurar_celador(self) -> None:
        if self._celador is None or self._celador.done():
            self._celador = asyncio.get_running_loop().create_task(self._celdar())

    async def _celdar(self) -> None:
        while True:
            await asyncio.sleep(max(5.0, self._ttl / 3))
            ahora = time.monotonic()
            for clave in [k for k, t in self._ultimo.items() if ahora - t >= self._ttl]:
                ses = self.tirar(clave)
                if ses is not None:
                    await self._cerrar(ses)


# --------------------------------------------------------------- memo de lecturas

_MEMO: dict[tuple[str, str], tuple[float, Any]] = {}
_MEMO_BLOQUEO = asyncio.Lock()


async def memo_ttl(
    op: str, ip: str, ttl: float, generar: Callable[[], Awaitable[Any]], forzar: bool = False
) -> Any:
    """Resultado memorizado de una lectura por (op, ip) durante `ttl` segundos.
    Solo cachea aciertos; un fallo se lanza y el siguiente intento recomputa.
    Forzado (acciones destructivas) recomputrá siempre."""
    if not forzar:
        hit = _MEMO.get((op, ip))
        if hit is not None and time.monotonic() - hit[0] < ttl:
            return hit[1]
    resultado = await generar()
    if ip is not None:
        _MEMO[(op, ip)] = (time.monotonic(), resultado)
    return resultado


def vaciar_memo(ip: str) -> None:
    """Invalida todas las lecturas memorizadas de esa ip."""
    for clave in [k for k in _MEMO if k[1] == ip]:
        _MEMO.pop(clave, None)
