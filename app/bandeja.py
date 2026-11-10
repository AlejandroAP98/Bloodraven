# Bandeja de sistema: indicador visible del servidor activo.
# - Clic normal -> abre la interfaz en el navegador.
# - Menu "Detener servidor" -> apagado elegante (flag should_exit de uvicorn).
# Si el entorno no tiene escritorio disponible (RDP desconectado, servicio),
# registra el aviso y el servidor sigue en modo headless.
import logging
import webbrowser
from pathlib import Path

from PIL import Image

log = logging.getLogger("app.bandeja")

ICONO = Path(__file__).resolve().parent.parent / "marca.ico"

_icono = None  # icono vivo de esta instancia (para poder retirarlo al apagar)


def iniciar(url: str, detener) -> bool:
    """Mostrar el icono de bandeja. `detener` se llama al pedir apagar el server."""
    global _icono
    try:
        import pystray
    except ImportError:
        log.warning("bandeja: pystray no instalado; servidor headless")
        return False

    try:
        image = Image.open(ICONO)
        menu = pystray.Menu(
            pystray.MenuItem("Abrir interfaz", lambda *_: webbrowser.open(url), default=True),
            pystray.MenuItem("Detener servidor", lambda *_: detener()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Bloodraven activo", lambda *_: None, enabled=False),
        )
        icon = pystray.Icon("bloodraven", image, "Bloodraven — supervisión de conectividad", menu)
        _icono = icon
        icon.run_detached()
        log.info("bandeja: icono activo en %s", url)
        return True
    except Exception as exc:  # bandeja es best-effort: nunca debe tumbar el servidor
        log.warning("bandeja: no disponible (%s); servidor headless", exc)
        return False


def apagar() -> None:
    """Esconde y detiene el icono: sin ello queda fantasma en la bandeja."""
    global _icono
    icon, _icono = _icono, None
    if icon is None:
        return
    try:
        icon.visible = False
        icon.stop()
        log.info("bandeja: icono retirado")
    except Exception as exc:
        log.warning("bandeja: no se pudo retirar el icono (%s)", exc)
