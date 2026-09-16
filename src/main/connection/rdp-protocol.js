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

// Uma linha JSON por comando — o lado C# lê com StreamReader.ReadLine().
function encodeCommand(command) {
  return JSON.stringify(command) + '\n';
}

module.exports = {
  buildConnectCommand,
  buildResizeCommand,
  buildDisconnectCommand,
  encodeCommand,
};
