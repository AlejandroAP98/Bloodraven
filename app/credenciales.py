"""Cifrado de credenciales de equipos con Fernet.

La clave sale de .env (credencial_clave); si no está declarada, se genera una
vez y se guarda en credencial_clave.key — pero NUNCA en claro: se envuelve
con DPAPI (CryptProtectData) atado al perfil de Windows del usuario. Así el
archivo es opaco para otros perfiles del equipo y para la copia que OneDrive
suba a la nube (hallazgo F2 del audit: antes la clave Fernet estaba en texto
plano, legible por cualquier proceso del mismo usuario y por el sync central).

Formato del archivo:
  dpapi:v1:<base64 del blob DPAPI que envuelve el base64 de la clave Fernet>

Compatibilidad: si existe un archivo legacy con la clave en claro, se usa
esa clave, se reenvuelve y se reescribe una sola vez (migración
transparente: la clave NO cambia, las credenciales guardadas siguen
descifrando igual). Límite declarado: un proceso corriendo como el mismo
usuario de Windows sigue pudiendo rescatar la clave — es inherente a un
equipo monousuario sin store con consentimiento (lo que DPAPI sí cierra es
la exfiltración cross-usuario y la copia cloud)."""

import base64
import ctypes
import logging
import platform
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings

log = logging.getLogger("app.credenciales")
_MARCADOR = "dpapi:v1:"

# la clave vive en la carpeta del repo pero cifrada con DPAPI del perfil;
# el contenido en claro nunca toca el disco ni la copia de OneDrive
_ARCHIVO = Path(__file__).resolve().parent.parent / "credencial_clave.key"
_clave: bytes | None = None


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.c_ulong),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


_UI_FORBIDDEN = 0x1


def _dpapi_envuelve(texto: str) -> str:
    """devuelve 'dpapi:v1:<base64>' del texto cifrado con DPAPI del perfil."""
    datos = texto.encode("utf-8")
    buffer = ctypes.create_string_buffer(datos, len(datos))
    dentro = _DATA_BLOB(len(datos), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    fuera = _DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(dentro),  # pDataIn
        None,  # pSzDataDescr
        None,  # pEntropy
        None,  # pvReserved
        None,  # pPromptStruct
        _UI_FORBIDDEN,
        ctypes.byref(fuera),
    )
    if not ok:
        raise OSError("CryptProtectData falló")
    try:
        crudo = ctypes.string_at(fuera.pbData, fuera.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(fuera.pbData)
    return _MARCADOR + base64.b64encode(crudo).decode()


def _dpapi_abre(envuelto: str) -> str:
    crudo = base64.b64decode(envuelto[len(_MARCADOR):])
    buffer = ctypes.create_string_buffer(crudo, len(crudo))
    dentro = _DATA_BLOB(len(crudo), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    fuera = _DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(dentro),
        None,
        None,
        None,
        None,
        _UI_FORBIDDEN,
        ctypes.byref(fuera),
    )
    if not ok:
        # blob inaccesible: otro perfil de Windows, archivo restaurado de la
        # nube a un equipo distinto, o perfil dañado — el dueño debe
        # re-registrar las credenciales (mismo recover del InvalidToken)
        raise RuntimeError(
            "credenciales: el blob DPAPI de credencial_clave.key no se puede"
            " abrir con este perfil de Windows (¿restaurado de otra"
            " máquina/perfil?): borra el archivo y vuelve a registrar las"
            " credenciales de los equipos"
        )
    try:
        return ctypes.string_at(fuera.pbData, fuera.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(fuera.pbData)


def _lee_archivo(archivo: Path) -> bytes:
    texto = archivo.read_text(encoding="utf-8").strip()
    if texto.startswith(_MARCADOR):
        if platform.system() != "Windows":
            raise RuntimeError("credenciales: el archivo usa DPAPI y no es Windows")
        clave_b64 = _dpapi_abre(texto)
        # el blob envuelve el TEXTO base64 de la clave (44 chars), que es lo
        # que Fernet() espera: no se vuelve a decodificar
        _clave = clave_b64.encode()
        return _clave
    # formato legacy: la clave Fernet en claro (carrera previa a DPAPI).
    # se usa y se reenvuelve una vez: la clave NO cambia
    _clave = texto.encode()
    try:
        archivo.write_text(_dpapi_envuelve(texto), encoding="utf-8")
        log.info(
            "credenciales: clave legacy migrada a DPAPI en %s (mismo contenido"
            " de clave; la copia OneDrive ahora es opaca y otros perfiles del"
            " equipo no pueden abrir el archivo)",
            archivo,
        )
    except OSError as exc:
        log.warning("credenciales: no se pudo migrar a DPAPI (%s)", exc)
    return _clave


def _escribe_archivo(archivo: Path, clave: bytes) -> None:
    # `clave` ya es el TEXTO base64 de la clave Fernet (32 bytes codificados);
    # se envuelve tal cual — sin volver a codificar en base64
    clave_b64 = clave.decode()
    if platform.system() == "Windows":
        contenido = _dpapi_envuelve(clave_b64)
    else:
        # plataforma sin DPAPI (no soportada por la app, pero se comporta
        # como el formato legacy para no romper entornos de desarrollo no-Windows)
        contenido = clave_b64
        log.warning("credenciales: sin DPAPI; el archivo queda en claro (plataforma no-Windows)")
    archivo.write_text(contenido, encoding="utf-8")


def _obtener_clave() -> bytes:
    global _clave
    if _clave is not None:
        return _clave
    declarada = get_settings().credencial_clave
    if declarada:
        # si el operador controla la clave por .env, prevalece y no se
        # toca ningún archivo (el .key queda solo como respaldo histórico)
        _clave = declarada.encode()
        return _clave
    archivo = _ARCHIVO
    try:
        if archivo.exists() and archivo.stat().st_size > 0:
            _clave = _lee_archivo(archivo)
            return _clave
        _clave = Fernet.generate_key()
        _escribe_archivo(archivo, _clave)
        log.warning(
            "credenciales: clave Fernet generada en %s (cifrada con DPAPI del"
            " perfil de Windows; declara credencial_clave en .env si prefieres"
            " controlarla tú; el archivo ya está en .gitignore)",
            archivo,
        )
        return _clave
    except RuntimeError:
        raise
    except Exception as exc:
        log.error("credenciales: no se pudo usar %s (%s)", archivo, exc)
        raise


def cifrar(texto: str) -> str:
    return Fernet(_obtener_clave()).encrypt(texto.encode()).decode()


def descifrar(texto: str) -> str:
    try:
        return Fernet(_obtener_clave()).decrypt(texto.encode()).decode()
    except InvalidToken as exc:
        raise RuntimeError(
            "la contraseña guardada no se puede descifrar (¿cambió la clave de"
            " cifrado?): vuelve a registrar la credencial del equipo"
        ) from exc
