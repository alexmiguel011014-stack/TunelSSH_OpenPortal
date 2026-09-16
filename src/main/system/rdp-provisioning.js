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

const TERMINAL_SERVER_KEY = 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server';

function buildEnableHostingScript() {
  return [
    `Set-ItemProperty -Path '${TERMINAL_SERVER_KEY}' -Name 'fDenyTSConnections' -Value 0`,
    'Enable-NetFirewallRule -DisplayGroup "Remote Desktop"',
  ].join('; ');
}

// PowerShell escapa aspas simples literais dobrando-as — nomes/senhas geradas
// por generatePassword() não incluem aspas, mas um nome de usuário digitado
// à mão poderia.
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function buildCreateCredentialScript(username, password) {
  const user = psQuote(username);
  const pass = psQuote(password);
  return [
    `$sec = ConvertTo-SecureString '${pass}' -AsPlainText -Force`,
    `New-LocalUser -Name '${user}' -Password $sec -PasswordNeverExpires -AccountNeverExpires -ErrorAction Stop`,
    `Add-LocalGroupMember -Group 'Remote Desktop Users' -Member '${user}' -ErrorAction Stop`,
  ].join('; ');
}

// -EncodedCommand em UTF-16LE/Base64 evita todo o inferno de escaping de
// aspas ao atravessar Start-Process -ArgumentList -> nova instância do
// PowerShell.
function runElevatedPowerShell(script, deps = {}) {
  const spawnFn = deps.spawn || spawn;
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

function verifyRdpHostingEnabled(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  return new Promise((resolve) => {
    const proc = spawnFn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-ItemProperty -Path '${TERMINAL_SERVER_KEY}' -Name fDenyTSConnections).fDenyTSConnections`,
    ]);
    let out = '';
    proc.stdout?.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim() === '0'));
    proc.on('error', () => resolve(false));
  });
}

async function enableRdpHosting(deps = {}) {
  await runElevatedPowerShell(buildEnableHostingScript(), deps);
  // Lê o valor de volta em vez de confiar só no exit code 0 — mesma
  // disciplina de verificação usada no resto do projeto (ver GOALS.md).
  return verifyRdpHostingEnabled(deps);
}

async function createRdpCredential(username, password, deps = {}) {
  await runElevatedPowerShell(buildCreateCredentialScript(username, password), deps);
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
  verifyRdpHostingEnabled,
  enableRdpHosting,
  createRdpCredential,
  generatePassword,
};
