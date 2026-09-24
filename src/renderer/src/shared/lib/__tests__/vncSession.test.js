import { describe, expect, it } from 'vitest';
import {
  buildVncViewerUrl,
  formatAccessPassword,
  formatIpInput,
  isCredentialRequest,
  isFromActiveViewer,
  isRetryableVncState,
  nextCredentialSource,
  normalizeQuickVncHost,
  shouldExplainMissingTunnel,
  shouldPersistVncCredential,
  shouldUseSavedVncCredential,
} from '../vncSession.js';

describe('VNC credential policy (GOALS 8)', () => {
  it('answers with a password only when the server asked for one', () => {
    expect(isCredentialRequest({ type: 'vnc-status', state: 'credentials-required' })).toBe(true);
    for (const data of [
      { type: 'vnc-ready' },
      { type: 'vnc-resolution', width: 800, height: 600 },
      { type: 'vnc-status', state: 'connected' },
      { type: 'vnc-status', state: 'authentication-failed' },
      { type: 'vnc-status', state: 'server-refused' },
      { type: 'vnc-status', state: 'connection-lost' },
      { type: 'vnc-reconnect-request' },
      null,
    ]) {
      expect(isCredentialRequest(data)).toBe(false);
    }
  });

  it('ignores messages from another window or from a stale attempt', () => {
    const viewer = {};
    const message = (source, attemptId) => ({
      source,
      data: { type: 'vnc-status', state: 'credentials-required', attemptId },
    });
    expect(isFromActiveViewer(message(viewer, 'vnc-pc-2'), viewer, 'vnc-pc-2')).toBe(true);
    expect(isFromActiveViewer(message(viewer, 'vnc-pc-1'), viewer, 'vnc-pc-2')).toBe(false);
    expect(isFromActiveViewer(message({}, 'vnc-pc-2'), viewer, 'vnc-pc-2')).toBe(false);
    expect(isFromActiveViewer(message(undefined, 'vnc-pc-2'), undefined, 'vnc-pc-2')).toBe(false);
    expect(isFromActiveViewer({ source: viewer, data: null }, viewer, 'vnc-pc-2')).toBe(false);
  });

  it('uses a just-typed password, then the approval grant once, then the saved one once, then asks', () => {
    const base = {
      pendingCredential: '',
      grant: '',
      grantTried: false,
      grantRejected: false,
      hasSavedCredential: false,
      savedCredentialTried: false,
    };
    expect(nextCredentialSource({ ...base, pendingCredential: 'typed', grant: 'g' })).toBe(
      'pending',
    );
    expect(nextCredentialSource({ ...base, grant: 'g', hasSavedCredential: true })).toBe('grant');
    expect(nextCredentialSource({ ...base, grant: 'g', grantTried: true })).toBe('ask');
    expect(
      nextCredentialSource({ ...base, grant: 'g', grantRejected: true, hasSavedCredential: true }),
    ).toBe('saved');
    expect(
      nextCredentialSource({ ...base, hasSavedCredential: true, savedCredentialTried: true }),
    ).toBe('ask');
    expect(nextCredentialSource(base)).toBe('ask');
  });

  it('never persists a password typed for a quick connection', () => {
    expect(shouldPersistVncCredential({ machineId: 'pc-b', saveRequested: true })).toBe(true);
    expect(shouldPersistVncCredential({ machineId: 'pc-b', saveRequested: false })).toBe(false);
    expect(
      shouldPersistVncCredential({ machineId: 'quick-1790211236916', saveRequested: true }),
    ).toBe(false);
  });
});

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
