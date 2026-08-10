Get-CimInstance Win32_Process -Filter "Name = 'electron.exe' OR Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'TunelSSH' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
