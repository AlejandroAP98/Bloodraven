"""Acceso a equipos Ubiquiti airMAX (aireOS: Rocket, Bullet, NanoBeam,
Prism/AC…) por SSH:
- Telemetría con los comandos de status del firmware: `mca-status.sh` (XM/XW,
  aireOS 5.6-6.x), `mca-status` (AC/Prism, aireOS 7/8 XC) o `mca-dump` (JSON,
  respaldo): uptime, cpu, memoria, señal, CCQ, SSID/modo y número de
  estaciones en pares clave=valor.
- Config de radio: `cat /tmp/system.cfg` (radio.1.mode/freq/txpower) para
  completar la ficha (modo de radio, frecuencia, potencia).
- Estaciones conectadas (`wstalist` por SSH): el equivalente de la
  registration-table de RouterOS — nombre, MAC, IP, señal, CCQ (escala
  cruda 0-255 → %), rates tx/rx, distancia y uptime por CPE.
- `reboot`: la consola de aireOS pide confirmación por teclado; se alimenta
  'y' por stdin desde el propio comando.

Toda operación es de lectura salvo reboot() (el router de acciones exige
confirmar=true y silencia las alertas de los dispositivos afectados antes).
Las excepciones son las mismas de app.workers.mikrotik, que el router de
acciones normaliza a errores HTTP con una sola familia.
"""

import asyncio
import contextlib
import json
import logging
import re
from typing import Any

import asyncssh

from app.workers.mikrotik import CredencialInvalida, EquipoNoAccesible
from app.workers.pool_equipos import PoolSesion, memo_ttl, vaciar_memo

log = logging.getLogger("app.workers.ubiquiti")

TIMEOUT_S = 6.0
_PUERTO_SSH = 22
# TTL de la sesión SSH ociosa y de las lecturas memorizadas: refrescos seguidos
# del panel no reconectan ni duplican lecturas del mismo segundo
_TTL_SESION = 30.0
_TTL_LECTURA = 20.0

# aireOS lleva dropbear/OpenSSH viejos: ofrece KEX SHA1, cifrados CBC y
# host keys ssh-rsa/ssh-dss que la política moderna no negocia. Con el
# prefijo '+' se AGREGAN al listado sin quitar los nuevos, así que el mismo
# perfil sirve a firmware viejo y reciente. Si esta versión de asyncssh
# rechaza alguno, se reintenta con el perfil por defecto.
_LEGADO = {
    "kex_algs": "+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1,diffie-hellman-group-exchange-sha1",
    "encryption_algs": "+aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc",
    "mac_algs": "+hmac-sha1,hmac-sha1-96",
    "signature_algs": "+ssh-rsa,ssh-dss",
}


async def _abrir(ip: str, usuario: str, password: str) -> asyncssh.SSHClientConnection:
    """Abre una sesión SSH validada (host key sin verificar: los radios usan
    claves autofirma/rotan a cada flasheo). Autenticación solo por password."""
    ultimo: Exception | None = None
    for opciones in (_LEGADO, {}):
        try:
            return await asyncssh.connect(
                ip,
                port=_PUERTO_SSH,
                username=usuario,
                password=password,
                known_hosts=None,  # sin verificación de host key
                client_keys=[],  # autenticación exclusivamente por password
                connect_timeout=TIMEOUT_S,
                login_timeout=TIMEOUT_S,
                **opciones,
            )
        except asyncssh.PermissionDenied as exc:
            raise CredencialInvalida(f"ssh de {ip} rechazó las credenciales ({exc})") from exc
        except ValueError as exc:
            # patrón de algoritmo inválido para esta versión: probar sin ajustes
            ultimo = exc
        except (asyncssh.Error, OSError, asyncio.TimeoutError, TimeoutError) as exc:
            # negociación fallida (firmware viejo) o puerto cerrado/red caída
            ultimo = exc
    raise EquipoNoAccesible(
        f"ssh de {ip} no negoció ({ultimo.__class__.__name__}: {ultimo}):"
        f" ¿SSH habilitado en el equipo (System > Services), puerto {_PUERTO_SSH}?"
    )


async def _cerrar(conn: asyncssh.SSHClientConnection) -> None:
    with contextlib.suppress(Exception):
        conn.close()
    with contextlib.suppress(Exception):
        await conn.wait_closed()


# pool de sesiones por dispositivo: la ficha pide varios comandos (mca-status,
# system.cfg, mca-dump, wstalist) y el panel lanza info+wireless seguidos; con
# el pool todo viaja por una sola sesión SSH (un solo handshake de auth)
_ssh_pool = PoolSesion(cerrar=_cerrar, ttl_inactiva=_TTL_SESION)


def _vivo(conn: asyncssh.SSHClientConnection) -> bool:
    """¿La sesión sigue activa? (asyncssh la marca como inactiva al caer)."""
    activo = getattr(conn, "is_active", None)
    if activo is None:
        return True
    try:
        return bool(activo())
    except Exception:
        return False


async def _ejecutar(ip: str, usuario: str, password: str, comando: str) -> str:
    """Ejecuta un comando reutilizando la sesión SSH del dispositivo.
    Sesión muerta (reboot del radio, red cortada) → se descarta y se reconecta
    una sola vez para el mismo comando."""
    async with _ssh_pool.bloqueo(ip):
        conn = _ssh_pool.obtener(ip)
        if conn is not None and not _vivo(conn):
            await _ssh_pool.tirar_y_cerrar(ip)
            conn = None
        if conn is None:
            conn = await _abrir(ip, usuario, password)
            _ssh_pool.guardar(ip, conn)
        else:
            _ssh_pool.tocar(ip)
        try:
            resultado = await asyncio.wait_for(
                conn.run(comando, check=False),
                timeout=TIMEOUT_S + 5,
            )
        except (asyncssh.Error, OSError, asyncio.TimeoutError, TimeoutError):
            # la sesión se cayó en medio de la operación: reconección fresca
            await _ssh_pool.tirar_y_cerrar(ip)
            conn = await _abrir(ip, usuario, password)
            _ssh_pool.guardar(ip, conn)
            resultado = await asyncio.wait_for(
                conn.run(comando, check=False),
                timeout=TIMEOUT_S + 5,
            )
        _ssh_pool.tocar(ip)
        return (resultado.stdout or "") + (resultado.stderr or "")


# ------------------------------------------------------------------- parsing

# par clave=valor: la clave va antes del '='; el valor corre hasta el fin de
# línea, una coma (los comandos mca* acomodan varios pares por línea) o el
# siguiente '='
_RE_PAR = re.compile(r"([\w.\-]+)=([^=\n,]*)")
_RE_NUM = re.compile(r"^-?\d+(?:\.\d+)?")


def _entero(v: Any) -> int | None:
    if v is None:
        return None
    m = _RE_NUM.search(str(v))
    try:
        return int(float(m.group(0))) if m else None
    except (TypeError, ValueError):
        return None


def _pares(texto: str) -> dict[str, str]:
    """`a.b=valor` de los comandos mca* → {clave: valor}.
    Acepta el formato del firmware viejo (un par por línea) y el de airOS 7/8
    (varios pares por línea separados por coma) y JSON (mca-dump, aplanado)."""
    texto = texto.strip()
    if texto.startswith("{"):
        # mca-dump entrega un blob JSON: se aplana a claves puntos
        try:
            dato = json.loads(texto)
            out: dict[str, str] = {}
            _aplanar(dato, "", out)
            if out:
                return out
        except ValueError:
            pass  # cae al parseo de líneas
    out = {}
    for linea in texto.splitlines():
        linea = linea.strip()
        if not linea:
            continue
        for m in _RE_PAR.finditer(linea):
            k, v = m.group(1), m.group(2).strip()
            if v not in ("", None):
                out[k] = v
    return out


def _aplanar(dato: Any, prefijo: str, out: dict[str, str]) -> None:
    if isinstance(dato, dict):
        for k, v in dato.items():
            _aplanar(v, f"{prefijo}{k}.", out)
    elif isinstance(dato, list):
        for i, v in enumerate(dato):
            _aplanar(v, f"{prefijo}{i}.", out)
    elif dato is not None and not isinstance(dato, (dict, list)):
        out[prefijo.rstrip(".")] = str(dato)


def _elegir(datos: dict[str, str], *claves: str) -> str | None:
    """Primera clave presente y con valor no vacío (tolera variantes de firmware)."""
    for k in claves:
        v = datos.get(k, "")
        if v not in ("", None):
            return v
    return None


def _coincidencia(datos: dict[str, str], patron: str) -> str | None:
    """Primer valor cuyo nombre de clave casa el patron (con claves anidadas de
    mca-status el nombre va junto al dato: 'ap.station.0.signal=…')."""
    for k in datos:
        if re.search(patron, k, re.IGNORECASE):
            v = datos[k]
            if v not in ("", None):
                return v
    return None


def _format_uptime(segundos: int | None, crudo: str | None = None) -> str | None:
    """mca-status da uptime en segundos ('2728424'); algunos firmware el
    formato busybox ('24 days, 3:12'). Normaliza a '29 d 9 h 3 m'."""
    if segundos is None and crudo:
        m = re.search(r"(\d+)\s*days?,?\s*(\d+):(\d+)", crudo)
        if m:
            segundos = int(m.group(1)) * 86400 + int(m.group(2)) * 3600 + int(m.group(3)) * 60
    if segundos is None:
        return None
    d, resto = divmod(segundos, 86400)
    h, resto = divmod(resto, 3600)
    mnt = resto // 60
    if d:
        return f"{d} d {h} h {mnt} m"
    if h:
        return f"{h} h {mnt} m"
    return f"{mnt} m"


def _ancho_desde(datos: dict[str, str]) -> int | None:
    """Ancho de canal (5-160 MHz) en el dataset del radio: una clave tipo
    chanbw/chwidth/channelwidth a cualquier nivel (mca-dump lo trae en
    wireless.status.chanbw; other firmares en radio.1.chbw)."""
    for k, v in (datos or {}).items():
        if re.search(r"chanbw$|chwidth$|channel(?:band)?width$|chbw$", k, re.IGNORECASE):
            n = _entero(v)
            if n and 5 <= n <= 160:
                return n
    return None


def _ip_lan(datos: dict[str, str]) -> str | None:
    """Primera ip de interfaz del radio (mca-dump delivers interfaces.*)
    que no sea loopback ni 0.0.0.0."""
    for k, v in (datos or {}).items():
        if re.search(r"(?:^|\.)ipaddr(?:\.\d+)?$", k, re.IGNORECASE):
            vv = str(v or "").strip()
            if vv and not vv.startswith(("127.", "0.0.0.0", "::1")):
                return vv
    return None


def _radios_cfg(cfg: dict[str, str]) -> dict[str, Any]:
    """radio.1.* de /tmp/system.cfg → modo de radio, frecuencia y potencia."""
    modo_raw = _elegir(cfg, "radio.1.mode") or _coincidencia(cfg, r"radio\.1\.mode$")
    modo = None
    if modo_raw:
        bajo = str(modo_raw).lower()
        if "master" in bajo:
            modo = "ap"  # master sirve un pool ptMp/ptp; al panel se le llama 'ap'
        elif "sta" in bajo:
            modo = "sta"
        else:
            modo = bajo
    freq = _entero(_elegir(cfg, "radio.1.freq"))
    # ancho de canal: la clave cambia según familia ('chwidth' en XM/XW,
    # 'chanbw'/'chbw' en XC); si ninguna está, queda None y el panel lo omite
    ancho = (
        _entero(_elegir(cfg, "radio.1.chwidth", "radio.1.chanbw", "radio.1.chbw"))
        or _entero(_coincidencia(cfg, r"radio\.\d+\.(?:ch(?:an)?bw|chwidth)$"))
    )
    # pista de calibración si no está: repertorio radio.1.* del cfg real
    if not ancho:
        pistas = [k for k in cfg if re.match(r"radio\.1\.", k)][:20]
        log.info("ancho de canal no hallado en system.cfg; radio.1.*: %s", pistas)
    txpower = _entero(_elegir(cfg, "radio.1.txpower"))
    return {
        "radio_modo": modo,
        "frecuencia_mhz": freq,
        "canal_mhz": ancho,
        "txpower_dbm": txpower,
    }


def _ficha_base(datos: dict[str, str], cfg: dict[str, str] | None = None) -> dict[str, Any]:
    hostname = (
        _elegir(datos, "hostname", "deviceName", "stationName")
        or _coincidencia(datos, r"hostname$|devicename$|stationname$")
    )
    version = (
        _elegir(datos, "version", "firmwareVersion")
        or _coincidencia(datos, r"fwversion$|firmwareversion$|version$")
    )
    board = (
        _elegir(datos, "board.name", "board.shortname")
        or _coincidencia(datos, r"boardname$|board\.name$|board\.shortname$|(?:^|\.)platform$|(?:^|\.)board$")
    )
    uptime_crudo = _elegir(datos, "uptime") or _coincidencia(datos, r"sysuptime$") or _coincidencia(datos, r"(?:^|\.)uptime$")
    memoria = _entero(_elegir(datos, "memTotalFree", "memFree")) or _entero(_coincidencia(datos, r"mem\w*free$"))
    cpu = (
        _entero(_elegir(datos, "cpuLoad"))
        or _entero(_coincidencia(datos, r"cpuload$")
        or _coincidencia(datos, r"loadavg$"))
    )
    senal = (
        _elegir(datos, "signal", "signalAvg")
        or _coincidencia(datos, r"(?:^|\.)signal(?:Avg)?$")
    )
    ccq = _elegir(datos, "ccq") or _coincidencia(datos, r"(?:^|\.)ccq$")
    essid = _elegir(datos, "essid", "ssid") or _coincidencia(datos, r"(?:^|\.)essid$|(?:^|\.)ssid$")
    modo = (
        _elegir(datos, "netRole", "wifiMode", "wirelessMode", "mode")
        or _coincidencia(datos, r"netrole$|netmode$|wlanmode$|wirelessmode$|(?:^|\.)mode$")
    )
    estaciones = (
        _elegir(datos, "stationCount", "clients")
        or _coincidencia(datos, r"stationcount$|stacount$|clientcount$|stationsn$")
    )
    ruido = _elegir(datos, "noise") or _coincidencia(datos, r"(?:^|\.)noise$")
    radios = _radios_cfg(cfg or {})
    if not radios.get("canal_mhz"):
        # respaldo: el ancho puede vivir en el json mca-dump en vez del cfg
        radios["canal_mhz"] = _ancho_desde(datos)
    return {
        "transporte": f"SSH {_PUERTO_SSH}",
        "identity": hostname,
        "version": version,
        "board": board,
        "cpu_load": cpu,
        "uptime": _format_uptime(_entero(uptime_crudo), uptime_crudo),
        "memoria_libre_mb": round(memoria / 1024) if memoria else None,
        "serie": None,
        "firmware_actual": version or None,
        "firmware_pendiente": None,
        "voltaje": None,
        "temperatura": None,
        # telemetría del radio: lo que el firmware no reporte queda None y el
        # panel lo muestra como '—'
        "senal": senal,
        "ccq": ccq,
        "stations_n": _entero(estaciones),
        "essid": essid,
        "modo": modo,  # rol de red del equipo (bridge/router), NO el modo radio
        "ruido": ruido,
        "lan_ip": _ip_lan(datos),  # mca-dump: interfaces.* → ip no-loopback
        **radios,  # radio_modo, frecuencia_mhz, canal_mhz, txpower_dbm
        "ubiquiti": True,
        "mikrotik": False,
    }


# ------------------------------------------------------------------ lecturas

# el firmware manda: xm/xw (aireOS 6-) es mca-status.sh; ac (aireOS 7/8/XC) es
# mca-status sin extensión; mca-dump (JSON) es el respaldo si los dos fallan
_COMANDOS_STATUS = ("mca-status.sh", "mca-status", "mca-dump")


def _ccq_de_raw(v: Any) -> str | None:
    """CCQ del wstalist viene en escala cruda 0-255 ('223'): a porcentaje.
    Si el valor ya viene en porcentaje quedará (>255): no se escala."""
    if v in (None, ""):
        return None
    try:
        num = float(str(v).replace("%", "").strip())
    except ValueError:
        return None
    pct = 100.0 * num / 255.0 if 0 < num <= 255 else num
    return f"{pct:.0f}%"


def _estaciones_de_texto(texto: str) -> list[dict[str, Any]]:
    """Objetos de estación (CPEs) del JSON de wstalist, cualquiera sea la
    versión del firmware: recorre el blob buscando dicts con 'mac' y algún
    campo de radio (signal/ccq/name/lastip). ValueError si no es JSON."""
    dato = json.loads(texto)
    filas: list[dict[str, Any]] = []

    def recorrer(x: Any) -> None:
        if isinstance(x, list):
            for v in x:
                recorrer(v)
        elif isinstance(x, dict):
            if "mac" in x and any(
                k in x for k in ("signal", "ccq", "name", "lastip", "txrate", "rxrate",
                                 "devmodel", "distance", "uptime", "connectionTime")
            ):
                filas.append(x)
            else:
                for v in x.values():
                    recorrer(v)

    recorrer(dato)
    return filas


def _tasa(v: Any) -> str | None:
    """txrate/rxrate del wstalist viene en kbps ('130000'): a Mbps legibles."""
    n = _entero(v)
    if not n:
        return None
    if n >= 1_000_000:
        return f"{n / 1_000_000:g} Gbps"
    if n >= 1000:
        return f"{round(n / 1000, 1):g} Mbps"
    return f"{n:g} kbps"


def _flotante(v: Any) -> float | None:
    m = _RE_NUM.search(str(v)) if v not in (None, "") else None
    return float(m.group(0)) if m else None


def _tasa_flex(v: Any) -> str | None:
    """Velocidad ya en Mbps con decimal ('19.5', '13.0'): a un formato
    legible; si viniera en kbps grande (>2000) se reduce."""
    n = _flotante(v)
    if n is None or n <= 0:
        return None
    if n >= 2000:
        return f"{round(n / 1000, 1):g} Mbps"
    return f"{n:g} Mbps"


def _tasa_bps(v: Any) -> str | None:
    """Velocidad entregada en bps (throughput/capacidades WBA): formateado
    con escala ('3870' → '3.87 kbps', '27000000' → '27 Mbps')."""
    n = _entero(v)
    if not n:
        return None
    if n >= 1_000_000:
        return f"{n / 1_000_000:g} Mbps"
    if n >= 1000:
        return f"{n / 1000:g} kbps"
    return f"{n:g} bps"


def _pct(v: Any) -> str | None:
    """Porcentaje tolerante a escala: '46.5' → '46.5%'; si viene en décimas de
    % ('465') se reduce; una vez en % no se reescala."""
    if v in (None, ""):
        return None
    try:
        num = float(str(v).replace("%", "").strip())
    except ValueError:
        return None
    if 100 < num <= 1000:
        num = num / 10.0
    return f"{num:g}%"


def _fila_estacion(f: dict[str, Any]) -> dict[str, Any]:
    """Estación cruda de wstalist → fila normalizada del panel.
    Calibrado contra XC.v8.7.11 real: 'name' plano es el SSID del pool (NO
    el nombre del CPE); la identidad vive en remote.hostname (device name)
    y remote.platform (device model). El resto va por búsqueda difusa
    (claves planas o anidadas en 'stats') para tolerar otros firmwares."""
    plano: dict[str, str] = {}
    _aplanar(f, "", plano)
    remoto = any(k.startswith("remote.") for k in plano)

    def busca(claves: tuple[str, ...], patron: str | None = None) -> str | None:
        return _elegir(plano, *claves) or (_coincidencia(plano, patron) if patron else None)

    uptime_crudo = busca(("uptime", "connectionTime", "connectedTime"), r"uptime$|connection_?time$|connected_?time$")
    dist_n = _entero(busca(("distance", "dist"), r"(?:^|\.)distance$|(?:^|\.)dist$"))

    # identidad calibrada: con remote.* presente el 'name' plano es el ssid
    nombre = busca(("remote.hostname",), r"^remote\.hostname$")
    if not nombre and not remoto:
        nombre = busca(("name", "hostname"), r"(?:^|\.)name$|(?:^|\.)hostname$")
    devmodel = busca(("remote.platform", "devmodel", "model", "deviceModel"), r"^remote\.platform$|dev_?model$|devicemodel$|(?:^|\.)model$")
    ip = busca(("lastip", "ip", "lastIp"), r"lastip$|(?:^|\.)ip$")
    if ip == "0.0.0.0":  # la UI lo muestra como 'unknown'
        ip = None

    # link potencial: el dato directo manda; si no, se deriva de la capacidad
    # negociada (airmax.cb_capacity) sobre la esperada (cb_capacity_expect)
    potencial = _pct(busca(("link_potential", "linkPotential"), r"link_?potential$|(?:^|\.)potential$"))
    if not potencial:
        cb = _entero(plano.get("airmax.cb_capacity") or _coincidencia(plano, r"cb_?capacity$|(?:^|\.)dl_?capacity$"))
        esp = _entero(plano.get("cb_capacity_expect") or _coincidencia(plano, r"capacity_?expect$"))
        if cb and esp:
            potencial = f"{round(100 * cb / esp, 1)}%"

    # airtime: directo ('airtime_tx' = %) o usage del airmax (décimas de %)
    def airtime(dirn: str) -> str | None:
        pct = _pct(busca((f"airtime_{dirn}",), rf"airtime\.?{dirn}$|airtime_?{dirn}$|{dirn}_?airtime$"))
        if pct:
            return pct
        uso = _entero(plano.get(f"airmax.{dirn}.usage") or _coincidencia(plano, rf"airmax\.{dirn}\.usage$"))
        return f"{uso / 10:.1f}%" if uso else None

    return {
        "nombre": nombre,
        "devmodel": devmodel,
        "mac": busca(("mac", "addr"), r"(?:^|\.)mac$|(?:^|\.)addr$"),
        "ip": ip,
        "senal": busca(("signal",), r"(?:^|\.)signal(?:Avg)?$"),
        "senal_remota": busca(("remote.signal",), r"^remote\.signal$|rem(?:ote)?_?sig(?:nal)?$"),
        "ccq": _ccq_de_raw(busca(("ccq",), r"(?:^|\.)ccq$")),
        "potencial": potencial,
        "downlink": _tasa(busca(("airmax.dl_capacity", "downlink_capacity", "capacity_downlink"), r"dl_?capacity$|downlink_?capacity$|capacity_?downlink$")),
        "uplink": _tasa(busca(("airmax.ul_capacity", "uplink_capacity", "capacity_uplink"), r"ul_?capacity$|uplink_?capacity$|capacity_?uplink$")),
        "airtime_tx": airtime("tx"),
        "airtime_rx": airtime("rx"),
        "put_rx": _tasa_bps(busca(("remote.rx_throughput", "throughput_rx"), r"remote\.rx_?throughput$|throughput_?rx$|(?:^|\.)rx_?throughput$")),
        "put_tx": _tasa_bps(busca(("remote.tx_throughput", "throughput_tx"), r"remote\.tx_?throughput$|throughput_?tx$|(?:^|\.)tx_?throughput$")),
        "tx": _tasa(busca(("txrate", "tx_bitrate"), r"tx_?rate$|tx_?bitrate$")) or _tasa_flex(busca(("tx",), r"(?:^|\.)tx$")),
        "rx": _tasa(busca(("rxrate", "rx_bitrate"), r"rx_?rate$|rx_?bitrate$")) or _tasa_flex(busca(("rx",), r"(?:^|\.)rx$")),
        "distancia": (
            f"{dist_n / 1000:g} km" if dist_n is not None and dist_n >= 1000
            else (f"{dist_n:g} m" if dist_n else None)
        ),
        "uptime": _format_uptime(_entero(uptime_crudo), uptime_crudo),
    }


async def _ficha_impl(ip: str, usuario: str, password: str) -> dict[str, Any]:
    """Ficha del radio airMAX: hostname, versión, board, señal, CCQ, estaciones,
    modo de radio, frecuencia y potencia. Compondla de tres fuentes por SSH:
    mca-status(.sh|mca-dump) para telemetría viva, /tmp/system.cfg para la
    config de radio y wstalist para estaciones/CCQ (en modo AP el CCQ global
    no existe: vive por estación)."""
    datos: dict[str, str] = {}
    for comando in _COMANDOS_STATUS:
        salida = await _ejecutar(ip, usuario, password, f"{comando} 2>&1")
        bajo = (salida or "").strip().lower()
        if "not found" in bajo or "no such file" in bajo:
            continue  # siguiente candidato
        datos = _pares(salida)
        if datos:
            break
        # el comando existe pero no entregó telemetría (shell restrictiva,
        # banner embebido, etc.): no vale probar el siguiente con el mismo shell
        raise EquipoNoAccesible(
            f"{comando} de {ip} no entregó telemetría (¿shell restrictiva?): salida en blanco"
        )
    else:
        # ningún comando existe: listar los mca* que sí hay para la pista
        diagnostico = ""
        try:
            diagnostico = (await _ejecutar(
                ip, usuario, password, "ls /bin/mca* /sbin/mca* /usr/bin/mca* /usr/sbin/mca* 2>/dev/null"
            )).strip()
        except EquipoNoAccesible:
            pass
        pista = f"; mca* disponibles: {diagnostico}" if diagnostico else ""
        raise EquipoNoAccesible(
            f"ningún comando de status respondió en {ip}{pista}"
        )

    # config de radio (frecuencia/txpower/modo): falla suave si no hay
    cfg: dict[str, str] = {}
    try:
        cfg = _pares(await _ejecutar(ip, usuario, password, "cat /tmp/system.cfg 2>&1"))
    except EquipoNoAccesible:
        cfg = {}

    # respaldo enriquecido: mca-dump (json completo del radio) entrega campos
    # que mca-status omite (ancho de canal, ip de interfaces…). Se fusiona
    # SIN pisar lo ya capturado: lo de mca-status/system.cfg manda.
    try:
        pares_dump = _pares(await _ejecutar(ip, usuario, password, "mca-dump 2>&1"))
    except EquipoNoAccesible:
        pares_dump = {}
    if pares_dump:
        datos.update({k: v for k, v in pares_dump.items() if k not in datos})

    # estaciones: CCQ. En modo AP el CCQ global no existe (vive por estación)
    try:
        salida_ws = await _ejecutar(ip, usuario, password, "wstalist 2>&1")
    except EquipoNoAccesible:
        salida_ws = ""
    filas_crudas: list[dict[str, Any]] = []
    try:
        filas_crudas = _estaciones_de_texto(salida_ws)
    except ValueError:
        log.warning("wstalist de %s no arrojó JSON reconocible: %s", ip, (salida_ws or "")[:300])

    f = _ficha_base(datos, cfg)
    if filas_crudas:
        f["stations_n"] = len(filas_crudas)
        # ccq: en AC (aireOS 7/8) no existe ni global ni por estación (no
        # tampoco en la UI web); el equivalente relevante es el 'link
        # potential' (capacidad negociada sobre la esperada). M-series (v6)
        # sí entrega ccq crudo 0-255 → porcentaje.
        norm = [_fila_estacion(fila) for fila in filas_crudas]
        ccq_pcts: list[float] = []
        for nf in norm:
            if nf.get("ccq"):
                try:
                    ccq_pcts.append(float(str(nf["ccq"]).replace("%", "").strip()))
                except ValueError:
                    continue
        if ccq_pcts:
            f["ccq"] = f"{round(sum(ccq_pcts) / len(ccq_pcts))}% (media de {len(ccq_pcts)})"
        else:
            # potencial por estación ('34.1%' → media)
            pots: list[float] = []
            for nf in norm:
                try:
                    pots.append(float(str(nf.get("potencial", "")).replace("%", "").strip()))
                except ValueError:
                    continue
            if pots:
                f["potencial"] = f"{round(sum(pots) / len(pots), 1)}% (media de {len(pots)})"
    return f


async def ficha(
    ip: str, usuario: str, password: str, forzar: bool = False
) -> dict[str, Any]:
    """Lectura memorizada 20 s: un refresco seguido del panel no reconecta.
    forzar=True (⟳ actualizar) salta la memoria y consulta al radio."""
    return await memo_ttl(
        "ubiquiti.ficha", ip, _TTL_LECTURA, lambda: _ficha_impl(ip, usuario, password), forzar=forzar
    )


async def _wireless_impl(ip: str, usuario: str, password: str) -> dict[str, Any]:
    """Estaciones conectadas (equivalente de la registration-table de
    RouterOS) vía wstalist. Misma envoltura que la pestaña wireless mikrotik
    (esquema/registros/canal/radios); además 'muestra': los campos crudos del
    RADIO (aplanados de mca-dump) para verificar el esquema exacto que
    entrega este firmware, como el expander de la vista mikrotik."""
    envoltorio = {
        "ip": ip,
        "esquema": "aireOS",
        "registros": [],
        "canal": None,
        "radios": [],
        "muestra": None,
        "detalle": None,
    }
    salida = await _ejecutar(ip, usuario, password, "wstalist 2>&1")
    bajo = (salida or "").strip().lower()
    if "not found" in bajo or "no such file" in bajo:
        return {**envoltorio, "detalle": "wstalist no existe en este firmware"}
    try:
        filas_crudas = _estaciones_de_texto(salida)
    except ValueError:
        log.warning("wstalist de %s no arrojó JSON reconocible: %s", ip, (salida or "")[:500])
        return {
            **envoltorio,
            "detalle": "wstalist no arrojó JSON reconocible (ver log del backend)",
        }
    if not filas_crudas:
        return {**envoltorio, "detalle": "no hay estaciones conectadas"}
    registros = [_fila_estacion(f) for f in filas_crudas]
    # 'muestra': campos crudos DEL RADIO (mca-dump aplanado) — la información
    # de la antena. El de estaciones no aporta: todas comparten el mismo
    # esquema y solo cambia el valor. Se filtran claves sensibles y el
    # respaldo (firmware viejo sin mca-dump) es la primera estación.
    salida_dump = ""
    try:
        salida_dump = await _ejecutar(ip, usuario, password, "mca-dump 2>&1")
    except EquipoNoAccesible:
        pass
    pares_dump = _pares(salida_dump) if salida_dump else {}
    if pares_dump:
        muestra = {k: v for k, v in pares_dump.items() if "pass" not in k.lower()}
    else:
        muestra: dict[str, str] = {}
        _aplanar(filas_crudas[0], "", muestra)
        muestra = {k: v for k, v in muestra.items() if ".evm." not in k and "tx_ratedata." not in k}
    return {**envoltorio, "registros": registros, "muestra": muestra}


async def wireless(ip: str, usuario: str, password: str, forzar: bool = False) -> dict[str, Any]:
    """Lectura memorizada 20 s (idem ficha); forzar=True salta la memoria."""
    return await memo_ttl(
        "ubiquiti.wireless", ip, _TTL_LECTURA, lambda: _wireless_impl(ip, usuario, password), forzar=forzar
    )


# ------------------------------------------------------------------ acciones

async def limpiar(ip: str) -> None:
    """Suelta la sesión SSH y las lecturas memorizadas de esa ip: credential
    cambiada, reboot programado o cualquier motivo para desconocer el estado."""
    await _ssh_pool.tirar_y_cerrar(ip)
    vaciar_memo(ip)


async def reboot(ip: str, usuario: str, password: str) -> dict[str, Any]:
    """Reinicia el radio (aireOS arranca en 1-2 min). La consola pide
    confirmación por teclado: se alimenta 'y' por stdin; la sesión normalmente
    cae al ejecutarse el reboot, y eso NO es fallo del ciclo. Conexión directa
    (el pool no regresa: el equipo va a morir) y luego suelta cache/sesión."""
    conn = await _abrir(ip, usuario, password)
    try:
        with contextlib.suppress(asyncssh.Error, asyncio.TimeoutError, OSError):
            await asyncio.wait_for(
                conn.run("printf 'y\\n' | reboot 2>&1", check=False),
                timeout=TIMEOUT_S,
            )
    finally:
        await _cerrar(conn)
        await _ssh_pool.tirar_y_cerrar(ip)
        vaciar_memo(ip)
    return {"ok": True, "transporte": f"SSH {_PUERTO_SSH}", "detalle": f"reinicio enviado ({ip})"}
