import { describe, it, expect } from 'vitest';
import { isPrivateNetworkHost } from '../net';

describe('isPrivateNetworkHost', () => {
  it('accepts Tailscale CGNAT addresses (100.64.0.0/10)', () => {
    expect(isPrivateNetworkHost('100.64.0.1')).toBe(true);
    expect(isPrivateNetworkHost('100.127.255.255')).toBe(true);
  });

  it('rejects 100.x.x.x addresses outside the /10 CGNAT block', () => {
    expect(isPrivateNetworkHost('100.0.0.1')).toBe(false);
    expect(isPrivateNetworkHost('100.128.0.0')).toBe(false);
  });

  it('accepts hostnames (MagicDNS)', () => {
    expect(isPrivateNetworkHost('my-pc.tailnet.ts.net')).toBe(true);
  });

  it('rejects other IP ranges and empty input', () => {
    expect(isPrivateNetworkHost('8.8.8.8')).toBe(false);
    expect(isPrivateNetworkHost('192.168.1.10')).toBe(false);
    expect(isPrivateNetworkHost('')).toBe(false);
  });
});
