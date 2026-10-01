'use strict';

// Cliente de uma mensagem `lab-*`: abre a conexão na porta de sinalização do PC
// gerenciado, escreve o pedido já validado (protocol.buildRequest) e lê a
// resposta até o PC fechar. Nunca lança nem rejeita: o resultado é sempre
// { ok: true, response } ou { ok: false, error: 'unreachable' | 'timeout' |
// 'bad-response', message }.

const net = require('net');
const protocol = require('./protocol');

const SIGNAL_PORT = 18902;

function sendLabRequest(
  host,
  built,
  { port = SIGNAL_PORT, timeoutMs = 3000, createConnection = net.createConnection } = {},
) {
  return new Promise((resolve) => {
    if (!built?.ok) {
      resolve({
        ok: false,
        error: 'bad-request',
        message: built?.message || 'Pedido inválido',
      });
      return;
    }

    let settled = false;
    let socket = null;
    const chunks = [];
    let size = 0;

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: 'timeout',
          message: `Sem resposta de ${host} em ${timeoutMs / 1000}s`,
        }),
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
      socket = createConnection({ host, port });
    } catch (err) {
      finish({ ok: false, error: 'unreachable', message: err.message });
      return;
    }

    socket.on('connect', () => socket.write(built.text));
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > protocol.MAX_RESPONSE_BYTES) {
        finish({
          ok: false,
          error: 'bad-response',
          message: 'Resposta grande demais',
        });
        return;
      }
      chunks.push(chunk);
    });
    socket.on('error', (err) => {
      finish({
        ok: false,
        error: 'unreachable',
        message: `Não foi possível contactar ${host}:${port} (${err.code || err.message})`,
      });
    });
    socket.on('close', () => {
      if (settled) return;
      const parsed = protocol.parseResponse(Buffer.concat(chunks));
      if (!parsed.ok) finish({ ok: false, error: 'bad-response', message: parsed.message });
      else finish({ ok: true, response: parsed.response });
    });
  });
}

// lab-folder: o PC abre a pasta do aluno e, depois do "ok", a MESMA conexão passa a ser
// a sessão de arquivos somente leitura. Por isso o socket não é fechado quando a
// resposta é de sucesso: ele é entregue a quem chamou. O PC pode levar até dois minutos
// (acesso da pasta é reaplicado antes). Nunca lança nem rejeita.
function openLabFolder(
  host,
  built,
  { port = SIGNAL_PORT, timeoutMs = 130_000, createConnection = net.createConnection } = {},
) {
  return new Promise((resolve) => {
    if (!built?.ok) {
      resolve({ ok: false, error: 'bad-request', message: built?.message || 'Pedido inválido' });
      return;
    }
    let settled = false;
    let socket = null;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: 'timeout',
          message: `Sem resposta de ${host} em ${Math.round(timeoutMs / 1000)}s`,
        }),
      timeoutMs,
    );

    function finish(result, keepSocket = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && !keepSocket && !socket.destroyed) socket.destroy();
      resolve(result);
    }

    try {
      socket = createConnection({ host, port });
    } catch (err) {
      finish({ ok: false, error: 'unreachable', message: err.message });
      return;
    }

    socket.on('connect', () => socket.write(built.text));
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > protocol.MAX_RESPONSE_BYTES) {
        finish({ ok: false, error: 'bad-response', message: 'Resposta grande demais' });
        return;
      }
      const parsed = protocol.parseResponse(buffer);
      if (!parsed.ok) return; // ainda incompleta (ou inválida: o fechamento resolve)
      if (parsed.response.ok) {
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        finish({ ok: true, response: parsed.response, socket }, true);
      } else {
        finish({ ok: true, response: parsed.response });
      }
    });
    socket.on('error', (err) => {
      finish({
        ok: false,
        error: 'unreachable',
        message: `Não foi possível contactar ${host}:${port} (${err.code || err.message})`,
      });
    });
    socket.on('close', () => {
      finish({
        ok: false,
        error: 'bad-response',
        message: 'O PC fechou a conexão sem responder',
      });
    });
  });
}

module.exports = { openLabFolder, sendLabRequest, SIGNAL_PORT };
