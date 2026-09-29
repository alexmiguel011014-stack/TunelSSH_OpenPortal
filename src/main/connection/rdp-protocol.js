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
      ...(Number.isInteger(message.extendedReason)
        ? { extendedReason: message.extendedReason }
        : {}),
      ...(Array.isArray(message.windows)
        ? { windows: message.windows.slice(0, 8).map(sanitizeProbedWindow) }
        : {}),
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

// Janela listada pela sidecar num WindowProbe (GOALS 6, G6-C2): só classe,
// título curto e dono, para saber se havia um diálogo aberto numa espera.
function sanitizeProbedWindow(window) {
  const text = (value) => (typeof value === 'string' ? value.slice(0, 64) : '');
  return {
    className: text(window?.className),
    title: text(window?.title),
    owned: window?.owned === true,
    sameProcess: window?.sameProcess === true,
  };
}

// Códigos do IMsTscAxEvents::OnDisconnected e da ExtendedDisconnectReason
// (Microsoft Learn). O número fica só no log local; o renderer recebe a
// categoria e a mensagem que ela escolhe.
const DISCONNECT_REASON_CATEGORIES = new Map([
  ...[260, 264, 516, 520, 772, 776, 1028, 1288, 1540, 1796, 2052, 2308].map((code) => [
    code,
    'network',
  ]),
  // SSL_ERR_*: login recusado, conta desativada, bloqueada, vencida ou restrita,
  // senha vencida ou que precisa ser trocada, cartão inteligente, autoridade de
  // autenticação fora do ar e credenciais novas exigidas pelo servidor.
  ...[2055, 2567, 2823, 3079, 3335, 3591, 3847, 4615, 6151, 7175, 8455, 8711].map((code) => [
    code,
    'authentication',
  ]),
  // Delegação de credenciais negada pela política e licenciamento.
  ...[2056, 2312, 5639, 5895].map((code) => [code, 'policy']),
  // Certificado do servidor vencido ou ilegível.
  ...[1798, 6919].map((code) => [code, 'certificate']),
]);

function extendedDisconnectCategory(extendedReason) {
  if (extendedReason === 5) return 'replaced';
  if (extendedReason === 4) return 'timeout';
  if (extendedReason === 10 || extendedReason === 768) return 'authentication';
  // 7 (ServerDeniedConnection) fica de fora: o ActiveX real manda 2308 + 7
  // quando o outro lado só fecha o TCP antes de falar RDP (medido em
  // 2026-09-29 contra um alvo local), que é rede, não política.
  if (extendedReason === 8 || extendedReason === 9) return 'policy';
  if (extendedReason >= 256 && extendedReason <= 267) return 'policy';
  return null;
}

function classifyRdpDisconnect({ reasonCode, extendedReason, connected, lastLogonCategory }) {
  const category =
    extendedDisconnectCategory(extendedReason) ?? DISCONNECT_REASON_CATEGORIES.get(reasonCode);
  if (category) return category;
  if (connected) return 'remote-disconnect';
  // A disputa de sessão terminou sem login: ninguém confirmou na tela da
  // sessão, ou quem está no destino recusou.
  if (lastLogonCategory === 'session-contention') return 'contention-ended';
  return lastLogonCategory ?? 'session';
}

// OnLogonError não é só falha: a disputa de sessão (alguém logado no
// destino) e avisos do Winlogon chegam pelo mesmo evento. Nenhum código é
// terminal aqui; o fim vem no OnDisconnected, que herda a categoria.
// waitsForUser pausa os prazos, como o aviso de certificado; resumes volta a
// contar quando o Winlogon segue com o login.
function classifyRdpLogonError(code) {
  if (code === -2) return { category: null, resumes: true };
  if (code === -4 || code === -5) return { category: 'session-contention', waitsForUser: true };
  if (code === 3) return { category: 'logon-warning', waitsForUser: true };
  if ([0, 1, 2, -1073741715, -1073741276].includes(code)) {
    return { category: 'authentication', waitsForUser: true };
  }
  if ([-1, -6, -7, -1073741714].includes(code)) {
    return { category: 'policy', waitsForUser: true };
  }
  return null;
}

// Modo de hospedagem pedido pela máquina (GOALS 6). O padrão é a janela
// compatível: na bateria de 2026-09-29 o modo embutido mostrou a sessão, mas
// sem mouse e teclado. Valor desconhecido cai no padrão.
function resolveRdpHostMode(machine) {
  return ['embedded', 'native-window', 'auto-fallback'].includes(machine?.rdpHostMode)
    ? machine.rdpHostMode
    : 'native-window';
}

function toRendererRdpStatus(status, machineId) {
  const messages = {
    authentication:
      'O PC de destino recusou a conta RDP (usuário ou senha errados, ou conta bloqueada). Confira o usuário e a senha RDP desta máquina.',
    'certificate-warning': 'O Windows requer uma confirmação de segurança na janela RDP.',
    certificate: 'O certificado RDP do PC de destino foi recusado (vencido ou inválido).',
    policy:
      'O Windows do PC de destino recusou esta conta no RDP. Confira se ela foi criada pelo botão Criar conta dedicada.',
    'session-contention':
      'Outra pessoa está usando o PC de destino. Responda na tela da sessão RDP se quer entrar mesmo assim.',
    'logon-warning': 'O Windows do PC de destino mostrou um aviso na tela da sessão RDP.',
    'contention-ended':
      'A sessão RDP terminou antes do login: ninguém confirmou a entrada na tela da sessão, ou quem está no PC de destino recusou. Tente de novo e responda Sim na janela RDP.',
    replaced:
      'A sessão RDP foi encerrada porque outra conexão assumiu o PC de destino (alguém entrou nele).',
    network:
      'A conexão de rede com o RDP do PC de destino falhou ou caiu. Confira se ele está ligado, no Tailscale e com o RDP habilitado.',
    'host-control': 'O componente nativo do RDP não conseguiu hospedar a sessão.',
    'remote-disconnect': 'A sessão RDP foi encerrada pelo destino.',
    session: 'A sessão RDP foi encerrada antes do login.',
    'local-sidecar': 'A comunicação local com o RDP foi interrompida.',
    'sidecar-missing':
      'O componente RDP deste app não foi encontrado. Reinstale o OpenPortal Remote (em desenvolvimento, compile a sidecar).',
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
  classifyRdpDisconnect,
  classifyRdpLogonError,
  resolveRdpHostMode,
  toRendererRdpStatus,
};
