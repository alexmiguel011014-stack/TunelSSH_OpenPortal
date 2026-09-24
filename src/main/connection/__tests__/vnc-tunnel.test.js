import { describe, expect, it } from 'vitest';
import { VncTunnelTokens, MAX_TOKEN_AGE_MS } from '../vnc-tunnel.js';
import { MAX_FAILURES } from '../session-password.js';

describe('VncTunnelTokens', () => {
  it('accepts a token only from the IP it was issued to', () => {
    const tokens = new VncTunnelTokens();
    const token = tokens.issue('100.66.218.65');
    expect(tokens.check(token, '100.66.218.65')).toBe('ok');
    expect(tokens.check(token, '100.81.199.56')).toBe('wrong');
  });

  it('rejects forged, revoked and expired tokens', () => {
    let now = 0;
    const tokens = new VncTunnelTokens({ now: () => now });
    expect(tokens.check('forged', '100.1.1.1')).toBe('wrong');
    const revoked = tokens.issue('100.1.1.2');
    tokens.revoke(revoked);
    expect(tokens.check(revoked, '100.1.1.2')).toBe('wrong');
    const old = tokens.issue('100.1.1.3');
    now += MAX_TOKEN_AGE_MS + 1;
    expect(tokens.check(old, '100.1.1.3')).toBe('wrong');
  });

  it('locks an IP out after repeated bad tokens, even for a valid one', () => {
    const tokens = new VncTunnelTokens();
    const token = tokens.issue('100.1.1.1');
    for (let i = 1; i < MAX_FAILURES; i++) expect(tokens.check('bad', '100.1.1.1')).toBe('wrong');
    expect(tokens.check('bad', '100.1.1.1')).toBe('locked');
    expect(tokens.check(token, '100.1.1.1')).toBe('locked');
  });

  it('issues distinct 256-bit tokens', () => {
    const tokens = new VncTunnelTokens();
    const a = tokens.issue('100.1.1.1');
    const b = tokens.issue('100.1.1.1');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
