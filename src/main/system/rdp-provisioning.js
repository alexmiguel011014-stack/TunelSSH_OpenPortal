'use strict';

// Provisionamento de hospedagem RDP nesta máquina (GOALS 2, itens "Provisioning").
// Ambas as ações abaixo alteram estado do Windows (registro, contas locais) e
// só rodam quando o usuário clica no botão correspondente em ConfigPanel — o
// UAC do Windows pede a aprovação dele antes de qualquer coisa executar.
// Funções puras de montagem de comando ficam separadas das que de fato
// disparam o processo, pra serem testáveis sem shell-out real (mesmo padrão
// de rdp-protocol.js/rdp-sidecar.js).

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TERMINAL_SERVER_KEY = 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server';
// Grupo "Remote Desktop Users" pelo SID: o nome muda com o idioma do Windows
// ("Usuários da área de trabalho remota" em pt-BR).
const REMOTE_DESKTOP_USERS_SID = 'S-1-5-32-555';
// Regra própria só para a faixa do Tailscale, em vez de ligar o grupo "Remote
// Desktop" do Windows: aquele abre a 3389 em qualquer rede (perfil Any) e
// também tem o nome traduzido, então nem era encontrado num Windows em pt-BR.
const FIREWALL_RULE_NAME = 'OpenPortal-RDP-Tailscale';
const TAILSCALE_RANGE = '100.64.0.0/10';

function buildEnableHostingScript() {
  const ruleSettings = `-Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 -RemoteAddress '${TAILSCALE_RANGE}' -Profile Any`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `Set-ItemProperty -Path '${TERMINAL_SERVER_KEY}' -Name 'fDenyTSConnections' -Value 0`,
    'Start-Service -Name TermService',
    `if (Get-NetFirewallRule -Name '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue) { Set-NetFirewallRule -Name '${FIREWALL_RULE_NAME}' -Enabled True ${ruleSettings} } else { New-NetFirewallRule -Name '${FIREWALL_RULE_NAME}' -DisplayName 'OpenPortal RDP (somente Tailscale)' ${ruleSettings} | Out-Null }`,
  ].join('; ');
}

// PowerShell escapa aspas simples literais dobrando-as — nomes/senhas geradas
// por generatePassword() não incluem aspas, mas um nome de usuário digitado
// à mão poderia.
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

// A senha chega ao script elevado em $secret (ver runElevatedPowerShell).
function buildCreateCredentialScript(username) {
  const user = psQuote(username);
  return [
    "$ErrorActionPreference = 'Stop'",
    '$sec = ConvertTo-SecureString $secret -AsPlainText -Force',
    `New-LocalUser -Name '${user}' -Password $sec -PasswordNeverExpires -AccountNeverExpires`,
    `Add-LocalGroupMember -SID '${REMOTE_DESKTOP_USERS_SID}' -Member '${user}'`,
  ].join('; ');
}

// -EncodedCommand em UTF-16LE/Base64 evita todo o inferno de escaping de
// aspas ao atravessar Start-Process -ArgumentList -> nova instância do
// PowerShell.
function spawnElevated(script, spawnFn) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const proc = spawnFn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`,
    ]);
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell elevado saiu com código ${code}`));
    });
  });
}

// Um segredo (senha do TightVNC ou da conta RDP) nunca vai na linha de
// comando, que outros processos leem e que pode parar em logs de auditoria:
// vai num arquivo temporário do perfil do usuário, que o script elevado lê
// para $secret e apaga na hora. O Node apaga de novo no fim (UAC recusado).
async function runElevatedPowerShell(script, deps = {}, { secret } = {}) {
  const spawnFn = deps.spawn || spawn;
  if (secret === undefined) return spawnElevated(script, spawnFn);
  const fsApi = deps.fs || fs;
  const dir = fsApi.mkdtempSync(path.join(os.tmpdir(), 'openportal-'));
  const file = psQuote(path.join(dir, 'secret.txt'));
  try {
    fsApi.writeFileSync(path.join(dir, 'secret.txt'), String(secret), 'utf8');
    const preamble = `$ErrorActionPreference = 'Stop'; $secret = [IO.File]::ReadAllText('${file}'); Remove-Item -LiteralPath '${file}' -Force`;
    return await spawnElevated(`${preamble}; ${script}`, spawnFn);
  } finally {
    fsApi.rmSync(dir, { recursive: true, force: true });
  }
}

// Leitura sem elevação. O Start-Process -Verb RunAs não devolve o código de
// saída do script elevado, então só o estado lido de volta diz se deu certo.
function readPowerShell(command, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  return new Promise((resolve) => {
    const proc = spawnFn('powershell.exe', ['-NoProfile', '-Command', command]);
    let out = '';
    proc.stdout?.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim()));
    proc.on('error', () => resolve(''));
  });
}

// "<fDenyTSConnections>|<regra habilitada ou missing>|<status do TermService>"
function parseHostingState(output) {
  const [deny, ruleEnabled, service] = String(output || '')
    .trim()
    .split('|');
  return deny === '0' && ruleEnabled === 'True' && service === 'Running';
}

function verifyRdpHostingEnabled(deps = {}) {
  return readPowerShell(
    [
      `$deny = (Get-ItemProperty -Path '${TERMINAL_SERVER_KEY}' -Name fDenyTSConnections).fDenyTSConnections`,
      `$rule = Get-NetFirewallRule -Name '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue`,
      '$service = (Get-Service -Name TermService).Status',
      "[string]$deny + '|' + $(if ($rule) { [string]$rule.Enabled } else { 'missing' }) + '|' + [string]$service",
    ].join('; '),
    deps,
  ).then(parseHostingState);
}

async function enableRdpHosting(deps = {}) {
  await runElevatedPowerShell(buildEnableHostingScript(), deps);
  // Lê o estado de volta em vez de confiar só no exit code 0 — mesma
  // disciplina de verificação usada no resto do projeto (ver GOALS.md).
  return verifyRdpHostingEnabled(deps);
}

function verifyRdpCredential(username, deps = {}) {
  return readPowerShell(
    `@(Get-LocalGroupMember -SID '${REMOTE_DESKTOP_USERS_SID}' | Where-Object { $_.Name -like '*\\${psQuote(username)}' }).Count`,
    deps,
  ).then((count) => count === '1');
}

async function createRdpCredential(username, password, deps = {}) {
  await runElevatedPowerShell(buildCreateCredentialScript(username), deps, { secret: password });
  if (!(await verifyRdpCredential(username, deps))) {
    throw new Error(
      'A conta não apareceu no grupo de Área de Trabalho Remota (UAC recusado, nome já usado ou senha fora da política do Windows).',
    );
  }
}

// Senha aleatória forte para a conta dedicada de RDP — gerada uma vez no
// provisionamento, nunca reaproveitando a senha pessoal do usuário logado.
function generatePassword(length = 24) {
  return crypto.randomBytes(length).toString('base64').slice(0, length);
}

module.exports = {
  buildEnableHostingScript,
  buildCreateCredentialScript,
  runElevatedPowerShell,
  parseHostingState,
  verifyRdpHostingEnabled,
  enableRdpHosting,
  verifyRdpCredential,
  createRdpCredential,
  generatePassword,
};
