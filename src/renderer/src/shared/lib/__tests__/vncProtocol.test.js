import { describe, expect, it } from 'vitest';
import {
  INITIAL_VIEWER_SESSION,
  applyParentMessage,
  credentialsRequested,
  isAuthenticationFailure,
  isExpectedParentMessage,
  isServerRefusal,
  sessionEnded,
} from '../../../../public/noVNC/vnc-protocol.js';

describe('iframe credential contract (GOALS 8)', () => {
  const credentials = { type: 'vnc-credentials', password: 'synthetic-value' };

  it('drops a password sent before noVNC asks for one', () => {
    expect(applyParentMessage(INITIAL_VIEWER_SESSION, credentials)).toEqual({
      session: INITIAL_VIEWER_SESSION,
      effect: null,
    });
  });

  it('hands the password to noVNC once per request and ignores a duplicate', () => {
    const waiting = credentialsRequested(INITIAL_VIEWER_SESSION);
    const first = applyParentMessage(waiting, credentials);
    expect(first.effect).toEqual({ type: 'send-credentials', password: 'synthetic-value' });
    expect(first.session.waitingForCredentials).toBe(false);
    expect(applyParentMessage(first.session, credentials).effect).toBeNull();
  });

  it('ignores an empty password and keeps waiting', () => {
    const waiting = credentialsRequested(INITIAL_VIEWER_SESSION);
    const result = applyParentMessage(waiting, { type: 'vnc-credentials', password: '' });
    expect(result.effect).toBeNull();
    expect(result.session.waitingForCredentials).toBe(true);
  });

  it('ends the attempt on cancel and accepts no password afterwards', () => {
    const waiting = credentialsRequested(INITIAL_VIEWER_SESSION);
    const cancelled = applyParentMessage(waiting, { type: 'vnc-cancel-credentials' });
    expect(cancelled.effect).toEqual({ type: 'close', message: 'Senha VNC não informada' });
    expect(cancelled.session).toEqual({ waitingForCredentials: false, closed: true });
    expect(applyParentMessage(cancelled.session, credentials).effect).toBeNull();
    expect(
      applyParentMessage(INITIAL_VIEWER_SESSION, { type: 'vnc-cancel-credentials' }).effect,
    ).toBeNull();
  });

  it('closes once on disconnect and after an error clears the pending request', () => {
    const waiting = credentialsRequested(INITIAL_VIEWER_SESSION);
    const disconnected = applyParentMessage(waiting, { type: 'vnc-disconnect' });
    expect(disconnected.effect).toEqual({
      type: 'close',
      message: 'Sessão VNC encerrada pelo usuário',
    });
    expect(applyParentMessage(disconnected.session, { type: 'vnc-disconnect' }).effect).toBeNull();

    const failed = sessionEnded(waiting);
    expect(failed.waitingForCredentials).toBe(false);
    expect(applyParentMessage(failed, credentials).effect).toBeNull();
    expect(credentialsRequested(failed)).toBe(failed);
  });

  it('never puts the password in a close effect', () => {
    const waiting = credentialsRequested(INITIAL_VIEWER_SESSION);
    for (const type of ['vnc-cancel-credentials', 'vnc-disconnect']) {
      expect(
        JSON.stringify(applyParentMessage(waiting, { type, password: 'synthetic-value' })),
      ).not.toContain('synthetic-value');
    }
  });
});

describe('noVNC parent message contract', () => {
  it('accepts credentials only from the parent for the active attempt', () => {
    const parentWindow = {};
    const activeAttempt = 'vnc-pc-b-3';
    expect(
      isExpectedParentMessage(
        { source: parentWindow, data: { type: 'vnc-credentials', attemptId: activeAttempt } },
        parentWindow,
        activeAttempt,
      ),
    ).toBe(true);
    expect(
      isExpectedParentMessage(
        { source: {}, data: { type: 'vnc-credentials', attemptId: activeAttempt } },
        parentWindow,
        activeAttempt,
      ),
    ).toBe(false);
    expect(
      isExpectedParentMessage(
        { source: parentWindow, data: { type: 'vnc-credentials', attemptId: 'stale' } },
        parentWindow,
        activeAttempt,
      ),
    ).toBe(false);
  });

  it('classifies an authentication failure without retaining credential text', () => {
    expect(isAuthenticationFailure('Security negotiation failed: Authentication failed')).toBe(
      true,
    );
    expect(isAuthenticationFailure('WebSocket connection closed')).toBe(false);
  });

  it('tells a TightVNC refusal (IP blocked after wrong passwords) apart from a wrong password', () => {
    expect(
      isServerRefusal({
        context: 'no security types',
        reason: 'Your connection has been rejected',
      }),
    ).toBe(true);
    expect(isServerRefusal({ reason: 'Sorry, loopback connections are not enabled' })).toBe(true);
    expect(
      isServerRefusal({
        context: 'security result',
        reason: 'Authentication failed from 100.66.218.65',
      }),
    ).toBe(false);
  });
});
