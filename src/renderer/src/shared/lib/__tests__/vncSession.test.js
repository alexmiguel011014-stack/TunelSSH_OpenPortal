import { describe, expect, it } from 'vitest';
import {
  buildVncViewerUrl,
  formatAccessPassword,
  formatIpInput,
  isRetryableVncState,
  normalizeQuickVncHost,
  shouldExplainMissingTunnel,
  shouldUseSavedVncCredential,
} from '../vncSession.js';

describe('shouldExplainMissingTunnel', () => {
  it('explains once when a session without tunnel never opened', () => {
    expect(shouldExplainMissingTunnel({ everConnected: false, tunnel: false })).toBe(true);
    expect(
      shouldExplainMissingTunnel({ everConnected: false, tunnel: false, alreadyExplained: true }),
    ).toBe(false);
  });

  it('stays quiet for tunnelled sessions and for drops after the session opened', () => {
    expect(shouldExplainMissingTunnel({ everConnected: false, tunnel: true })).toBe(false);
    expect(shouldExplainMissingTunnel({ everConnected: true, tunnel: false })).toBe(false);
  });
});

describe('formatIpInput', () => {
  it('adds the dot after a full octet while typing, but not while deleting', () => {
    expect(formatIpInput('100', '10')).toBe('100.');
    expect(formatIpInput('100', '100.')).toBe('100');
    expect(formatIpInput('1008', '100')).toBe('100.8');
    expect(formatIpInput('100.81.199.56', '100.81.199.5')).toBe('100.81.199.56');
  });

  it('splits digits typed without dots so that no octet passes 255', () => {
    expect(formatIpInput('1008119956')).toBe('100.81.199.56');
    expect(formatIpInput('10066218', '1006621')).toBe('100.66.218.');
  });

  it('keeps only digits and dots and drops the port and extra characters', () => {
    expect(formatIpInput(' 100,81 199.56:5900 ')).toBe('100.81.199.56');
    expect(formatIpInput('100..8')).toBe('100.8');
    expect(formatIpInput('ABCD-EFGH')).toBe('');
    expect(formatIpInput('100.81.199.5678')).toBe('100.81.199.56');
  });
});

describe('formatAccessPassword', () => {
  it('inserts the dash after 4 characters and uppercases what is typed', () => {
    expect(formatAccessPassword('abcd')).toBe('ABCD');
    expect(formatAccessPassword('abcde')).toBe('ABCD-E');
    expect(formatAccessPassword('abcdefgh')).toBe('ABCD-EFGH');
  });

  it('ignores spaces and extra dashes and caps at 8 characters', () => {
    expect(formatAccessPassword(' ab-cd ef gh ij ')).toBe('ABCD-EFGH');
    expect(formatAccessPassword('ABCD-')).toBe('ABCD');
  });
});

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
