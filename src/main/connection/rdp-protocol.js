'use strict';

// Mensagens trocadas com a sidecar nativa via named pipe (ver sidecar/Program.cs).
// Funções puras — sem side effects — para poderem ser testadas isoladamente
// e reutilizadas tanto por quem envia (rdp-sidecar.js) quanto pelos testes.

function buildConnectCommand({ host, port, username, password }) {
  return { cmd: 'connect', host, port: port || 3389, username, password };
}

function buildResizeCommand({ x, y, w, h }) {
  return { cmd: 'resize', x, y, w, h };
}

function buildDisconnectCommand() {
  return { cmd: 'disconnect' };
}

// A janela nativa da sidecar não é filha do DOM — display:none no <div> do
// React não a esconde. Precisa de um comando explícito para sumir/reaparecer
// ao trocar o foco entre várias máquinas conectadas (GOALS 1 + GOALS 2).
function buildVisibilityCommand({ visible }) {
  return { cmd: 'visibility', visible: !!visible };
}

// Uma linha JSON por comando — o lado C# lê com StreamReader.ReadLine().
function encodeCommand(command) {
  return JSON.stringify(command) + '\n';
}

function parseStatusMessage(line) {
  try {
    const message = JSON.parse(line);
    if (message?.type !== 'status' || typeof message.state !== 'string') return null;
    return message.state;
  } catch {
    return null;
  }
}

module.exports = {
  buildConnectCommand,
  buildResizeCommand,
  buildDisconnectCommand,
  buildVisibilityCommand,
  encodeCommand,
  parseStatusMessage,
};
