"""Acceso a equipos MikroTik (RouterOS) con doble transporte automático:

- REST v7: httpx contra /rest (sirve www-ssl o www) — certificados autofirma,
  verify=False; RouterOS v7.1+.
- API binaria (todas las versiones): librouteros, puerto 8728 (api) y 8729
  (api-ssl/TLS) — login plain (6.43+/v7) con reintento por token (pre 6.43,
  las antenas 6.42.x); TLS con certificado autofirma sin verificar.

Toda operación es de lectura salvo poe_cycle() y reboot(); el router de
acciones exige confirmar=true y silencia las alertas de los dispositivos
afectados antes de ejecutarlas. Las lecturas usan `leer_coleccion`/`comando_puntual`,
que eligen transporte solos; los nombres de campos de REST y API coinciden.
"""

import asyncio
import re as _re
import ssl
from typing import Any

import httpx
from librouteros import async_connect
from librouteros.exceptions import (
    ConnectionClosed,
    LibRouterosError,
    TrapError,
)
from librouteros.login import async_plain, async_token

from app.workers.pool_equipos import PoolSesion, memo_ttl, vaciar_memo

TIMEOUT_S = 6.0
_RE_NUM = _re.compile(r"(\d+)")
# TTLs de rendimiento: sesión binaria del pool, cliente REST del pool y
# memorización de lecturas (refresca el panel no reconecta a cada clic)
_TTL_SESION_API = 45.0
_TTL_CLIENTE_REST = 60.0
_TTL_LECTURA = 20.0


def _contexto_tls() -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # RouterOS: certificado autofirma
    return ctx


# contexto moderno: TLS 1.2/1.3 con cifrados "seguros" de política actual
_ssl_moderno = _contexto_tls()

# contexto legacy: sirve para api-ssl de RouterOS 6.x (era 6.42), que ofrece
# suites CBC/SHA1 (y hasta TLS 1.0) que la política moderna rechaza de raíz
_ssl_legacy = _contexto_tls()
try:
    _ssl_legacy.minimum_version = ssl.TLSVersion.TLSv1
except ValueError:  # build de OpenSSL sin TLS 1.0: quedarse en 1.2 con suites viejas
    _ssl_legacy.minimum_version = ssl.TLSVersion.TLSv1_2
try:
    _ssl_legacy.set_ciphers("ALL:@SECLEVEL=0")
except ssl.SSLError:
    _ssl_legacy.set_ciphers("ALL:@SECLEVEL=1")


class EquipoNoAccesible(Exception):
    """No se alcanzó la API del equipo (red apagada, servicios desactivados…)"""


class CredencialInvalida(Exception):
    """El equipo rechazó el usuario/contraseña (o el método de login)."""


class CaminoInexistente(Exception):
    """La ruta no existe en este RouterOS (menú ausente: wireless vs wifi v7,
    poe no disponible en la placa…)."""


# ------------------------------------------------------------------ sesión api

async def _cerrar(api: Any) -> None:
    """Cierra una sesión api de forma correcta: close() es coroutine en la
    AsyncApi de librouteros (llamarla sin await deja el socket abierto)."""
    try:
        r = api.close()
        if asyncio.iscoroutine(r):
            await r
    except Exception:
        pass


async def _cerrar_cliente(cliente: httpx.AsyncClient) -> None:
    try:
        await cliente.aclose()
    except Exception:
        pass


# pools por dispositivo: la ficha REST pide 4 menús (resource, identity,
# routerboard, health) y el panel lanza info+wireless+red seguidas; con el
# pool todo el tramo REST viaja sobre conexiones keep-alive del mismo cliente,
# y la API binaria se reutiliza en lugar de re-handshake por operación
_clientes_rest = PoolSesion(cerrar=_cerrar_cliente, ttl_inactiva=_TTL_CLIENTE_REST)
_api_pool = PoolSesion(cerrar=_cerrar, ttl_inactiva=_TTL_SESION_API)
# esquema REST que ya funcionó por ip: primera opción de ahora en adelante
# (evita reintentar la cadena https→http cuando ya se sabe cuál responde)
_memoria_rest: dict[str, str] = {}


async def _sonda_ok(api: Any) -> bool:
    """Sonda de autenticación: itera system/resource (lectura inofensiva, es la
    misma fila que ficha() ya pide). Devuelve True si la sesión autentica.
    El login plain contra 6.42.x 'pasa' sin trap pero sin autenticar: el
    comando sonda responde !trap 'not logged in'. A otros trap se los lanza."""
    try:
        [f async for f in api.path("system", "resource")]
        return True
    except TrapError as exc:
        if _re.search("not logged in", str(exc), _re.IGNORECASE):
            return False
        raise


# ------------------------------------------------------------------ normalización

def _entero(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(float(str(v)))
    except (TypeError, ValueError):
        return None


def _ficha_base(
    transporte: str,
    recurso: dict[str, Any],
    identity: Any,
    routerboard: dict[str, Any] | None = None,
    salud: dict[str, Any] | None = None,
) -> dict[str, Any]:
    libre = _entero(recurso.get("free-memory"))
    disco_libre = _entero(recurso.get("free-hdd-space"))
    return {
        "transporte": transporte,
        "identity": str(identity or "") or None,
        "version": str(recurso.get("version", "") or ""),
        "board": str(recurso.get("board-name", "") or "") or None,
        "cpu_load": _entero(recurso.get("cpu-load")),
        "uptime": str(recurso.get("uptime", "") or ""),
        "memoria_libre_mb": round(libre / 1048576) if libre else None,
        "disco_libre_mb": round(disco_libre / 1048576) if disco_libre else None,
        "serie": str((routerboard or {}).get("serial-number", "") or "") or None,
        "firmware_actual": str((routerboard or {}).get("current-firmware", "") or "") or None,
        "firmware_pendiente": str((routerboard or {}).get("upgrade-firmware", "") or "") or None,
        "voltaje": str((salud or {}).get("voltage", "") or "") or None,
        "temperatura": str(
            (salud or {}).get("temperature", "") or (salud or {}).get("cpu-temperature", "")
        ) or None,
        "mikrotik": True,
    }


def _poe_normalizado(fila: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(fila.get(".id", "") or ""),
        "nombre": str(fila.get("name", "") or ""),
        "poe_out": str(fila.get("poe-out", "") or "") or None,
        "prioridad": str(fila.get("poe-priority", "") or "") or None,
    }


def _validas(filas: Any) -> list[dict[str, Any]]:
    return [f for f in filas if isinstance(f, dict)] if isinstance(filas, list) else []


def _orden_puerto(p: dict[str, Any]) -> tuple[int, str]:
    m = _RE_NUM.search(str(p.get("nombre", "")))
    return (int(m.group(1)) if m else 999, str(p.get("nombre", "")))


# --------------------------------------------------------------------- REST v7

async def _cliente_rest(
    ip: str, usuario: str, password: str, esquema: str
) -> httpx.AsyncClient:
    """Cliente HTTP en el pool por (ip, esquema, usuario): keep-alive entre
    operaciones en lugar de TLS/TCP nuevo por grupo de peticiones."""
    llave = f"{ip}|{esquema}|{usuario}"
    cliente = _clientes_rest.obtener(llave)
    if cliente is not None and cliente.is_closed:
        await _clientes_rest.tirar_y_cerrar(llave)
        cliente = None
    if cliente is None:
        cliente = httpx.AsyncClient(
            base_url=f"{esquema}://{ip}",
            auth=(usuario, password),
            verify=False,
            timeout=TIMEOUT_S,
        )
        _clientes_rest.guardar(llave, cliente)
    else:
        _clientes_rest.tocar(llave)
    return cliente


async def _rest_intento(
    ip: str,
    usuario: str,
    password: str,
    esquema: str,
    acciones: list[tuple[str, str, dict[str, Any] | None]],
    si404: str = "error",  # "error": 404 → EquipoNoAccesible | "vacio": 404 → None
) -> list[Any]:
    """Peticiones GET/POST bajo /rest sobre el cliente enlazado del pool.
    acciones: [(metodo, ruta, cuerpo)] → lista de respuestas en orden."""
    llave = f"{ip}|{esquema}|{usuario}"
    respuestas: list[Any] = []
    try:
        cliente = await _cliente_rest(ip, usuario, password, esquema)
        for metodo, ruta, cuerpo in acciones:
            if metodo == "GET":
                r = await cliente.get(f"/rest/{ruta}")
            else:
                r = await cliente.post(f"/rest/{ruta}", json=cuerpo or {})
            if r.status_code in (401, 403):
                raise CredencialInvalida(f"{ruta}: rechazado por el equipo")
            if r.status_code == 404:
                if si404 == "vacio" and metodo == "GET":
                    respuestas.append(None)  # el menú no existe en este RouterOS
                    continue
                raise EquipoNoAccesible(f"{ruta}: no existe en este RouterOS")
            if r.status_code != 200:
                try:
                    detalle = str(r.json().get("message") or "")
                except Exception:
                    detalle = r.text[:120]
                raise EquipoNoAccesible(f"{ruta}: HTTP {r.status_code} {detalle}".strip())
            try:
                respuestas.append(r.json())
            except Exception:
                respuestas.append({})
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        # la conexión guardada quedó muerta (equipo reiniciado, red cortada):
        # fuera del pool para que el siguiente intento abra de cero
        await _clientes_rest.tirar_y_cerrar(llave)
        raise EquipoNoAccesible(f"{esquema}://{ip} no respondió ({exc.__class__.__name__})") from exc
    except (CredencialInvalida, EquipoNoAccesible):
        raise
    return respuestas


async def _via_rest(
    ip: str, usuario: str, password: str, acciones: list[tuple[str, str, dict[str, Any] | None]],
    si404: str = "error",
) -> tuple[str, list[Any]]:
    """Prueba REST por el esquema que ya funcionó con ese ip (memoria) y cae al
    otro; devuelve (esquema, respuestas) del primero que conteste. Lanza
    CredencialInvalida tal cual y EquipoNoAccesible si ningún servicio REST
    está disponible (v6)."""
    preferido = _memoria_rest.get(ip)
    orden = ([preferido] if preferido else []) + [s for s in ("https", "http") if s != preferido]
    ultimo: Exception | None = None
    for esquema in orden:
        try:
            respuestas = await _rest_intento(ip, usuario, password, esquema, acciones, si404=si404)
            _memoria_rest[ip] = esquema
            return esquema, respuestas
        except CredencialInvalida:
            raise
        except EquipoNoAccesible as exc:
            ultimo = exc
            continue
    raise EquipoNoAccesible(str(ultimo or "sin servicio rest en 80/443"))


# --------------------------------------------------------------- API binaria

async def _api_abrir(ip: str, usuario: str, password: str) -> Any:
    """Abre y VALIDA la API binaria: prueba 8728 (plain), 8729 (api-ssl/TLS
    moderno) y 8729 con contexto legacy (api-ssl viejos, era 6.42); cada
    variante con login plain (6.43+/v7) y, si el equipo lo rechaza, por token.

    Cada sesión que se abre se valida con la sonda (system/resource) antes de
    darse por buena: RouterOS 6.42.x acepta el saludo plain sin autenticar y
    sin trap, y solo el primer comando real destapa el falso login."""
    ultimo: Exception | None = None
    traps = 0
    sin_red = 0  # puerto inalcanzable (cerrado, timeout, conexión caída)
    sin_tls = 0  # puerto vivo pero el saludo TLS no negoció (cifrados)
    for puerto, contexto in ((8728, None), (8729, _ssl_moderno), (8729, _ssl_legacy)):
        for metodo_login in (async_plain, async_token):
            try:
                api = await async_connect(
                    host=ip,
                    username=usuario,
                    password=password,
                    timeout=int(TIMEOUT_S),
                    port=puerto,
                    ssl_wrapper=contexto,
                    login_method=metodo_login,
                )
            except ssl.SSLError as exc:
                # el TLS no negocia: variar el método login no lo arregla
                ultimo = exc
                sin_tls += 1
                break
            except (TimeoutError, ConnectionClosed) as exc:
                ultimo = exc
                sin_red += 1
                break  # este puerto no contesta: pasar al siguiente ajuste
            except OSError as exc:  # conexión rechazada / red caída
                ultimo = exc
                sin_red += 1
                break
            except TrapError as exc:
                ultimo = exc
                traps += 1
                continue
            except LibRouterosError as exc:
                ultimo = exc
                continue
            # conectado: comprobar que el login autenticó de verdad
            falso_login = False
            ok: bool = False
            try:
                ok = await _sonda_ok(api)
            except TrapError as exc:
                ultimo = exc
                traps += 1
            except (ConnectionClosed, LibRouterosError) as exc:
                ultimo = exc
            else:
                if ok:
                    return api  # sesión autenticada: salimos con ella abierta
                falso_login = True  # la sonda atrapó 'not logged in'
            if falso_login:
                ultimo = CredencialInvalida(
                    "el login pasó pero el equipo no autentica la sesión (login plain contra 6.42.x)"
                )
                traps += 1
            await _cerrar(api)
            continue
        if traps >= 2:
            # el puerto contesta y rechazó la sesión con ambos logins: el resto
            # de variantes dará lo mismo
            break
    if traps:
        raise CredencialInvalida(f"credenciales rechazadas por la api ({ultimo})")
    if sin_tls:
        raise EquipoNoAccesible(
            f"api-ssl de {ip} vive pero no negocia TLS ({ultimo}):"
            " habilita api (8728) o un certificado con cifrados modernos en el equipo"
        )
    raise EquipoNoAccesible(f"api no accesible de {ip} ({ultimo or 'sin 8728/8729'})")


async def _filas_api(api: Any, *ruta: str) -> dict[str, dict[str, Any]]:
    """Itera un camino de la API → {nombre: fila}. Menú inexistente → {}."""
    try:
        filas = [f async for f in api.path(*ruta)]
    except TrapError as exc:
        if _re.search(r"no such command|unknown", str(exc), _re.IGNORECASE):
            return {}
        raise EquipoNoAccesible(f"api {('/'.join(ruta))}: {exc}") from exc
    except LibRouterosError as exc:
        raise EquipoNoAccesible(f"api {('/'.join(ruta))}: {exc}") from exc
    return {str(f.get("name", "")): f for f in _validas(filas)}


async def _una_fila_api(api: Any, *ruta: str) -> dict[str, Any] | None:
    """Primera fila de un camino de un solo elemento (routerboard, health)."""
    try:
        filas = [f async for f in api.path(*ruta)]
    except TrapError as exc:
        if _re.search(r"no such command|unknown", str(exc), _re.IGNORECASE):
            return None
        raise EquipoNoAccesible(f"api {('/'.join(ruta))}: {exc}") from exc
    except LibRouterosError as exc:
        raise EquipoNoAccesible(f"api {('/'.join(ruta))}: {exc}") from exc
    return next(iter(_validas(filas)), None)


async def _comando_api(api: Any, ruta: tuple[str, ...], comando: str, **cuerpo: Any) -> None:
    try:
        [r async for r in api.path(*ruta)(comando, **cuerpo)]
    except LibRouterosError as exc:
        raise EquipoNoAccesible(f"api {('/'.join(ruta))}/{comando}: {exc}") from exc


# ------------------------------------------------------------------ sesiones api


async def _con_api_trabajo(
    ip: str, usuario: str, password: str, trabajo: Any
) -> Any:
    """Ejecuta `trabajo(api)` reutilizando la sesión binaria del pool. Si la
    sesión guardada ya no sirve (equipo reiniciado, concretó caída), se
    descarta y se reabre una vez reintentando la misma operación. En una
    sesión recién abierta el fallo se propaga sin doble intento,
    CaminoInexistente no toca la sesión (menú inexistente no muere el token)."""
    async with _api_pool.bloqueo(ip):
        api = _api_pool.obtener(ip)
        if api is not None:
            _api_pool.tocar(ip)
            try:
                return await trabajo(api)
            except CaminoInexistente:
                raise
            except Exception:
                await _api_pool.tirar_y_cerrar(ip)
        api = await _api_abrir(ip, usuario, password)
        _api_pool.guardar(ip, api)
        try:
            return await trabajo(api)
        except CaminoInexistente:
            raise
        except Exception:
            await _api_pool.tirar_y_cerrar(ip)
            raise


# ------------------------------------------------------------------ lecturas

async def _sirve_rest(ip: str, usuario: str, password: str, esquema: str) -> bool:
    """¿Este equipo expone /rest de verdad (v7)? En un www viejo (v6) el web
    server contesta 404 a cualquier /rest/... — ese 404 NO significa 'menú
    inexistente' sino 'no hay REST': en RouterOS 6 el web server vive en el
    mismo puerto que en v7 usa el REST."""
    try:
        r = await _rest_intento(
            ip, usuario, password, esquema, [("GET", "system/resource", None)], si404="vacio"
        )
    except (EquipoNoAccesible, CredencialInvalida):
        return False
    return bool(r) and isinstance(r[0], dict)


async def leer_coleccion(
    ip: str, usuario: str, password: str, ruta: str
) -> list[dict[str, Any]]:
    """Filas de una ruta-lista REST/API con el primer transporte que funcione
    (rest o API 8728/8729 reutilizada del pool). CaminoInexistente si el menú
    no existe."""
    partes = ruta.split("/")
    try:
        _esquema, out = await _via_rest(
            ip, usuario, password, [("GET", ruta, None)], si404="vacio"
        )
    except EquipoNoAccesible:
        pass  # sin REST (v6 o servicios web apagados): API binaria
    else:
        if out[0] is not None:
            return _validas(out[0])
        # Reposo 404: distinguir 'menú inexistente' (v7) de 'www viejo que
        # contesta 404 a todo /rest por no tenerlo' (v6) — en el segundo
        # la API binaria SÍ puede leer el menú
        if await _sirve_rest(ip, usuario, password, _esquema):
            raise CaminoInexistente(f"{ruta}: no existe en este RouterOS (REST 404)")
        # caer a la API binaria

    async def trabajo(api: Any) -> list[dict[str, Any]]:
        try:
            filas = [f async for f in api.path(*partes)]
        except TrapError as exc:
            if _re.search(r"no such command|unknown", str(exc), _re.IGNORECASE):
                # mensaje del trap incluido: permite distinguir menú ausente
                # de una variante con otro nombre (p.ej. wireless-fp)
                raise CaminoInexistente(f"{ruta}: {exc}") from exc
            raise EquipoNoAccesible(f"api {ruta}: {exc}") from exc
        except LibRouterosError as exc:
            raise EquipoNoAccesible(f"api {ruta}: {exc}") from exc
        return _validas(filas)

    return await _con_api_trabajo(ip, usuario, password, trabajo)


async def comando_puntual(
    ip: str, usuario: str, password: str, ruta: str, cuerpo: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Comando instantáneo ('monitor' con once, 'count'…) por REST o API.
    Devuelve las filas que reportó ({} vacío si el comando no existió)."""
    try:
        _esquema, out = await _via_rest(ip, usuario, password, [("POST", ruta, cuerpo)])
    except EquipoNoAccesible:
        pass
    else:
        return _validas(out[0])

    partes = ruta.split("/")

    async def trabajo(api: Any) -> list[dict[str, Any]]:
        try:
            filas = [f async for f in api.path(*partes[:-1])(partes[-1], **(cuerpo or {}))]
        except LibRouterosError as exc:
            raise EquipoNoAccesible(f"api {ruta}: {exc}") from exc
        return _validas(filas)

    return await _con_api_trabajo(ip, usuario, password, trabajo)


# ------------------------------------------------------------------ operaciones

async def _ficha_impl(ip: str, usuario: str, password: str) -> dict[str, Any]:
    """Identidad, versión, board, serie, firmware, salud (voltaje/temperatura)…
    REST (v7) primero; sin servicio REST (-v6.42) cae a la API binaria."""
    try:
        esquema, out = await _via_rest(
            ip,
            usuario,
            password,
            [("GET", "system/resource", None), ("GET", "system/identity", None)],
        )
        recurso = out[0] if isinstance(out[0], dict) else {}
        identity = out[1].get("name") if isinstance(out[1], dict) else None
        routerboard = None
        saludDb = None
        for ruta in ("system/routerboard", "system/health"):
            try:
                resultado = await _rest_intento(
                    ip, usuario, password, esquema, [("GET", ruta, None)], si404="vacio"
                )
                valor = resultado[0] if resultado and isinstance(resultado[0], dict) else None
            except (EquipoNoAccesible, CredencialInvalida):
                valor = None
            if ruta == "system/routerboard":
                routerboard = valor
            else:
                saludDb = valor
        return _ficha_base(f"REST {esquema}", recurso, identity, routerboard, saludDb)
    except EquipoNoAccesible:
        pass  # v6 sin REST

    async def trabajo(api: Any) -> dict[str, Any]:
        recursos = await _filas_api(api, "system", "resource")
        identidades = await _filas_api(api, "system", "identity")
        routerboard = await _una_fila_api(api, "system", "routerboard")
        salud = await _una_fila_api(api, "system", "health")
        return _ficha_base(
            "API 8728/8729",
            next(iter(recursos.values()), {}),
            next(iter(identidades.values()), {}).get("name"),
            routerboard,
            salud,
        )

    return await _con_api_trabajo(ip, usuario, password, trabajo)


async def ficha(
    ip: str, usuario: str, password: str, forzar: bool = False
) -> dict[str, Any]:
    """Lectura memorizada 20 s: un refresco seguido del panel no reconecta.
    forzar=True (⟳ actualizar) salta la memoria y consulta al equipo."""
    return await memo_ttl(
        "mikrotik.ficha", ip, _TTL_LECTURA, lambda: _ficha_impl(ip, usuario, password), forzar=forzar
    )


async def _poe_menu_impl(ip: str, usuario: str, password: str) -> tuple[list[dict[str, Any]], bool]:
    """(puertos con menú PoE, existe_el_menu) — lectura REST/API unificada."""
    try:
        filas = await leer_coleccion(ip, usuario, password, "interface/ethernet/poe")
    except CaminoInexistente:
        return [], False
    poe = [_poe_normalizado(x) for x in filas]
    return sorted(poe, key=_orden_puerto), True


async def poe_menu(
    ip: str, usuario: str, password: str, forzar: bool = False
) -> tuple[list[dict[str, Any]], bool]:
    """Lectura memorizada 20 s (el par (id, nombre) viene del mismo snapshot,
    así que validar el ciclo contra una lectura de hace segundos es coherente).
    forzar=True salta la memoria."""
    return await memo_ttl(
        "mikrotik.poe_menu", ip, _TTL_LECTURA, lambda: _poe_menu_impl(ip, usuario, password), forzar=forzar
    )


async def poe_cycle(
    ip: str, usuario: str, password: str, id_puerto: str, duracion: int = 5
) -> dict[str, Any]:
    """Apaga y enciende el PoE de un puerto (power-cycle con duración fija).
    Corta el dispositivo conectado a ese puerto el tiempo de su reinicio: SOLO
    se invoca vía router a acciones con confirmar=true y silencio previo."""
    try:
        esquema, _out = await _via_rest(
            ip,
            usuario,
            password,
            [
                (
                    "POST",
                    "interface/ethernet/poe/power-cycle",
                    {".id": id_puerto, "duration": str(duracion)},
                )
            ],
        )
        return {
            "ok": True,
            "transporte": f"REST {esquema}",
            "detalle": f"power-cycle programado ({duracion} s)",
        }
    except EquipoNoAccesible:
        pass
    api = await _api_abrir(ip, usuario, password)
    try:
        await _comando_api(
            api,
            ("interface", "ethernet", "poe"),
            "power-cycle",
            **{".id": id_puerto, "duration": str(duracion)},
        )
        return {"ok": True, "transporte": "API 8728/8729", "detalle": f"power-cycle programado ({duracion} s)"}
    finally:
        await _cerrar(api)


async def limpiar(ip: str) -> None:
    """Suelta sesiones API, clientes REST y lecturas memorizadas de esa ip:
    credencial cambiada o reinicio del equipo terminado de programar."""
    try:
        await _api_pool.tirar_y_cerrar(ip)
        for llave in _clientes_rest.claves():
            if llave.startswith(f"{ip}|"):
                await _clientes_rest.tirar_y_cerrar(llave)
        _memoria_rest.pop(ip, None)
        vaciar_memo(ip)
    except Exception:
        pass


async def reboot(ip: str, usuario: str, password: str) -> dict[str, Any]:
    """Reinicia el equipo completo (2-4 min de arranque RouterOS). Al final
    suelta sesiones y cache: la instancia muere con el equipo."""
    try:
        esquema, _out = await _via_rest(ip, usuario, password, [("POST", "system/reboot", None)])
        resultado = {"ok": True, "transporte": f"REST {esquema}", "detalle": "reinicio enviado"}
    except EquipoNoAccesible:
        api = await _api_abrir(ip, usuario, password)
        try:
            await _comando_api(api, ("system",), "reboot")
            resultado = {"ok": True, "transporte": "API 8728/8729", "detalle": "reinicio enviado"}
        finally:
            await _cerrar(api)
    await limpiar(ip)
    return resultado
