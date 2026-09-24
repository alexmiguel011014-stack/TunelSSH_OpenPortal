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
