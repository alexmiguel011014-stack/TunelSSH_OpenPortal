'use strict';

// Cache de sessões do lado CLIENTE: idempotente por host, para que o duplo
// mount do React StrictMode reaproveite a mesma conexão em vez de abrir
// duas (mesmo padrão usado antes da remoção do módulo antigo).
const os = require('os');
const { sendConnectRequest, SIGNAL_PORT } = require('../connection/connection-request');
const { isAllowedHost } = require('../connection/net-guard');
const { FileClient } = require('./file-client');

const sessions = new Map(); // sessionId -> { sessionId, host, client }
const connecting = new Map(); // host -> Promise<{sessionId, reused}>
let counter = 0;

function nextSessionId() {
  counter += 1;
  return `ft-${Date.now()}-${counter}`;
}

function findLiveSessionByHost(host) {
  for (const session of sessions.values()) {
    if (session.host === host && !session.client.destroyed) return session;
  }
  return null;
}

async function connect(host, opts = {}) {
  const target = String(host || '').trim();
  if (!target) throw new Error('Endereço IP vazio');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) {
    throw new Error('Endereço IP inválido: use o formato 100.x.x.x');
  }
  if (!isAllowedHost(target)) {
    throw new Error('Endereço fora da rede privada/Tailscale (100.x, 10.x, 192.168.x, 172.16-31.x)');
  }

  if (!opts.force) {
    const existing = findLiveSessionByHost(target);
    if (existing) return { sessionId: existing.sessionId, reused: true };
    if (connecting.has(target)) return connecting.get(target);
  }

  const task = (async () => {
    const fromName = opts.fromName || os.hostname() || 'PC';
    const fromIp = opts.fromIp || '';
    const res = await sendConnectRequest(target, fromName, fromIp, SIGNAL_PORT, { wantsTunnel: true });
    if (!res.approved || !res.socket) {
      throw new Error(res.message || 'Conexão de arquivos recusada pelo PC remoto');
    }

    const client = new FileClient(res.socket);
    const sessionId = nextSessionId();
    sessions.set(sessionId, { sessionId, host: target, client });

    res.socket.on('close', () => sessions.delete(sessionId));
    res.socket.on('error', () => sessions.delete(sessionId));

    return { sessionId, reused: false };
  })();

  connecting.set(target, task);
  try {
    return await task;
  } finally {
    connecting.delete(target);
  }
}

function getClient(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.client.destroyed) {
    throw new Error('Sessão de arquivos não encontrada ou desconectada');
  }
  return session.client;
}

function disconnect(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.client.close();
    sessions.delete(sessionId);
  }
}

module.exports = { connect, getClient, disconnect };
