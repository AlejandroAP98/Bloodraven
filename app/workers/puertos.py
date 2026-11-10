"""Sondeo de puertos TCP para identificar el papel de los equipos de la ruta.

Abre conexiones TCP a una lista corta de puertos característicos, puntúa el
resultado con firmas conocidas (RTSP/8000/34567 -> cámara o DVR, RDP/VNC/SMB ->
PC Windows, SSH/Telnet/HTTP -> equipo gestionable) y además captura el banner
que contesta cada servicio: el SSH de RouterOS se llama a sí mismo "ROSSSH",
las cámaras web se presentan como "Boa"/"GoAhead"/"Hikvision-Webs", los DVer
Dahua como "DNVRS"… ese texto sube la confianza de la sugerencia.
"""

import asyncio
import re
from collections import defaultdict

# puerto -> (rol que aporta, peso de la señal)
SIGNOS_PORT: dict[int, tuple[str, float]] = {
    22: ("gestionable", 0.6),
    23: ("gestionable", 0.9),
    21: ("ftp", 1.0),
    554: ("cámara", 2.6),
    8554: ("cámara", 2.0),
    8000: ("DVR", 2.2),  # Hikvision
    34567: ("DVR", 3.0),  # Dahua/Hikvision aliados
    37777: ("DVR", 3.0),  # Dahua
    37899: ("DVR", 1.8),
    9527: ("cámara", 1.4),
    3389: ("PC", 3.4),  # RDP
    5900: ("PC", 2.0),  # VNC
    445: ("PC", 1.1),  # SMB/Windows
    139: ("PC", 0.6),  # NetBIOS
    80: ("web", 0.5),
    443: ("web", 0.5),
    8080: ("web", 0.4),
    81: ("web", 0.3),  # web de cámaras/DVR chinos
    8443: ("web", 0.3),
    8291: ("routeros", 3.0),  # winbox: solo RouterOS (MikroTik)
    8728: ("routeros", 1.4),  # api de RouterOS
    8729: ("routeros", 1.4),  # api-ssl de RouterOS (misma api sobre TLS)
}

# puertos que siempre se intentan (orden no importa; se abre en paralelo)
PUERTOS: tuple[int, ...] = (
    23, 22, 21, 80, 81, 443, 8080, 8443, 139, 445, 3389, 5900,
    554, 8554, 8000, 34567, 37777, 37899, 9527, 8291, 8728, 8729,
)

# puertos cuyo banner se pide (los demás: solo conexión)
_P_HTTP = {80, 81, 443, 8080, 8443}
_P_RTSP = {554, 8554}
_P_PASIVO = {22, 21, 23}  # contestan banner sin que uno hable

MAX_IPS = 24
MAX_CONC = 8
TIMEOUT_S = 1.5
BANNER_TIMEOUT_S = 1.2

# huellas del banner -> pista (se buscan case-insensitive en el texto)
_P_MIKROTIK = re.compile(r"rosssh|mikrotik|routeros", re.IGNORECASE)
_P_LINUX = re.compile(r"openssh|dropbear|ubuntu|debian", re.IGNORECASE)
_P_CAM = re.compile(
    r"boa|goahead|hikvision|dahua|dnvrs|netwave|app-webs|viser|dvr|network.?video",
    re.IGNORECASE,
)


async def _proba(ip: str, puerto: int) -> tuple[int, bool, str]:
    """Conecta a ip:puerto; devuelve (puerto, abierto, banner)."""
    bandera = ""
    try:
        lector, w = await asyncio.wait_for(asyncio.open_connection(ip, puerto), timeout=TIMEOUT_S)
    except Exception:
        return puerto, False, ""

    # obtener algo de texto del servicio (con presupuesto corto)
    async def _lee(n: int = 2048) -> str:
        try:
            data = await asyncio.wait_for(lector.read(n), timeout=BANNER_TIMEOUT_S)
            texto = data.decode("utf-8", "replace")
            # los banners brutos traen bytes de control (la cabecera SSH
            # arranca con \x00\x00\x01< y el telnet con 0xff 0xfb):
            # Postgres rechaza el NUL en texto y la firma viaja hacia las
            # notas del catálogo — convertir control a espacio
            return "".join(
                " " if (ch < " " and ch not in "\t\r\n") or ch == "\x7f" else ch
                for ch in texto
            )
        except Exception:
            return ""

    try:
        if puerto in _P_HTTP:
            w.write(f"HEAD / HTTP/1.0\r\nHost: {ip}\r\nUser-Agent: bloodraven\r\n\r\n".encode())
            await w.drain()
            bandera = await _lee()
        elif puerto in _P_RTSP:
            w.write("OPTIONS rtsp://x RTSP/1.0\r\nCSeq: 1\r\n\r\n".encode())
            await w.drain()
            bandera = await _lee()
        elif puerto in _P_PASIVO:
            bandera = await _lee()
        # 8291 (winbox), 8728 y 8729 (api + api-ssl) no hablan sin protocolo: el
    # puerto ya es la pista
    except Exception:
        pass

    w.close()
    try:
        await w.wait_closed()
    except Exception:
        pass
    return puerto, True, bandera[:256]


def _limpia_banner(texto: str) -> str:
    """Deja una línea corta legible del banner para la firma."""
    # bytes de control fuera (cualquier NUL que se colara chocaría contra
    # el rechazo de Postgres al guardar la firma como nota del catálogo)
    t = re.sub("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", texto or "")
    t = " ".join(t.split())[:120]
    return t if t else ""


def _clasifica(
    abiertos: list[int], banners: dict[int, str]
) -> tuple[str | None, float | None, str | None]:
    """A partir de los puertos abiertos y banners: (rol, confianza 0..1, firma)."""
    if not abiertos:
        return None, None, None
    p = set(abiertos)
    scores: dict[str, float] = defaultdict(float)
    for puerto in p:
        rol, peso = SIGNOS_PORT[puerto]
        scores[rol] += peso

    firma = ", ".join(str(x) for x in sorted(p))
    texto_banner = " | ".join(("p%d " % pu) + _limpia_banner(b) for pu, b in sorted(banners.items()) if b)
    indicios_cam = p & {554, 8554, 9527}
    indicios_dvr = p & {8000, 34567, 37777, 37899}
    indicios_pc = p & {3389, 5900}  # escritorio remoto (RDP/VNC): PC
    indicios_win = p & {445, 139}  # SMB/NetBIOS: Windows... o Samba en un PC Linux
    indicios_gest = p & {22, 23}  # SSH/Telnet: gestión de equipo... también PC Linux
    web_solo = scores["web"] > 0 and scores["cámara"] == 0 and scores["DVR"] == 0 and scores["PC"] == 0

    hint_banner = f" banner: {texto_banner}" if texto_banner else ""

    # --- evidencia MikroTik (winbox/API/banner) ---
    es_mikrotik = bool(8291 in p or scores["routeros"] >= 3.0 or (banners and _P_MIKROTIK.search(texto_banner)))

    # --- cámara vs DVR: RTSP + puertos propios de grabador (o SMB, que trae el
    # DVR para sus utilidades) -> grabador; RTSP solo -> cámara
    if indicios_dvr or (indicios_cam and indicios_win):
        if indicios_dvr and not indicios_cam:
            return "DVR", min(1.0, scores["DVR"] / 3.5), f"grabador: {firma}{hint_banner}"
        return "DVR", min(1.0, (scores["DVR"] + scores["cámara"] + 2.4) / 5.0), f"grabador con video: {firma}{hint_banner}"
    if indicios_cam and not indicios_dvr:
        return "cámara", min(1.0, scores["cámara"] / 4.0), f"video rtsp: {firma}{hint_banner}"

    # --- banner de cámara web sin RTSP (Boa/GoAhead/Hikvision-Webs…) ---
    if banners and _P_CAM.search(texto_banner):
        return "cámara", 0.8, f"http de cámara web: {firma}{hint_banner}"

    # --- RouterOS: winbox abierto o banner ROSSSH/MikroTik es prácticamente prueba ---
    if es_mikrotik:
        if banners and re.search(r"\bcrs\d|\bcss\d", texto_banner, re.IGNORECASE):
            return "switch", 0.9, f"routeros (banner CRS/CSS): {firma}{hint_banner}"
        conf = 0.95 if 8291 in p or _P_MIKROTIK.search(banners.get(22, "") or banners.get(23, "")) else 0.8
        return "router/agregador", conf, f"routeros (winbox/rosssh): {firma}{hint_banner}"

    if indicios_pc:
        conf = scores["PC"] + (0.6 if indicios_win and indicios_pc else 0)
        return "PC", min(1.0, conf / 4.0), f"escritorio remoto: {firma}{hint_banner}"
    # SMB + SSH sin video ni RDP: lo típico es un PC Linux con Samba
    if indicios_win and indicios_gest and not (p & {8000, 34567, 37777, 37899}):
        conf = 0.85 if banners and _P_LINUX.search(texto_banner) else 0.7
        extra = " (OpenSSH/Dropbear confirmado)" if conf == 0.85 else ""
        return "PC", conf, f"samba + ssh, PC Linux probable{extra}: {firma}{hint_banner}"
    if indicios_win:
        # SMB/NetBIOS sin SSH ni video: Windows sin escritorio remoto
        return "PC", min(1.0, scores["PC"] / 4.0), f"windows: {firma}{hint_banner}"
    if indicios_gest and web_solo:
        # ssh/telnet + web sin video ni SMB: equipo gestionable…
        ban_ssh = banners.get(22, "") + banners.get(23, "")
        # …RouterOS NUNCA corre OpenSSH (anuncia ROSSSH): banner OpenSSH = caja Linux
        if re.search(r"openssh", ban_ssh, re.IGNORECASE):
            return "PC", 0.6, f"linux (openssh) + web: ¿PC o servidor?: {firma}{hint_banner}"
        # …dropbear + web en una WISP es firma típica de antena (Ubiquiti/OpenWRT)
        if re.search(r"dropbear", ban_ssh, re.IGNORECASE):
            return "radio/antena", 0.5, f"dropbear + web: ¿antena openwrt/ubiquiti?: {firma}{hint_banner}"
        conf = min(1.0, scores["gestionable"] / 2.8)
        return "router/agregador", conf, f"gestion web/ssh-telnet: {firma}{hint_banner}"
    if indicios_gest:
        # ssh/telnet solos: neutro (podría ser un PC Linux o server headless)
        return "otro", 0.2, f"ssh/telnet solos: router, switch, antena o PC (Linux): {firma}{hint_banner}"
    if web_solo:
        return "radio/antena", 0.3, f"solo web: {firma}{hint_banner}"
    return "otro", 0.2, f"puertos: {firma}{hint_banner}"


async def sondear(ips: list[str]) -> list[dict[str, object]]:
    """Sondea una lista de IPs (máx MAX_IPS) y devuelve la firma por IP."""
    ipas = list(dict.fromkeys(i.strip() for i in ips if i.strip()))[:MAX_IPS]
    if not ipas:
        return []
    sem = asyncio.Semaphore(MAX_CONC)

    async def _uno(ipa: str) -> dict[str, object]:
        async def _conn(puerto: int) -> tuple[int, bool, str]:
            async with sem:
                return await _proba(ipa, puerto)

        res = await asyncio.gather(*[_conn(p) for p in PUERTOS])
        abiertos = [p for p, ok, _ in res if ok]
        banners = {p: b for p, ok, b in res if ok and b}
        rol, conf, firma = _clasifica(abiertos, banners)
        return {
            "ip": ipa,
            "abiertos": abiertos,
            "rol_sugerido": rol,
            "confianza": round(conf, 2) if conf is not None else None,
            "firma": firma,
        }

    return list(await asyncio.gather(*[_uno(i) for i in ipas]))
