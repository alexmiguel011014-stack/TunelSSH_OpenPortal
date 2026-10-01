'use strict';

// Cliente do pipe local do serviço do laboratório (\\.\pipe\OpenPortalLab,
// GOALS 17). Uma conexão por pedido: abre, escreve UMA linha JSON, lê UMA linha de
// resposta e fecha. Só a conta que roda o app (e o SYSTEM) tem acesso ao pipe; o
// serviço confere de novo o SID de cada chamador. Nunca lança e nunca registra
// o conteúdo de um pedido ou de uma resposta (a senha do aluno vem numa delas).

const crypto = require('crypto');
const net = require('net');

const PIPE_PATH = '\\\\.\\pipe\\OpenPortalLab';
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
// O pipe pode sumir por um instante sob uma rajada de pedidos (nenhuma instância livre):
// só um erro ao ABRIR a conexão, antes de qualquer byte enviado, vale outra tentativa.
const CONNECT_RETRIES = 3;
const CONNECT_RETRY_DELAY_MS = 100;

// Os mesmos comandos de lab-service/Core/Protocol.cs.
const COMMANDS = Object.freeze([
  'status',
  'disk-info',
  'student-create',
  'student-delete',
  'student-set-quota',
  'reserve',
  'extend',
  'end',
  'ensure-folder-access',
  'events',
  'note',
]);

function failure(error, message) {
  return { ok: false, error, message };
}

function describeConnectError(err) {
  if (err.code === 'ENOENT') {
    return failure('service-down', 'O serviço do laboratório não está rodando neste PC');
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return failure(
      'unauthorized',
      'Esta conta não tem permissão para falar com o serviço do laboratório',
    );
  }
  return failure(
    'unreachable',
    `Não foi possível falar com o serviço do laboratório (${err.code || err.message})`,
  );
}

function createServiceClient({
  pipePath = PIPE_PATH,
  createConnection = net.createConnection,
  newId = () => crypto.randomBytes(6).toString('hex'),
  retryDelayMs = CONNECT_RETRY_DELAY_MS,
} = {}) {
  function attempt(line, id, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let socket = null;
      let connected = false;
      const chunks = [];
      let size = 0;

      const timer = setTimeout(
        () => finish(failure('timeout', 'O serviço do laboratório não respondeu a tempo')),
        timeoutMs,
      );

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket && !socket.destroyed) socket.destroy();
        resolve(result);
      }

      try {
        socket = createConnection(pipePath);
      } catch (err) {
        finish(describeConnectError(err));
        return;
      }

      socket.on('connect', () => {
        connected = true;
        socket.write(`${line}\n`);
      });
      socket.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES + 1) {
          finish(failure('bad-response', 'Resposta grande demais do serviço do laboratório'));
          return;
        }
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        const newline = text.indexOf('\n');
        if (newline >= 0) finish(parseResponse(text.slice(0, newline), id));
      });
      socket.on('error', (err) => {
        const failed = describeConnectError(err);
        const transient = !connected && (err.code === 'ENOENT' || err.code === 'EBUSY');
        finish(transient ? { ...failed, retryable: true } : failed);
      });
      socket.on('close', () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (text) finish(parseResponse(text, id));
        else
          finish(failure('unreachable', 'O serviço do laboratório fechou a conexão sem responder'));
      });
    });
  }

  function parseResponse(text, id) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return failure('bad-response', 'Resposta inválida do serviço do laboratório');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean') {
      return failure('bad-response', 'Resposta inválida do serviço do laboratório');
    }
    if (body.id !== undefined && body.id !== id) {
      return failure('bad-response', 'Resposta de outro pedido');
    }
    const rest = { ...body };
    delete rest.id;
    return rest;
  }

  async function request(cmd, fields = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!COMMANDS.includes(cmd)) return failure('bad-request', 'Comando desconhecido');
    const id = newId();
    const line = JSON.stringify({ ...fields, id, cmd });
    if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
      return failure('bad-request', 'Pedido grande demais');
    }
    for (let tries = 0; ; tries += 1) {
      const result = await attempt(line, id, timeoutMs);
      if (!result.retryable) return result;
      if (tries >= CONNECT_RETRIES) {
        const final = { ...result };
        delete final.retryable;
        return final;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return {
    request,
    status: (options) => request('status', {}, options),
    diskInfo: (fields, options) => request('disk-info', fields, options),
    studentCreate: ({ label, quotaGb }, options) =>
      request('student-create', { label, quotaGb }, options),
    studentDelete: (account, options) => request('student-delete', { account }, options),
    studentSetQuota: ({ account, quotaGb }, options) =>
      request('student-set-quota', { account, quotaGb }, options),
    reserve: ({ account, startWithinMs, sessionMs }, options) =>
      request('reserve', { account, startWithinMs, sessionMs }, options),
    extend: ({ reservationId, addMs }, options) =>
      request('extend', { reservationId, addMs }, options),
    // O encerramento espera o aviso, o logoff e a conferência: pode levar um minuto.
    end: ({ reservationId, reason }, options = { timeoutMs: 90_000 }) =>
      request('end', { reservationId, reason }, options),
    ensureFolderAccess: (account, options) => request('ensure-folder-access', { account }, options),
    // O diário do serviço (GOALS 19): eventos com número de sequência maior que sinceSeq.
    events: ({ sinceSeq = 0, limit = 100 } = {}, options) =>
      request('events', { sinceSeq, limit }, options),
    // Registra no diário um fato que só o app conhece: quem foi aceito ou removido como gerente.
    note: ({ type, detail }, options) => request('note', { type, detail }, options),
  };
}

module.exports = {
  COMMANDS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PIPE_PATH,
  createServiceClient,
};
