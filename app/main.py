import asyncio
import logging
import os
import socket
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.routers import acciones, catalogo, datos, devices, prueba, topologia, topologia_general
from app.workers.agregador import consolidar
from app.workers.chequeos import cerrar_http
from app.workers.probes import correr_scheduler, detener_scheduler

settings = get_settings()
DIST = Path(__file__).resolve().parent.parent / "static"


async def _job_consolidador() -> None:
    # incremental cada minuto (agg listas hasta hace un minuto) y, en la hora
    # fijada, pasada completa nocturna aunque sea una vez por fecha
    full_hecho: str | None = None
    while True:
        ahora = datetime.now(timezone.utc)
        try:
            await consolidar(incremental=True)
            if ahora.hour == settings.consolidador_hora and full_hecho != ahora.date().isoformat():
                await consolidar()  # completada: faltantes + purga de retención
                full_hecho = ahora.date().isoformat()
        except Exception:
            import traceback

            traceback.print_exc()
        objetivo = (ahora + timedelta(minutes=1)).replace(second=0, microsecond=0)
        await asyncio.sleep(max(0.0, (objetivo - datetime.now(timezone.utc)).total_seconds()))


@asynccontextmanager
async def lifespan(appa: FastAPI) -> AsyncIterator[None]:
    tarea = asyncio.create_task(correr_scheduler())
    tarea_job = asyncio.create_task(_job_consolidador())
    yield
    tarea.cancel()
    tarea_job.cancel()
    await detener_scheduler()
    await cerrar_http()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.include_router(devices.router)
app.include_router(datos.router)
app.include_router(acciones.router)
app.include_router(catalogo.router)
app.include_router(prueba.router)
app.include_router(topologia.router)
app.include_router(topologia_general.router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"ok": "true"}


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{ruta:path}", include_in_schema=False)
    async def spa(ruta: str) -> FileResponse:
        # contención estricta: la ruta llega decodificada por uvicorn (unquote)
        # y starlette la entrega tal cual, así que puede traer .., backslash,
        # letra de unidad o UNC; se resuelve y se exige pertenencia a static/
        # antes de servir (StaticFiles ya lo hace con commonpath; el handler
        # heredado no, y así servía "../credencial_clave.key" o "../.env")
        archivo = (DIST / ruta).resolve()
        if ruta and archivo.is_file() and archivo.is_relative_to(DIST.resolve()):
            # los assets con hash en el nombre pueden cachearse sin límite:
            # cualquier cambio de código produce otro nombre de archivo
            return FileResponse(archivo, headers={"Cache-Control": "public, max-age=31536000, immutable"})
        # todo lo demás (incluida una ruta que escapa de static/) cae al
        # index.html del SPA, que siempre revalida: sin esto el navegador
        # usa copia y no ve el build nuevo
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})


def main() -> None:
    # logging propio de la app (uvicorn configura solo su logger):
    # todo lo que imprime uvicorn (incluida la traza de un 500 sin manejar)
    # queda pegado en logs/bloodraven.uvicorn.log para poder diagnosticarlo
    log_dir = Path(__file__).resolve().parent.parent / "logs"
    log_dir.mkdir(exist_ok=True)
    archivo = logging.FileHandler(log_dir / "bloodraven.uvicorn.log", encoding="utf-8")
    archivo.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    raiz = logging.getLogger()
    raiz.handlers.clear()
    raiz.addHandler(archivo)
    raiz.setLevel(logging.INFO)
    # uvicorn instala sus propios handlers: quitarlos y propagar a la raíz
    for nombre in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(nombre)
        lg.handlers.clear()
        lg.propagate = True

    # una sola instancia: si el puerto ya está en escucha, otra Bloodraven
    # corre — avisar y salir sin crear un segundo icono en la bandeja
    log = logging.getLogger("app.main")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sonda:
            sonda.bind((settings.host, settings.port))
    except OSError:
        log.warning("puerto %s ocupado: ya hay una instancia de Bloodraven (sin lanzar otra)", settings.port)
        return

    # objeto Server explicito: permite pedir apagado elegante desde la bandeja
    config = uvicorn.Config(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
    )
    server = uvicorn.Server(config)

    if settings.bandeja:
        try:
            from app import bandeja
            bandeja.iniciar(
                url=f"http://{settings.host}:{settings.port}/",
                detener=lambda: setattr(server, "should_exit", True),
            )
        except Exception as exc:  # la bandeja nunca debe tumbar el arranque
            log.warning("bandeja: fallo al iniciar (%s)", exc)

    server.run()

    # el servidor terminó (apagado elegante desde la bandeja o señal):
    # retirar el icono y asegurar que el proceso muere — sin esto, el
    # hilo de pystray deja un icono fantasma en la bandeja
    try:
        from app import bandeja
        bandeja.apagar()
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
