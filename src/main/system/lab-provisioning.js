'use strict';

// Liga e desliga o modo laboratório neste PC (GOALS 17, G17-I2): copia o serviço
// para uma pasta que só administradores alteram, registra-o como serviço do
// Windows (LocalSystem), liga a hospedagem RDP com o escopo de firewall escolhido
// (G16-D1) e a cota de disco do volume dos perfis. Tudo roda num PowerShell
// elevado (UAC), como o provisionamento de RDP; aqui só se monta o script e se
// lê o estado de volta — nada depende de segredo na linha de comando.

const {
  TAILSCALE_RANGE,
  buildEnableHostingScript,
  psQuote,
  readPowerShell,
  runElevatedPowerShell,
  verifyRdpHostingEnabled,
} = require('./rdp-provisioning');

const SERVICE_NAME = 'OpenPortalLab';
const OWNER_SID_PATTERN = /^S-1-\d+(-\d+)+$/;
const VOLUME_PATTERN = /^[A-Z]:$/;
const SERVICE_EXE_PATTERN = /^[A-Za-z]:\\[^"'<>|*?\r\n]+\\OpenPortalLabService\.exe$/;

function assertValid(condition, message) {
  if (!condition) throw new Error(message);
}

// `serviceSource`: o executável que veio no app (resources/lab-service). `ownerSid`:
// o SID da conta que roda o app, passado por ele (o UAC pode elevar outra conta,
// então o script não consegue descobrir quem é o dono). `studentsOnSite`: a opção E
// do G16-D1 (alunos na mesma rede do PC), que acrescenta a sub-rede local ao
// firewall da 3389.
function buildEnableLabScript({ serviceSource, ownerSid, volume = 'C:', studentsOnSite = false }) {
  assertValid(SERVICE_EXE_PATTERN.test(String(serviceSource)), 'Caminho do serviço inválido');
  assertValid(OWNER_SID_PATTERN.test(String(ownerSid)), 'SID do dono inválido');
  assertValid(VOLUME_PATTERN.test(String(volume)), 'Volume inválido');

  const remoteAddresses = studentsOnSite ? [TAILSCALE_RANGE, 'LocalSubnet'] : [TAILSCALE_RANGE];
  const config = JSON.stringify({ ownerSid, volume });
  return [
    "$ErrorActionPreference = 'Stop'",
    `$name = '${SERVICE_NAME}'`,
    `$source = '${psQuote(serviceSource)}'`,
    "if (-not (Test-Path -LiteralPath $source)) { throw 'O servico do laboratorio nao veio no app instalado' }",
    "$dir = Join-Path $env:ProgramFiles 'OpenPortal Lab'",
    "$exe = Join-Path $dir 'OpenPortalLabService.exe'",
    "$data = Join-Path $env:ProgramData 'OpenPortal\\lab'",
    // Uma atualização troca o executável: o serviço antigo para primeiro.
    '$old = Get-Service -Name $name -ErrorAction SilentlyContinue',
    "if ($old -and $old.Status -ne 'Stopped') { Stop-Service -Name $name -Force; $old.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }",
    // Cópia numa pasta que só SYSTEM e administradores alteram: um serviço LocalSystem
    // nunca roda de uma pasta onde um usuário comum possa trocar o executável.
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    "& icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw 'icacls na pasta do servico' }",
    'Copy-Item -LiteralPath $source -Destination $exe -Force',
    "if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $exe).Hash) { throw 'A copia do servico nao confere com o original' }",
    // Dados e configuração: pasta fechada ao aluno e ao usuário comum.
    'New-Item -ItemType Directory -Force -Path $data | Out-Null',
    "& icacls.exe $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw 'icacls na pasta de dados' }",
    `[IO.File]::WriteAllText((Join-Path $data 'service.json'), '${psQuote(config)}', (New-Object System.Text.UTF8Encoding($false)))`,
    // Hospedagem RDP com o escopo de firewall escolhido.
    buildEnableHostingScript({ remoteAddresses }),
    // Cota de disco: contar e recusar gravação acima do limite, uma vez, no volume dos perfis.
    `& fsutil.exe quota track ${volume} | Out-Null`,
    "if ($LASTEXITCODE -ne 0) { throw 'fsutil quota track' }",
    `& fsutil.exe quota enforce ${volume} | Out-Null`,
    "if ($LASTEXITCODE -ne 0) { throw 'fsutil quota enforce' }",
    // O serviço, entre aspas (caminho com espaço), reiniciando sozinho se cair.
    "if (-not $old) { New-Service -Name $name -BinaryPathName ('\"' + $exe + '\"') -DisplayName 'OpenPortal Lab' -StartupType Automatic | Out-Null }",
    "Set-Service -Name $name -StartupType Automatic -Description 'Contas, cotas e prazos dos alunos do laboratorio (OpenPortal)'",
    '& sc.exe failure $name reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null',
    'Start-Service -Name $name',
  ].join('\n');
}

// "Desabilitar" para e remove o serviço, mas mantém as contas dos alunos e os dados
// deles: as contas são desabilitadas (sem serviço, nada as habilitaria de novo) e a
// lista em state.json continua para o dia em que o modo for ligado outra vez.
function buildDisableLabScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$name = '${SERVICE_NAME}'`,
    "$dir = Join-Path $env:ProgramFiles 'OpenPortal Lab'",
    "$state = Join-Path $env:ProgramData 'OpenPortal\\lab\\state.json'",
    '$svc = Get-Service -Name $name -ErrorAction SilentlyContinue',
    "if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name $name -Force; $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }",
    'if (Test-Path -LiteralPath $state) {',
    '  $students = (Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).students',
    '  foreach ($s in $students) {',
    "    if ($s.account -match '^[a-z0-9]{1,12}$') { Disable-LocalUser -Name $s.account -ErrorAction SilentlyContinue }",
    '  }',
    '}',
    'if ($svc) { & sc.exe delete $name | Out-Null }',
    'if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }',
  ].join('\n');
}

// "missing" | "Running" | "Stopped" | ... (leitura, sem elevação)
async function readServiceStatus(deps = {}) {
  const output = await readPowerShell(
    `$s = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue; if ($s) { [string]$s.Status } else { 'missing' }`,
    deps,
  );
  const last = String(output || '')
    .trim()
    .split(/\r?\n/)
    .pop();
  return last || 'missing';
}

// O SID de quem está logado neste app (o dono do pipe).
async function readOwnerSid(deps = {}) {
  const output = await readPowerShell(
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    deps,
  );
  const sid = String(output || '')
    .trim()
    .split(/\r?\n/)
    .pop();
  return OWNER_SID_PATTERN.test(sid) ? sid : '';
}

module.exports = {
  OWNER_SID_PATTERN,
  SERVICE_NAME,
  buildDisableLabScript,
  buildEnableLabScript,
  readOwnerSid,
  readServiceStatus,
  runElevatedPowerShell,
  verifyRdpHostingEnabled,
};
