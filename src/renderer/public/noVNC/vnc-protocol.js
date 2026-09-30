export function isAuthenticationFailure(message) {
  return /authentication failed|security negotiation failed|password.*(?:failed|incorrect)/i.test(
    String(message || ''),
  );
}

// O servidor recusou ANTES de pedir senha (TightVNC com o IP bloqueado após
// várias senhas erradas, loopback desativado, filtro de IP): não é senha
// errada, e pedir outra senha não resolve.
export function isServerRefusal({ context, reason } = {}) {
  return (
    context === 'no security types' ||
    /rejected|loopback|not enabled|too many/i.test(String(reason || ''))
  );
}

export function isExpectedParentMessage(event, parentWindow, attemptId) {
  return event?.source === parentWindow && event?.data?.attemptId === attemptId;
}

// Estado do pedido de senha dentro do iframe (GOALS 8): a senha só vai para o
// noVNC depois que ele pediu (credentialsrequired), uma vez por pedido, e
// nunca depois que a sessão terminou.
export const INITIAL_VIEWER_SESSION = Object.freeze({ waitingForCredentials: false, closed: false });

export function credentialsRequested(session) {
  return session.closed ? session : { ...session, waitingForCredentials: true };
}

export function sessionEnded(session) {
  return { ...session, waitingForCredentials: false, closed: true };
}

// Mensagem já validada por isExpectedParentMessage. Devolve o próximo estado
// e o efeito a aplicar: enviar a senha ao noVNC ou encerrar a sessão.
export function applyParentMessage(session, data) {
  const none = { session, effect: null };
  if (session.closed) return none;
  if (data?.type === 'vnc-credentials') {
    if (!session.waitingForCredentials || !data.password) return none;
    return {
      session: { ...session, waitingForCredentials: false },
      effect: { type: 'send-credentials', password: data.password },
    };
  }
  if (data?.type === 'vnc-cancel-credentials') {
    if (!session.waitingForCredentials) return none;
    return { session: sessionEnded(session), effect: { type: 'close', message: 'Senha VNC não informada' } };
  }
  if (data?.type === 'vnc-disconnect') {
    return {
      session: sessionEnded(session),
      effect: { type: 'close', message: 'Sessão VNC encerrada pelo usuário' },
    };
  }
  return none;
}
