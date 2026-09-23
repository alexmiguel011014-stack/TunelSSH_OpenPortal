'use strict';

// Senha do TightVNC DESTE PC gerenciada pelo app: gerada aqui, gravada no
// TightVNC com UAC (uma vez por PC) e guardada cifrada no config. A cada
// acesso aprovado ela segue para quem pediu dentro da resposta do pedido
// (túnel Tailscale), então ninguém precisa conhecê-la nem digitá-la.
const crypto = require('crypto');
const net = require('net');
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
// do próprio script elevado: o Node do sistema (OpenSSL 3) não tem DES.
function buildApplyVncPasswordScript(password) {
  const bytes = [...Buffer.from(String(password).slice(0, VNC_PASSWORD_LENGTH), 'latin1')];
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Test-Path '${TIGHTVNC_KEY}')) { exit 3 }`,
    '$plain = New-Object byte[] 8',
    `([byte[]]@(${bytes.join(',')})).CopyTo($plain, 0)`,
    '$des = New-Object System.Security.Cryptography.DESCryptoServiceProvider',
    "$des.Mode = 'ECB'",
    "$des.Padding = 'None'",
    '$des.Key = [byte[]](0xE8,0x4A,0xD6,0x60,0xC4,0x72,0x1A,0xE0)',
    '$enc = $des.CreateEncryptor().TransformFinalBlock($plain, 0, 8)',
    `Set-ItemProperty -Path '${TIGHTVNC_KEY}' -Name 'Password' -Value $enc -Type Binary`,
    `Set-ItemProperty -Path '${TIGHTVNC_KEY}' -Name 'UseVncAuthentication' -Value 1 -Type DWord`,
    'Restart-Service -Name tvnserver -Force',
  ].join('; ');
}

function applyHostVncPassword(password, deps = {}) {
  return runElevatedPowerShell(buildApplyVncPasswordScript(password), deps);
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
  generateVncPassword,
  buildApplyVncPasswordScript,
  applyHostVncPassword,
  reverseBits,
  vncAuthResponse,
  verifyVncPassword,
};
