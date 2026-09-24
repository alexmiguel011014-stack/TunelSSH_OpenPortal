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
    if (
      !['ready', 'connecting', 'warning', 'connected', 'disconnected', 'error'].includes(
        message.state,
      )
    ) {
      return null;
    }
    const safeCategories = new Set([
      'certificate-warning',
      'authentication',
      'policy',
      'network',
      'host-control',
      'timeout',
    ]);
    return {
      state: message.state,
      ...(typeof message.eventName === 'string' ? { eventName: message.eventName } : {}),
      ...(typeof message.stage === 'string' ? { stage: message.stage } : {}),
      ...(safeCategories.has(message.category) ? { category: message.category } : {}),
      ...(Number.isInteger(message.reasonCode) ? { reasonCode: message.reasonCode } : {}),
      ...(typeof message.lifecycleId === 'string' && message.lifecycleId.length <= 64
        ? { lifecycleId: message.lifecycleId }
        : {}),
      ...(['embedded', 'native-window'].includes(message.hostMode)
        ? { hostMode: message.hostMode }
        : {}),
      ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
      ...(typeof message.controlVersion === 'string' && message.controlVersion.length <= 64
        ? { controlVersion: message.controlVersion }
        : {}),
      ...(Number.isInteger(message.connected) ? { connected: message.connected } : {}),
      ...(Number.isSafeInteger(message.formHwnd) ? { formHwnd: message.formHwnd } : {}),
      ...(Number.isSafeInteger(message.controlHwnd) ? { controlHwnd: message.controlHwnd } : {}),
      ...(Number.isSafeInteger(message.parentHwnd) ? { parentHwnd: message.parentHwnd } : {}),
      ...(Number.isSafeInteger(message.requestedParentHwnd)
        ? { requestedParentHwnd: message.requestedParentHwnd }
        : {}),
      ...(Number.isInteger(message.formStyle) ? { formStyle: message.formStyle } : {}),
      ...(Number.isInteger(message.threadId) ? { threadId: message.threadId } : {}),
      ...(Number.isSafeInteger(message.dpiContext) ? { dpiContext: message.dpiContext } : {}),
      ...(Number.isInteger(message.setParentError)
        ? { setParentError: message.setParentError }
        : {}),
      ...(typeof message.positioned === 'boolean' ? { positioned: message.positioned } : {}),
      ...(Number.isInteger(message.sequence) ? { sequence: message.sequence } : {}),
    };
  } catch {
    return null;
  }
}

// Modo de hospedagem pedido pela máquina (GOALS 6): embutido é o padrão, e
// um valor desconhecido cai nele em vez de virar um modo que não existe.
function resolveRdpHostMode(machine) {
  return ['embedded', 'native-window', 'auto-fallback'].includes(machine?.rdpHostMode)
    ? machine.rdpHostMode
    : 'embedded';
}

function toRendererRdpStatus(status, machineId) {
  const messages = {
    authentication: 'Falha de autenticação RDP.',
    'certificate-warning': 'O Windows requer uma confirmação de segurança na janela RDP.',
    policy: 'A política do Windows recusou esta conexão RDP.',
    network: 'A rede RDP mudou durante a conexão.',
    'host-control': 'O componente nativo do RDP não conseguiu hospedar a sessão.',
    'remote-disconnect': 'A sessão RDP foi encerrada pelo destino.',
    session: 'A sessão RDP foi encerrada antes do login.',
    'local-sidecar': 'A comunicação local com o RDP foi interrompida.',
    timeout: 'Uma etapa da conexão RDP excedeu o tempo seguro de espera.',
  };
  return {
    state: ['ready', 'warning'].includes(status.state) ? 'connecting' : status.state,
    nativeState: status.state,
    machineId,
    lifecycleId: status.lifecycleId,
    eventName: status.eventName,
    category: status.category,
    stage: status.stage,
    hostMode: status.hostMode,
    ...(status.controlVersion ? { controlVersion: status.controlVersion } : {}),
    ...(messages[status.category] ? { message: messages[status.category] } : {}),
  };
}

module.exports = {
  buildConnectCommand,
  buildResizeCommand,
  buildDisconnectCommand,
  buildVisibilityCommand,
  encodeCommand,
  parseStatusMessage,
  resolveRdpHostMode,
  toRendererRdpStatus,
};
