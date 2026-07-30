$log = "D:\ProjetosVS\TunelSSH\vite-run.log"
$err = "D:\ProjetosVS\TunelSSH\vite-run-err.log"
Set-Location "D:\ProjetosVS\TunelSSH"
$p = Start-Process -NoNewWindow -FilePath "node" -ArgumentList "node_modules\vite\bin\vite.js --config src/renderer/vite.config.js --host 127.0.0.1" -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
$p.Id | Out-File "D:\ProjetosVS\TunelSSH\vite.pid" -Encoding ascii
Write-Host "Vite PID: $($p.Id)"
