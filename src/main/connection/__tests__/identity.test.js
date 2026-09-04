import { describe, it, expect, vi } from 'vitest';
import { resolveIdentity, normalizeIp, isAllowed } from '../identity.js';

describe('normalizeIp', () => {
  it('strips the IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:100.64.1.2')).toBe('100.64.1.2');
  });

  it('passes plain IPv4 through unchanged', () => {
    expect(normalizeIp('100.64.1.2')).toBe('100.64.1.2');
  });

  it('returns empty for falsy input', () => {
    expect(normalizeIp('')).toBe('');
    expect(normalizeIp(null)).toBe('');
  });
});

describe('isAllowed', () => {
  it('matches a listed identity', () => {
    expect(isAllowed('prof@example.com', ['prof@example.com', 'e1@example.com'])).toBe(true);
  });

  it('rejects an identity not on the list', () => {
    expect(isAllowed('stranger@example.com', ['prof@example.com'])).toBe(false);
  });

  it('never matches the literal "unknown" sentinel, even if misconfigured onto the list', () => {
    expect(isAllowed('unknown', ['unknown'])).toBe(false);
  });
});

// identity.js accepts execFile/existsSync as injectable deps specifically so
// these tests can fake the `tailscale whois` shell-out directly, instead of
// relying on vi.mock('child_process')/vi.mock('fs') — module-mocking a
// plain require() of a Node builtin isn't reliably intercepted in this
// project's Vitest setup (confirmed: real tailscale.exe kept getting invoked
// even with those modules mocked).
describe('resolveIdentity', () => {
  it('returns the LoginName from a successful whois call', async () => {
    const execFile = vi.fn((_bin, _args, _opts, cb) => {
      cb(null, JSON.stringify({ UserProfile: { LoginName: 'prof@example.com' } }));
    });
    const existsSync = vi.fn(() => false);
    await expect(resolveIdentity('100.64.1.2', { execFile, existsSync })).resolves.toBe(
      'prof@example.com',
    );
  });

  it('degrades to "unknown" when the tailscale binary is missing entirely', async () => {
    const execFile = vi.fn((_bin, _args, _opts, cb) => cb(new Error('ENOENT')));
    const existsSync = vi.fn(() => false);
    await expect(resolveIdentity('100.64.1.2', { execFile, existsSync })).resolves.toBe('unknown');
  });

  it('degrades to "unknown" on malformed whois output instead of throwing', async () => {
    const execFile = vi.fn((_bin, _args, _opts, cb) => cb(null, 'not json'));
    const existsSync = vi.fn(() => false);
    await expect(resolveIdentity('100.64.1.2', { execFile, existsSync })).resolves.toBe('unknown');
  });

  it('degrades to "unknown" for an empty ip without shelling out', async () => {
    const execFile = vi.fn();
    await expect(resolveIdentity('', { execFile, existsSync: vi.fn() })).resolves.toBe('unknown');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('falls back to the default Windows install path when the bare binary is not on PATH', async () => {
    const execFile = vi.fn((bin, _args, _opts, cb) => {
      if (bin === 'tailscale') return cb(new Error('ENOENT'));
      cb(null, JSON.stringify({ UserProfile: { LoginName: 'student@example.com' } }));
    });
    const existsSync = vi.fn(() => true);
    await expect(resolveIdentity('100.64.1.3', { execFile, existsSync })).resolves.toBe(
      'student@example.com',
    );
  });

  it('stays "unknown" when neither the bare binary nor the fallback path resolve', async () => {
    const execFile = vi.fn((_bin, _args, _opts, cb) => cb(new Error('ENOENT')));
    const existsSync = vi.fn(() => true);
    await expect(resolveIdentity('100.64.1.4', { execFile, existsSync })).resolves.toBe('unknown');
  });
});
