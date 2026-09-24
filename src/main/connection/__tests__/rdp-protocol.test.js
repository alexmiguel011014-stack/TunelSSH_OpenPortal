import { describe, it, expect } from 'vitest';
import {
  buildConnectCommand,
  buildResizeCommand,
  buildDisconnectCommand,
  buildVisibilityCommand,
  encodeCommand,
  parseStatusMessage,
  toRendererRdpStatus,
} from '../rdp-protocol.js';

describe('buildConnectCommand', () => {
  it('defaults port to 3389 when not given', () => {
    expect(buildConnectCommand({ host: '100.64.1.5', username: 'u', password: 'p' })).toEqual({
      cmd: 'connect',
      host: '100.64.1.5',
      port: 3389,
      username: 'u',
      password: 'p',
    });
  });

  it('keeps an explicit port', () => {
    expect(
      buildConnectCommand({
        host: '100.64.1.5',
        port: 3390,
        username: 'u',
        password: 'p',
      }),
    ).toEqual({
      cmd: 'connect',
      host: '100.64.1.5',
      port: 3390,
      username: 'u',
      password: 'p',
    });
  });
});

describe('buildResizeCommand', () => {
  it('passes the rect through as-is', () => {
    expect(buildResizeCommand({ x: 10, y: 20, w: 300, h: 400 })).toEqual({
      cmd: 'resize',
      x: 10,
      y: 20,
      w: 300,
      h: 400,
    });
  });
});

describe('buildDisconnectCommand', () => {
  it('is just the cmd tag', () => {
    expect(buildDisconnectCommand()).toEqual({ cmd: 'disconnect' });
  });
});

describe('buildVisibilityCommand', () => {
  it('coerces truthy/falsy visible values to a boolean', () => {
    expect(buildVisibilityCommand({ visible: true })).toEqual({
      cmd: 'visibility',
      visible: true,
    });
    expect(buildVisibilityCommand({ visible: 0 })).toEqual({
      cmd: 'visibility',
      visible: false,
    });
  });
});

describe('encodeCommand', () => {
  it('serializes to a single newline-terminated JSON line', () => {
    const encoded = encodeCommand({ cmd: 'disconnect' });
    expect(encoded).toBe('{"cmd":"disconnect"}\n');
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.slice(0, -1).includes('\n')).toBe(false);
  });

  it('round-trips through JSON.parse', () => {
    const command = buildConnectCommand({
      host: 'h',
      port: 3389,
      username: 'u',
      password: 'p',
    });
    const line = encodeCommand(command).trimEnd();
    expect(JSON.parse(line)).toEqual(command);
  });
});

describe('parseStatusMessage', () => {
  it('extracts status events sent by the sidecar', () => {
    expect(
      parseStatusMessage(
        '{"type":"status","state":"error","eventName":"OnLogonError","reasonCode":1326}',
      ),
    ).toEqual({ state: 'error', eventName: 'OnLogonError', reasonCode: 1326 });
  });

  it('accepts only redacted readiness diagnostics', () => {
    expect(
      parseStatusMessage(
        '{"type":"status","state":"ready","stage":"control-ready","eventName":"ControlReady","category":"host-control","lifecycleId":"generation-1","hostMode":"embedded","formHwnd":123,"sequence":7,"password":"must-not-pass"}',
      ),
    ).toEqual({
      state: 'ready',
      stage: 'control-ready',
      eventName: 'ControlReady',
      category: 'host-control',
      lifecycleId: 'generation-1',
      hostMode: 'embedded',
      formHwnd: 123,
      sequence: 7,
    });
  });

  it('ignores commands and malformed messages', () => {
    expect(parseStatusMessage('{"cmd":"connect"}')).toBeNull();
    expect(parseStatusMessage('{"type":"status","state":"unknown"}')).toBeNull();
    expect(parseStatusMessage('not-json')).toBeNull();
  });
});

describe('toRendererRdpStatus', () => {
  it('maps a security warning to an actionable but non-terminal renderer state', () => {
    expect(
      toRendererRdpStatus(
        {
          state: 'warning',
          category: 'certificate-warning',
          lifecycleId: 'generation-1',
          stage: 'security-warning',
          hostMode: 'native-window',
        },
        'pc-1',
      ),
    ).toMatchObject({
      state: 'connecting',
      nativeState: 'warning',
      machineId: 'pc-1',
      category: 'certificate-warning',
      lifecycleId: 'generation-1',
      hostMode: 'native-window',
    });
  });

  it('does not forward native reason codes or arbitrary fields', () => {
    const status = toRendererRdpStatus(
      {
        state: 'error',
        category: 'timeout',
        eventName: 'FirstEventTimeout',
        reasonCode: 123,
        password: 'must-not-pass',
      },
      'pc-1',
    );
    expect(status).not.toHaveProperty('reasonCode');
    expect(status).not.toHaveProperty('password');
    expect(status).toMatchObject({ state: 'error', category: 'timeout' });
  });
});
