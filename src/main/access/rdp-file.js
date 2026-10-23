'use strict';

// Abre a Área de Trabalho Remota do Windows (mstsc.exe) para o aluno (GOALS 21). Os dados vêm do
// Supabase, então nada deles entra "solto" em lugar nenhum:
//  - o arquivo .rdp só leva o endereço e o usuário, validados; um valor com quebra de linha ou
//    caractere estranho recusa o pedido em vez de abrir uma linha de configuração a mais;
//  - a SENHA nunca vai no arquivo nem numa linha de comando: o Windows pede, e a pessoa cola;
//  - mstsc.exe é iniciado com uma lista de argumentos (sem shell) e o arquivo é apagado em 1 minuto.

const nodeFs = require('fs');
const nodeOs = require('os');
const nodePath = require('path');
const crypto = require('crypto');
const { spawn: nodeSpawn } = require('child_process');

const DELETE_AFTER_MS = 60 * 1000;

const ADDRESS_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,250}[A-Za-z0-9])?(?::\d{1,5})?$/;
const USER_PATTERN = /^[A-Za-z0-9._ $-]{1,40}(?:\\[A-Za-z0-9._ $-]{1,40})?$/;

function cleanAddress(value) {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value) ? value : null;
}

function cleanUserName(value) {
  return typeof value === 'string' && value.length <= 80 && USER_PATTERN.test(value) ? value : null;
}

// O texto do arquivo, ou null quando o endereço ou o usuário não passam na validação.
function buildRdpFile({ address, userName }) {
  const host = cleanAddress(address);
  const user = cleanUserName(userName);
  if (!host || !user) return null;
  return [
    `full address:s:${host}`,
    `username:s:${user}`,
    'prompt for credentials:i:1',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    'screen mode id:i:1',
    '',
  ].join('\r\n');
}

function createRdpLauncher({
  platform = process.platform,
  tmpdir = nodeOs.tmpdir,
  fs = nodeFs,
  spawn = nodeSpawn,
  randomName = () => crypto.randomBytes(8).toString('hex'),
  setTimeoutFn = setTimeout,
  log = () => {},
} = {}) {
  function open({ address, userName }) {
    if (platform !== 'win32') {
      return {
        ok: false,
        error: 'unsupported',
        message: 'A Área de Trabalho Remota só existe no Windows.',
      };
    }
    const text = buildRdpFile({ address, userName });
    if (!text) {
      return {
        ok: false,
        error: 'bad-access',
        message: 'Os dados do acesso não são válidos. Peça ao professor para liberar de novo.',
      };
    }
    const file = nodePath.join(tmpdir(), `openportal-${randomName()}.rdp`);
    try {
      fs.writeFileSync(file, text);
      const child = spawn('mstsc.exe', [file], { detached: true, stdio: 'ignore' });
      child.on?.('error', (err) => log(`mstsc.exe não abriu: ${err.message}`));
      child.unref?.();
    } catch (err) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
      return {
        ok: false,
        error: 'spawn-failed',
        message: `Não consegui abrir a Área de Trabalho Remota: ${err.message}`,
      };
    }
    const remover = setTimeoutFn(() => {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }, DELETE_AFTER_MS);
    remover?.unref?.();
    log('Área de Trabalho Remota aberta para o acesso liberado');
    return { ok: true };
  }

  return { open };
}

module.exports = { DELETE_AFTER_MS, buildRdpFile, cleanAddress, cleanUserName, createRdpLauncher };
