# Verifica a regra de firewall do File Server (porta 5001).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\verify-firewall-rule.ps1
# Exit code 0 = regra OK; 1 = regra ausente ou com configuracao inadequada.

$ErrorActionPreference = 'Stop'
$name = 'OpenPortal Remote - File Server'

$rules = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
if ($rules.Count -eq 0) {
  Write-Host "FALHA: regra '$name' nao existe. Reinstale o app (customInstall recria a regra)." -ForegroundColor Red
  exit 1
}

foreach ($rule in $rules) {
  $portFilter = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule)
  $appFilter = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule)
  $enabled = $rule.Enabled.ToString()
  $direction = $rule.Direction.ToString()
  $action = $rule.Action.ToString()
  $profiles = $rule.Profile.ToString()
  $protocols = @($portFilter | ForEach-Object { $_.Protocol.ToString() })
  $ports = @($portFilter | ForEach-Object { $_.LocalPort.ToString() })
  $programs = @($appFilter | ForEach-Object { $_.Program.ToString() })

  $hasExpectedProgram = $programs | Where-Object {
    $_ -eq 'Any' -or $_ -match '(?i)\\OpenPortal Remote\.exe$'
  }
  $ok = ($enabled -eq 'True') -and
        ($direction -eq 'Inbound') -and
        ($action -eq 'Allow') -and
        ($profiles -match '(?i)Public|Any') -and
        ($protocols -contains 'TCP') -and
        ($ports -contains '5001') -and
        $hasExpectedProgram

  if ($ok) {
    Write-Host "OK: regra '$name' ativa, entrada (in), allow, profile=$profiles (inclui Public), TCP/5001, programa=$($programs -join ',')" -ForegroundColor Green
    exit 0
  }
}

Write-Host "FALHA: regra encontrada, mas com configuracao inadequada. Reinstale o app como administrador." -ForegroundColor Red
foreach ($rule in $rules) {
  $portFilter = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule)
  $appFilter = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule)
  Write-Host "  Enabled=$($rule.Enabled) Direction=$($rule.Direction) Action=$($rule.Action) Profile=$($rule.Profile) Port=$(@($portFilter | ForEach-Object { $_.LocalPort }) -join ',') Protocol=$(@($portFilter | ForEach-Object { $_.Protocol }) -join ',') Program=$(@($appFilter | ForEach-Object { $_.Program }) -join ',')" -ForegroundColor Red
}
exit 1
