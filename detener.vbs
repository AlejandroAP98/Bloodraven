' Bloodraven - detener sin ventana de consola visible
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
raiz = fso.GetParentFolderName(WScript.ScriptFullName)
comando = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & raiz & "\detener.ps1"""
sh.Run comando, 0, False
