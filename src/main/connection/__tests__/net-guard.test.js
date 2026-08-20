import { describe, it, expect } from 'vitest';
import { isAllowedHost } from '../net-guard.js';

describe('isAllowedHost', () => {
  it('allows Tailscale CGNAT addresses (100.64.0.0/10)', () => {
    expect(isAllowedHost('100.64.0.1')).toBe(true);
    expect(isAllowedHost('100.100.50.1')).toBe(true);
    expect(isAllowedHost('100.127.255.255')).toBe(true);
  });

  it('rejects 100.x.x.x addresses outside the /10 CGNAT block', () => {
    // Regression: these are ordinary public IPs, not Tailscale peers, even
    // though they share the same first octet.
    expect(isAllowedHost('100.0.0.1')).toBe(false);
    expect(isAllowedHost('100.63.255.255')).toBe(false);
    expect(isAllowedHost('100.128.0.0')).toBe(false);
    expect(isAllowedHost('100.255.255.255')).toBe(false);
  });

  it('rejects private LAN and public ranges', () => {
    expect(isAllowedHost('192.168.1.10')).toBe(false);
    expect(isAllowedHost('10.0.0.5')).toBe(false);
    expect(isAllowedHost('172.16.0.1')).toBe(false);
    expect(isAllowedHost('8.8.8.8')).toBe(false);
  });

  it('rejects malformed or empty input', () => {
    expect(isAllowedHost('')).toBe(false);
    expect(isAllowedHost(null)).toBe(false);
    expect(isAllowedHost('not-an-ip')).toBe(false);
    expect(isAllowedHost('100.64.1')).toBe(false);
  });

  it('rejects localhost outside development mode', () => {
    expect(isAllowedHost('127.0.0.1')).toBe(false);
    expect(isAllowedHost('localhost')).toBe(false);
  });
});
