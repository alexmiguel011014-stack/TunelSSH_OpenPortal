import { describe, it, expect } from 'vitest';
import {
  connectMachineEntry,
  disconnectMachineEntry,
  isConnectionHistoryEvent,
  groupConnectionHistory,
  listQuickSessions,
  pickFocusAfterDisconnect,
  resolveTransport,
} from '../connectionState.js';

describe('connectMachineEntry / disconnectMachineEntry', () => {
  it('connecting a second machine keeps the first one present', () => {
    let state = {};
    state = connectMachineEntry(state, { id: 'pc-a', name: 'A' }, { ftSessionId: 'ft-a' });
    state = connectMachineEntry(state, { id: 'pc-b', name: 'B' }, { ftSessionId: 'ft-b' });
    expect(Object.keys(state).sort()).toEqual(['pc-a', 'pc-b']);
    expect(state['pc-a'].ftSessionId).toBe('ft-a');
    expect(state['pc-b'].ftSessionId).toBe('ft-b');
  });

  it('disconnecting one machine leaves the other unaffected', () => {
    let state = {};
    state = connectMachineEntry(state, { id: 'pc-a', name: 'A' });
    state = connectMachineEntry(state, { id: 'pc-b', name: 'B' });
    state = disconnectMachineEntry(state, 'pc-a');
    expect(state).not.toHaveProperty('pc-a');
    expect(state['pc-b'].machine.name).toBe('B');
  });

  it('disconnecting an id that is not connected is a no-op', () => {
    const state = connectMachineEntry({}, { id: 'pc-a', name: 'A' });
    expect(disconnectMachineEntry(state, 'pc-x')).toBe(state);
  });
});

describe('pickFocusAfterDisconnect', () => {
  it('moves focus to a remaining machine when the focused one disconnects', () => {
    const state = connectMachineEntry(connectMachineEntry({}, { id: 'pc-a', name: 'A' }), {
      id: 'pc-b',
      name: 'B',
    });
    expect(pickFocusAfterDisconnect(state, 'pc-a', 'pc-a')).toBe('pc-b');
  });

  it('keeps focus unchanged when a non-focused machine disconnects', () => {
    const state = connectMachineEntry(connectMachineEntry({}, { id: 'pc-a', name: 'A' }), {
      id: 'pc-b',
      name: 'B',
    });
    expect(pickFocusAfterDisconnect(state, 'pc-a', 'pc-b')).toBe('pc-a');
  });

  it('focus becomes null when the last connected machine disconnects', () => {
    const state = connectMachineEntry({}, { id: 'pc-a', name: 'A' });
    expect(pickFocusAfterDisconnect(state, 'pc-a', 'pc-a')).toBe(null);
  });
});

describe('isConnectionHistoryEvent', () => {
  it('records real results only, never an explicit user disconnect', () => {
    expect(isConnectionHistoryEvent({ state: 'connected' })).toBe(true);
    expect(isConnectionHistoryEvent({ state: 'error' })).toBe(true);
    expect(isConnectionHistoryEvent({ state: 'disconnected' })).toBe(true);
    expect(
      isConnectionHistoryEvent({ state: 'disconnected', intentional: true, eventName: 'UserStop' }),
    ).toBe(false);
    expect(isConnectionHistoryEvent({ state: 'connecting' })).toBe(false);
    expect(isConnectionHistoryEvent(null)).toBe(false);
  });
});

describe('resolveTransport', () => {
  it('defaults to vnc when transport is unset (pre-GOALS-2 machines)', () => {
    expect(resolveTransport({ id: 'pc-a' })).toBe('vnc');
  });

  it('returns rdp only when explicitly set to rdp', () => {
    expect(resolveTransport({ id: 'pc-a', transport: 'rdp' })).toBe('rdp');
  });

  it('treats any other value as vnc', () => {
    expect(resolveTransport({ id: 'pc-a', transport: 'bogus' })).toBe('vnc');
  });
});

describe('listQuickSessions', () => {
  it('lists open sessions that are not saved PCs', () => {
    const machines = [{ id: 'pc-1' }, { id: 'pc-2' }];
    const connected = {
      'pc-2': { machine: { id: 'pc-2', name: 'PC B', host: '100.81.199.56' } },
      'quick-1': { machine: { id: 'quick-1', name: 'Conexão Direta', host: '100.66.218.65' } },
    };

    expect(listQuickSessions(machines, connected)).toEqual([
      { id: 'quick-1', name: 'Conexão Direta', host: '100.66.218.65' },
    ]);
    expect(listQuickSessions(machines, {})).toEqual([]);
  });
});

describe('groupConnectionHistory', () => {
  it('shows the newest result of a run of entries for the same PC', () => {
    const pcB = { name: 'PC B', host: '100.81.199.56' };
    const history = [
      { ...pcB, id: '1', time: '10:00', state: 'info', message: 'Aguardando aprovação' },
      { ...pcB, id: '2', time: '10:01', state: 'connect', message: 'connected' },
      { name: 'PC A', host: '100.66.218.65', id: '3', time: '10:02', state: 'error', message: 'x' },
      { ...pcB, id: '4', time: '10:03', state: 'info', message: 'Aguardando aprovação' },
      { ...pcB, id: '5', time: '10:04', state: 'disconnected', message: 'disconnected' },
    ];

    expect(groupConnectionHistory(history)).toEqual([
      { ...history[4], count: 2 },
      { ...history[2], count: 1 },
      { ...history[1], count: 2 },
    ]);
  });
});
