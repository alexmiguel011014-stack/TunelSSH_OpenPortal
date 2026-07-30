Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = "D:\ProjetosVS\TunelSSH"

' Matar processos anteriores
WshShell.Run "taskkill /F /IM electron.exe", 0, True
WshShell.Run "taskkill /F /IM node.exe", 0, True
WScript.Sleep 2000

' Iniciar npm run dev (Vite + Electron com nodemon)
' Isso roda Vite com HMR + Electron com auto-restart em src/main/
WshShell.CurrentDirectory = projectDir
WshShell.Run "cmd /c cd /d " & projectDir & " && npm run dev", 0, False
