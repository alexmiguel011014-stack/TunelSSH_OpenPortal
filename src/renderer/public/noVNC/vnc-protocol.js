export function isAuthenticationFailure(message) {
  return /authentication failed|security negotiation failed|password.*(?:failed|incorrect)/i.test(
    String(message || ''),
  );
}

export function isExpectedParentMessage(event, parentWindow, attemptId) {
  return event?.source === parentWindow && event?.data?.attemptId === attemptId;
}
