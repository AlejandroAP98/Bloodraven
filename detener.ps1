# Bloodraven - detener el servidor oculto
# Usa el PID guardado por run.ps1; si se perdio, localiza el proceso que escucha en el puerto.
$ErrorActionPreference = "SilentlyContinue"
Set-Location $PSScriptRoot
$raiz = $PSScriptRoot
$logs = Join-Path $raiz "logs"
$archivoPid = Join-Path $logs "bloodraven.pid"

# puerto desde .env (por defecto 8080)
$puerto = "8080"
if (Test-Path (Join-Path $raiz ".env")) {
    foreach ($linea in Get-Content (Join-Path $raiz ".env")) {
        if ($linea -match "^\s*PORT\s*=\s*(.+?)\s*$") { $puerto = $Matches[1].Trim('"') }
    }
}

$hecho = $false

if (Test-Path $archivoPid) {
    $numeroPid = Get-Content $archivoPid | Select-Object -First 1
    $proc = Get-Process -Id $numeroPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match "python") {
        Stop-Process -Id $numeroPid -Force
        $hecho = $true
    }
    Remove-Item $archivoPid -ErrorAction SilentlyContinue
}

if (-not $hecho) {
    $conex = Get-NetTCPConnection -LocalPort ([int]$puerto) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conex) {
        Stop-Process -Id $conex.OwningProcess -Force
        $hecho = $true
    }
}

if ($hecho) {
    Write-Output "servidor detenido"
} else {
    Write-Output "no habia servidor activo"
}
