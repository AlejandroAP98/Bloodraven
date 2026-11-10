"""Importador del XML de The Dude (MikroTik) al catálogo equipos_red.

Dude exporta el mapa completo: DeviceType (tabla de tipos), Device (648 con
IP), Link, LogEntry… El archivo ronda los 100 MB, así que se recorre con
iterparse liberando cada elemento consumido. Solo interesan DeviceType y
Device; credenciales/graficas no se importan.
"""

import ipaddress
import re
import xml.etree.ElementTree as ET
from collections import Counter

from io import BytesIO

MAX_BODY = 300 * 1024 * 1024
MAX_EQUIPOS = 20000

# patrones por nombre (tokens con límites, para no morder Camilo/Camioneros/Campestre)
_P_RADIO = re.compile(
    r"torre|mastil|antena|radio|celda|sector|ptp|ptmp|cpe|rocket|bullet|beam|ubnt|wisp|epmp|eptp",
    re.IGNORECASE,
)
_P_DVR = re.compile(r"\bdvr\b|\bnvr\b", re.IGNORECASE)
_P_CAM = re.compile(r"camara|camra|(?<![a-z])cam(?!ima)(?![a-z])|merc-cam", re.IGNORECASE)
_P_PC = re.compile(r"\bpc\b|dator|laptop|desktop", re.IGNORECASE)
_P_RB = re.compile(r"\brb\d|hex |hex-|hAP", re.IGNORECASE)
_P_SWITCH = re.compile(r"\bsw[ -]|\bswitch\b|crs\d|css\d", re.IGNORECASE)

# typeID de The Dude -> rol del catálogo (los del nombre ganan cuando aplican)
_TIPO_FIJO: dict[str, str] = {
    "10295": "switch",  # Bridge
    "10296": "router/agregador",  # Enrutador
    "10297": "switch",  # Switch
    "10299": "PC",  # Windows Dators
    # 10298..10308: servidores servicios (dude, ftp, correo, web, dns…)
}
_P_SERVIDORES = set("10298 10301 10302 10303 10304 10305 10306 10307 10308".split())
# impresoras -> otro con nota


def _limpia_nombre(nombre: str, ip: str) -> str:
    """Quita la IP que The Dude suele poner al inicio del nombre y recorta a 100."""
    n = (nombre or "").strip()
    if ip and n.lower().startswith(ip.lower()):
        n = n[len(ip):].strip()
    n = re.sub(r"^[-_.\s]+|[-_.\s]+$", "", n)
    return re.sub(r"\s+", " ", n)[:100] or ip


def _decide_rol(nombre: str, typeID: str, tipos: dict[str, str]) -> tuple[str, str]:
    """Devuelve (rol, notas). La pista del nombre manda; el tipo de Dude es el respaldo."""
    notas_tipo = f"Dude: {tipos.get(typeID, 'sin tipo')}"
    if _P_RADIO.search(nombre):
        return "radio/antena", notas_tipo
    if _P_DVR.search(nombre):
        return "DVR", notas_tipo
    if _P_CAM.search(nombre):
        return "cámara", notas_tipo
    if _P_PC.search(nombre):
        return "PC", notas_tipo
    if typeID in _TIPO_FIJO:
        return _TIPO_FIJO[typeID], notas_tipo
    if typeID in _P_SERVIDORES:
        return "servidor", notas_tipo
    if typeID == "10300" or typeID == "10309":  # impresoras
        return "otro", f"{notas_tipo} (impresora)"
    if _P_SWITCH.search(nombre) and not _P_RB.search(nombre):
        return "switch", notas_tipo
    if _P_RB.search(nombre):
        return "router/agregador", notas_tipo
    if typeID == "10294":  # MikroTik genérico: en la mayoría de casos es router
        return "router/agregador", notas_tipo
    return "otro", notas_tipo


def importar_dude(data: bytes) -> dict[str, object]:
    """Parsea el XML y devuelve el lote a insertar + conteos (sin tocar la BD).

    Streams con iterparse ("start"+"end"): los valores que interesan
    (sys-id/sys-name/addresses/typeID) se capturan justo al terminar el hijo,
    DESPUÉS se procesa el contenedor (DeviceType/Device) y se limpia todo.
    Si se limpiara solo en el end del contenedor, el clear de los hijos ya
    habría vaciado el texto (por eso los Device salían sin IP).
    """
    tipos: dict[str, str] = {}
    lotes: list[dict[str, str]] = []
    seen: set[str] = set()
    dups = 0
    sin_ip = 0
    ip_inv = 0
    abiertos = 0  # elementos actualmente abiertos
    buf: dict[str, str] = {}  # texto del último hijo capturado

    for evento, elem in ET.iterparse(BytesIO(data), events=("start", "end")):
        if evento == "start":
            abiertos += 1
            continue
        abiertos -= 1
        tag = elem.tag
        if abiertos == 2 and tag in ("sys-id", "sys-name", "addresses", "typeID"):
            buf[tag] = (elem.text or "").strip()
        elif tag == "DeviceType":
            if buf.get("sys-id"):
                tipos[buf["sys-id"]] = buf.get("sys-name", "")
            buf.clear()
        elif tag == "Device":
            nombre = buf.get("sys-name", "")
            typeID = buf.get("typeID", "")
            direcciones = [a for a in buf.get("addresses", "").replace(",", " ").split() if a]
            primera = True
            for cand in direcciones:
                ip = cand.split("/")[0]
                try:
                    ip = str(ipaddress.ip_address(ip))
                except ValueError:
                    ip_inv += 1
                    continue
                if ip in seen:
                    dups += 1
                    continue
                seen.add(ip)
                rol, notas = _decide_rol(nombre, typeID, tipos)
                if not primera:
                    notas = f"{notas} (IP alterna del mismo equipo)"
                lotes.append(
                    {
                        "ip": ip,
                        "nombre": _limpia_nombre(nombre, ip),
                        "rol": rol,
                        "notas": notas[:255],
                    }
                )
                primera = False
            if not direcciones:
                sin_ip += 1
            buf.clear()
        elem.clear()

    roles = Counter(e["rol"] for e in lotes)  # type: ignore[arg-type]
    return {
        "equipos": lotes[:MAX_EQUIPOS],
        "n_xml": len(lotes),
        "duplicados_xml": dups,
        "sin_ip": sin_ip,
        "ip_invalida": ip_inv,
        "por_rol": dict(roles),
    }
