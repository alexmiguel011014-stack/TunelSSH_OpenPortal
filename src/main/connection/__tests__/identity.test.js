import { describe, it, expect, vi } from 'vitest';
import { resolveIdentity, resolveLoginToIp, normalizeIp, isAllowed } from '../identity.js';

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

// resolveLoginToIp: `deps` injection mirrors resolveIdentity's tests above —
// same reason (real tailscale.exe otherwise gets invoked despite module
// mocks). Fixture matches the real `tailscale status --json` shape confirmed
// against a live install: peers carry only a UserID, resolved through the
// top-level User map — not an embedded UserProfile.
function statusFixture({ login = 'prof@example.com', peerIp = '100.64.1.9', online = true } = {}) {
  return {
    User: { 42: { LoginName: login } },
    Peer: {
      'nodekey:abc': {
        UserID: 42,
        Online: online,
        TailscaleIPs: [peerIp, 'fd7a:115c:a1e0::1'],
      },
    },
  };
}

describe('resolveLoginToIp', () => {
  it('returns the IPv4 address of the peer matching the login', async () => {
    const execFile = vi.fn((_bin, _args, _opts, cb) => cb(null, JSON.stringify(statusFixture())));
    await expect(
      resolveLoginToIp('prof@example.com', {
        execFile,
        existsSync: vi.fn(() => false),
      }),
    ).resolves.toBe('100.64.1.9');
  });

  it('returns null when no peer matches the login', async () => {
    const execFile = vi.fn((_bin, _args, _opts, cb) => cb(null, JSON.stringify(statusFixture())));
    await expect(
      resolveLoginToIp('nobody@example.com', {
        execFile,
        existsSync: vi.fn(() => false),
      }),
    ).resolves.toBe(null);
  });

  it('returns null for an empty login without shelling out', async () => {
    const execFile = vi.fn();
    await expect(resolveLoginToIp('', { execFile, existsSync: vi.fn() })).resolves.toBe(null);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('degrades to null when the tailscale binary is missing entirely', async () => {
    const execFile = vi.fn((_bin, _args, _opts, cb) => cb(new Error('ENOENT')));
    const existsSync = vi.fn(() => false);
    await expect(resolveLoginToIp('prof@example.com', { execFile, existsSync })).resolves.toBe(
      null,
    );
  });

  it('falls back to the default Windows install path when the bare binary is not on PATH', async () => {
    const execFile = vi.fn((bin, _args, _opts, cb) => {
      if (bin === 'tailscale') return cb(new Error('ENOENT'));
      cb(null, JSON.stringify(statusFixture({ login: 'e1@example.com', peerIp: '100.64.2.5' })));
    });
    const existsSync = vi.fn(() => true);
    await expect(resolveLoginToIp('e1@example.com', { execFile, existsSync })).resolves.toBe(
      '100.64.2.5',
    );
  });
});
