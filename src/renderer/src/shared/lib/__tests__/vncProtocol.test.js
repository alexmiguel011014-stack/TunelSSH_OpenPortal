import { describe, expect, it } from 'vitest';
import {
  isAuthenticationFailure,
  isExpectedParentMessage,
  isServerRefusal,
} from '../../../../public/noVNC/vnc-protocol.js';

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
