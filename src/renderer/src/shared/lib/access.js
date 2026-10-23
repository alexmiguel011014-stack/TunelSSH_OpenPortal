// "Meu acesso" e os vínculos aluno–conta (GOALS 21), sem React: o que o cartão do aluno mostra e como
// o professor é avisado de que o acesso foi (ou não foi) para o aplicativo do aluno.

import { DEFAULT_CREDENTIAL_NOTICE, SESSION_END_HINT, formatClock, timeLeftText } from './lab';

export const CLIPBOARD_CLEAR_SECONDS = 60;

export function isAccessActive(access, now = Date.now()) {
  return Boolean(access && Number.isFinite(access.endsAt) && access.endsAt > now);
}

// Endereço da rede Tailscale (100.64.0.0/10): quem usa precisa do Tailscale ligado neste computador.
export function isTailscaleAddress(address) {
  const parts = String(address ?? '')
    .trim()
    .split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((part) => parseInt(part, 10));
  return a === 100 && b >= 64 && b <= 127;
}

// As linhas do cartão, ou null quando não há acesso que valha agora (o cartão some no horário de
// término pelo relógio da tela, sem esperar a releitura).
export function describeMyAccess(access, now = Date.now(), timeZone) {
  if (!isAccessActive(access, now)) return null;
  const mustStartByNow = Number.isFinite(access.startBy) && access.startBy > now;
  return {
    pcName: access.hostName,
    address: access.address,
    userName: access.userName,
    startLine: mustStartByNow ? `Comece até ${formatClock(access.startBy, timeZone)}` : '',
    endLine: `Válido até ${formatClock(access.endsAt, timeZone)} (${timeLeftText(access.endsAt, now)})`,
    notice: DEFAULT_CREDENTIAL_NOTICE,
    endHint: SESSION_END_HINT,
    tailscaleHint: isTailscaleAddress(access.address)
      ? 'Este PC fica na rede Tailscale: deixe o Tailscale ligado neste computador antes de conectar.'
      : '',
  };
}

// O resultado de publicar o acesso no app do aluno, para a janela do professor.
// `published` vem do processo principal: { status: 'sent' | 'skipped' | 'failed', message }.
export function describePublication(published) {
  if (!published || typeof published.message !== 'string') return null;
  if (published.status === 'sent') return { tone: 'ok', text: published.message };
  if (published.status === 'skipped') return { tone: 'warn', text: published.message };
  return {
    tone: 'warn',
    text: `Não foi enviado ao app do aluno (${published.message}) — use Copiar mensagem`,
  };
}

// O que mostrar ao lado de um aluno do PC: a conta vinculada, ou o convite para vincular.
export function describeLink(link) {
  if (!link) return { linked: false, text: 'Sem conta no app' };
  return { linked: true, text: link.email || link.fullName || 'Conta vinculada' };
}

export function indexLinks(links) {
  const byAccount = {};
  for (const link of Array.isArray(links) ? links : []) byAccount[link.account] = link;
  return byAccount;
}
