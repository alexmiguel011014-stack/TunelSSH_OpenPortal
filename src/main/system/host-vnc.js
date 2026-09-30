'use strict';

// Senha do TightVNC DESTE PC gerenciada pelo app: gerada aqui, gravada no
// TightVNC com UAC (uma vez por PC) e guardada cifrada no config. A cada
// acesso aprovado ela segue para quem pediu dentro da resposta do pedido
// (túnel Tailscale), então ninguém precisa conhecê-la nem digitá-la.
const crypto = require('crypto');
const net = require('net');
const { execFile: nodeExecFile, spawn: nodeSpawn } = require('child_process');
const { runElevatedPowerShell } = require('./rdp-provisioning');

const TIGHTVNC_KEY = 'HKLM:\\SOFTWARE\\TightVNC\\Server';
// A autenticação VNC só usa os 8 primeiros caracteres da senha.
const VNC_PASSWORD_LENGTH = 8;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateVncPassword(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < VNC_PASSWORD_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// O TightVNC guarda a senha no registro cifrada com DES e a chave fixa do
// VNC (já com os bits invertidos para DES padrão). O .NET faz o DES dentro
// do próprio script elevado: o Node do sistema (OpenSSL 3) não tem DES. A
// senha chega em $secret (runElevatedPowerShell), nunca no texto do script.
const VNC_DES_STEPS = [
  '$plain = New-Object byte[] 8',
  '$pw = [Text.Encoding]::GetEncoding(28591).GetBytes([string]$secret)',
  '[Array]::Copy($pw, $plain, [Math]::Min($pw.Length, 8))',
  '$des = New-Object System.Security.Cryptography.DESCryptoServiceProvider',
  "$des.Mode = 'ECB'",
  "$des.Padding = 'None'",
  '$des.Key = [byte[]](0xE8,0x4A,0xD6,0x60,0xC4,0x72,0x1A,0xE0)',
  '$enc = $des.CreateEncryptor().TransformFinalBlock($plain, 0, 8)',
];

function buildApplyVncPasswordScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Test-Path '${TIGHTVNC_KEY}')) { exit 3 }`,
    ...VNC_DES_STEPS,
    `Set-ItemProperty -Path '${TIGHTVNC_KEY}' -Name 'Password' -Value $enc -Type Binary`,
    `Set-ItemProperty -Path '${TIGHTVNC_KEY}' -Name 'UseVncAuthentication' -Value 1 -Type DWord`,
    // GOALS 10: só conexões locais; outros PCs chegam pelo túnel da 18902.
    `Set-ItemProperty -Path '${TIGHTVNC_KEY}' -Name 'AllowLoopback' -Value 1 -Type DWord`,
    `Set-ItemProperty -Path '${TIGHTVNC_KEY}' -Name 'LoopbackOnly' -Value 1 -Type DWord`,
    'Restart-Service -Name tvnserver -Force',
  ].join('; ');
}

function applyHostVncPassword(password, deps = {}) {
  return runElevatedPowerShell(buildApplyVncPasswordScript(), deps, {
    secret: String(password).slice(0, VNC_PASSWORD_LENGTH),
  });
}

// Caminho de volta: aceitar de novo VNC direto da rede (cliente VNC comum).
// AllowLoopback continua 1, então o túnel segue funcionando se for religado.
function buildAllowDirectVncScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Test-Path '${TIGHTVNC_KEY}')) { exit 3 }`,
    `Set-ItemProperty -Path '${TIGHTVNC_KEY}' -Name 'LoopbackOnly' -Value 0 -Type DWord`,
    'Restart-Service -Name tvnserver -Force',
  ].join('; ');
}

function allowDirectVnc(deps = {}) {
  return runElevatedPowerShell(buildAllowDirectVncScript(), deps);
}

// Caminho do tvnserver.exe a partir do ImagePath do serviço (`reg query`).
function parseServiceExe(regOutput) {
  const match = /ImagePath\s+REG_\w+\s+(.+)/.exec(String(regOutput || ''));
  if (!match) return '';
  const value = match[1].trim();
  const quoted = /^"([^"]+)"/.exec(value);
  return quoted ? quoted[1] : value.split(/\s+-/)[0].trim();
}

// O Restart-Service fecha o ícone do TightVNC na bandeja, que só voltaria no
// próximo login: reabre o painel do serviço na sessão do usuário, sem
// elevação, se ainda não houver um aberto. Melhor esforço, nunca lança.
async function relaunchTightVncTray(deps = {}) {
  const execFile = deps.execFile || nodeExecFile;
  const spawn = deps.spawn || nodeSpawn;
  const run = (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) =>
        resolve(err ? '' : String(stdout)),
      );
    });
  // CSV: nome, PID, sessão... — o serviço em si roda na sessão "Services".
  const tasks = await run('tasklist', ['/FI', 'IMAGENAME eq tvnserver.exe', '/FO', 'CSV', '/NH']);
  const trayOpen = tasks
    .split(/\r?\n/)
    .some((line) => line.startsWith('"tvnserver.exe"') && !line.includes('"Services"'));
  if (trayOpen) return false;
  const exe = parseServiceExe(
    await run('reg', [
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Services\\tvnserver',
      '/v',
      'ImagePath',
    ]),
  );
  if (!exe) return false;
  try {
    spawn(exe, ['-controlservice', '-slave'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

function reverseBits(byte) {
  let out = 0;
  for (let i = 0; i < 8; i++) out = (out << 1) | ((byte >> i) & 1);
  return out;
}

// Resposta ao desafio da autenticação VNC: DES com a senha como chave, com os
// bits de cada byte invertidos (herança do d3des do VNC).
function vncAuthResponse(password, challenge, createCipheriv = crypto.createCipheriv) {
  const key = Buffer.alloc(8);
  Buffer.from(String(password), 'latin1').copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(key[i]);
  const des = createCipheriv('des-ecb', key, null);
  des.setAutoPadding(false);
  return Buffer.concat([des.update(challenge), des.final()]);
}

// Depois de aplicar: a senha nova já está no TightVNC, então é guardada sempre
// que o login em 127.0.0.1 funcionou; "só local" só é declarado quando a 5900
// de fato não atende mais pela rede.
function decideSetupOutcome({ verdict, exposure }) {
  if (verdict !== 'ok') return { store: false, localOnly: false, error: verdict };
  if (exposure === 'open') return { store: true, localOnly: false, error: 'exposed' };
  return { store: true, localOnly: true, error: '' };
}

// Só lê a versão e a lista de tipos de segurança, nunca autentica: diz se o
// TightVNC atende quem chega por aquele endereço. 'open' | 'refused' | 'closed'.
function probeVncExposure(host, port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let sentVersion = false;
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('closed'));
    socket.on('error', () => done('closed'));
    socket.on('close', () => done('closed'));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!sentVersion) {
        if (buffer.length < 12) return;
        buffer = buffer.subarray(12);
        sentVersion = true;
        socket.write('RFB 003.008\n');
      }
      if (buffer.length < 1) return;
      done(buffer[0] === 0 ? 'refused' : 'open');
    });
  });
}

// Só o handshake RFB até o SecurityResult, sem abrir sessão: confirma que o
// TightVNC aceita a senha. 'ok' | 'wrong' | 'refused' (IP bloqueado etc.) |
// 'no-auth' (servidor sem senha) | 'error'.
function verifyVncPassword(host, port, password, opts = {}) {
  const { timeoutMs = 5000, createCipheriv = crypto.createCipheriv } = opts;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let stage = 'version';
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('error'));
    socket.on('error', () => done('error'));
    socket.on('close', () => done('error'));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === 'version') {
          if (buffer.length < 12) return;
          buffer = buffer.subarray(12);
          socket.write('RFB 003.008\n');
          stage = 'types';
        } else if (stage === 'types') {
          if (buffer.length < 1) return;
          if (buffer[0] === 0) return done('refused');
          const count = buffer[0];
          if (buffer.length < 1 + count) return;
          const types = [...buffer.subarray(1, 1 + count)];
          buffer = buffer.subarray(1 + count);
          if (!types.includes(2)) return done(types.includes(1) ? 'no-auth' : 'error');
          socket.write(Buffer.from([2]));
          stage = 'challenge';
        } else if (stage === 'challenge') {
          if (buffer.length < 16) return;
          socket.write(vncAuthResponse(password, buffer.subarray(0, 16), createCipheriv));
          buffer = buffer.subarray(16);
          stage = 'result';
        } else {
          if (buffer.length < 4) return;
          return done(buffer.readUInt32BE(0) === 0 ? 'ok' : 'wrong');
        }
      }
    });
  });
}

module.exports = {
  VNC_DES_STEPS,
  generateVncPassword,
  buildApplyVncPasswordScript,
  applyHostVncPassword,
  buildAllowDirectVncScript,
  allowDirectVnc,
  decideSetupOutcome,
  parseServiceExe,
  relaunchTightVncTray,
  probeVncExposure,
  reverseBits,
  vncAuthResponse,
  verifyVncPassword,
};
