# Bloodraven - crear accesos directos en el Escritorio
# Ejecutar una vez (o cuando se mueva la carpeta del proyecto).
$ErrorActionPreference = "Stop"
$raiz = $PSScriptRoot
$escritorio = [Environment]::GetFolderPath("Desktop")
$sh = New-Object -ComObject WScript.Shell
$icono = Join-Path $raiz "marca_falcon.ico"

# Iniciar
$lnk = $sh.CreateShortcut((Join-Path $escritorio "Bloodraven.lnk"))
$lnk.TargetPath = (Join-Path $env:WINDIR "System32\wscript.exe")
$lnk.Arguments = '"' + (Join-Path $raiz "iniciar.vbs") + '"'
$lnk.WorkingDirectory = $raiz
if (Test-Path $icono) { $lnk.IconLocation = "$icono,0" }
$lnk.Description = "Bloodraven - iniciar servidor y abrir la interfaz"
$lnk.Save()

# Detener
$lnk2 = $sh.CreateShortcut((Join-Path $escritorio "Detener Bloodraven.lnk"))
$lnk2.TargetPath = (Join-Path $env:WINDIR "System32\wscript.exe")
$lnk2.Arguments = '"' + (Join-Path $raiz "detener.vbs") + '"'
$lnk2.WorkingDirectory = $raiz
if (Test-Path $icono) { $lnk2.IconLocation = "$icono,0" }
$lnk2.Description = "Bloodraven - detener el servidor"
$lnk2.Save()

Write-Output "accesos creados en: $escritorio"
