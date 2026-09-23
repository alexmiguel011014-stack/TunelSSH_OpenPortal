import { describe, expect, it } from 'vitest';
import {
  buildVncViewerUrl,
  isRetryableVncState,
  normalizeQuickVncHost,
  shouldUseSavedVncCredential,
} from '../vncSession.js';

describe('normalizeQuickVncHost', () => {
  it('accepts a bare IPv4 address for the automatic VNC port', () => {
    expect(normalizeQuickVncHost(' 100.81.199.56 ')).toEqual({
      host: '100.81.199.56',
      error: '',
    });
  });

  it('rejects an IP combined with a port', () => {
    expect(normalizeQuickVncHost('100.81.199.56:5900').error).toContain('sem porta');
  });
});

describe('buildVncViewerUrl', () => {
  it('contains only connection metadata, never a password', () => {
    const url = buildVncViewerUrl({
      host: '100.81.199.56',
      port: 5900,
      proxyUrl: 'ws://127.0.0.1:18900',
      attemptId: 'quick-1-2',
    });
    expect(url).toContain('attempt=quick-1-2');
    expect(url).not.toContain('password');
  });
});

describe('VNC credential and retry policy', () => {
  it('uses a saved credential at most once per attempt', () => {
    expect(
      shouldUseSavedVncCredential({ hasSavedCredential: true, savedCredentialTried: false }),
    ).toBe(true);
    expect(
      shouldUseSavedVncCredential({ hasSavedCredential: true, savedCredentialTried: true }),
    ).toBe(false);
  });

  it('retries only a classified connection loss', () => {
    expect(isRetryableVncState('connection-lost')).toBe(true);
    expect(isRetryableVncState('authentication-failed')).toBe(false);
    expect(isRetryableVncState('credentials-required')).toBe(false);
    expect(isRetryableVncState('access-denied')).toBe(false);
    expect(isRetryableVncState('server-refused')).toBe(false);
  });
});
