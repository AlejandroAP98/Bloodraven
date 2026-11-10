# Bloodraven - lanzador idempotente
# - Si el servidor ya responde en HOST:PORT, solo abre el navegador.
# - Si no, prepara el venv, corre migraciones y arranca oculto con log en logs\.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$raiz = $PSScriptRoot
$logs = Join-Path $raiz "logs"
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$pidGuardado = Join-Path $logs "bloodraven.pid"

# HOST/PORT desde .env (mismos valores que lee app/config.py)
$host_srv = "127.0.0.1"
$puerto = "8080"
if (Test-Path (Join-Path $raiz ".env")) {
    foreach ($linea in Get-Content (Join-Path $raiz ".env")) {
        if ($linea -match "^\s*HOST\s*=\s*(.+?)\s*$") { $host_srv = $Matches[1].Trim('"') }
        if ($linea -match "^\s*PORT\s*=\s*(.+?)\s*$") { $puerto = $Matches[1].Trim('"') }
    }
}
$enlace = "http://${host_srv}:${puerto}/"

function Probar-Enlace {
    try {
        $r = Invoke-WebRequest -Uri "http://${host_srv}:${puerto}/api/health" -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

# ya corriendo -> solo abrir la interfaz
if (Probar-Enlace) {
    Start-Process $enlace
    exit 0
}

# venv de primera vez
if (-not (Test-Path .venv\Scripts\python.exe)) {
    python -m venv .venv
    .venv\Scripts\pip install -r requirements.txt --disable-pip-version-check
}

# migraciones
.venv\Scripts\python -m alembic upgrade head

# servidor oculto, salida a log
$py = Join-Path $raiz ".venv\Scripts\python.exe"
$proc = Start-Process -FilePath $py `
    -ArgumentList "-u", "-m", "app.main" `
    -WorkingDirectory $raiz `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs "bloodraven.log") `
    -RedirectStandardError (Join-Path $logs "bloodraven.err.log") `
    -PassThru
$proc.Id | Set-Content $pidGuardado

# esperar a que el puerto responda y abrir la interfaz
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Probar-Enlace) { break }
}
if (-not (Probar-Enlace)) {
    # algo fallo al arrancar: avisar sin consola visible
    $err = ""
    if (Test-Path (Join-Path $logs "bloodraven.err.log")) {
        $err = Get-Content (Join-Path $logs "bloodraven.err.log") -Tail 5 | Out-String
    }
    $wsh = New-Object -ComObject WScript.Shell
    $wsh.Popup("No se pudo arrancar el servidor.`n`nRevisa logs\bloodraven.err.log:`n$err", 10, "Bloodraven", 48) | Out-Null
}
Start-Process $enlace
