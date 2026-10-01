import { describe, it, expect } from 'vitest';
import {
  LAB_STATE_LABELS,
  canOpenLabScreen,
  describeAddResult,
  describeManagers,
  describeRosterSummary,
  isLabModeOn,
  labOpenHint,
  labStateLabel,
  labStateTone,
  summarizeRoster,
} from '../lab.js';

const STATES = ['free', 'reserved', 'in-use', 'offline', 'incompatible', 'refused', 'checking'];

describe('lab state presentation', () => {
  it('labels every state the main process can send, in Portuguese', () => {
    expect(Object.keys(LAB_STATE_LABELS).sort()).toEqual([...STATES].sort());
    expect(labStateLabel('free')).toBe('Livre');
    expect(labStateLabel('reserved')).toBe('Reservado');
    expect(labStateLabel('in-use')).toBe('Em uso');
    expect(labStateLabel('offline')).toBe('Offline');
    expect(labStateLabel('incompatible')).toBe('Incompatível');
  });

  it('falls back to "consulting" for an unknown state', () => {
    expect(labStateLabel('made-up')).toBe('Consultando...');
    expect(labStateTone('made-up')).toBe('faint');
  });

  it('gives each state a tone', () => {
    for (const state of STATES)
      expect(labStateTone(state)).toMatch(/^(success|warning|danger|accent|faint)$/);
  });

  it('offers "Abrir tela" only for a PC that answers and has no student in session', () => {
    expect(STATES.filter(canOpenLabScreen)).toEqual(['free', 'reserved']);
    expect(canOpenLabScreen(undefined)).toBe(false);
  });

  it('explains why a screen cannot be opened', () => {
    for (const state of STATES) expect(labOpenHint(state).length).toBeGreaterThan(5);
    expect(labOpenHint('in-use')).toContain('aluno');
  });
});

describe('lab mode and summaries', () => {
  it('is on when the screen is enabled or the PC is managed', () => {
    expect(isLabModeOn(null)).toBe(false);
    expect(isLabModeOn({ mode: false, managed: false })).toBe(false);
    expect(isLabModeOn({ mode: true, managed: false })).toBe(true);
    expect(isLabModeOn({ mode: false, managed: true })).toBe(true);
  });

  it('counts the roster by state', () => {
    const roster = [
      { state: 'free' },
      { state: 'free' },
      { state: 'in-use' },
      { state: 'offline' },
      { state: 'refused' },
      { state: 'reserved' },
    ];
    expect(summarizeRoster(roster)).toEqual({
      total: 6,
      free: 2,
      reserved: 1,
      inUse: 1,
      offline: 1,
      other: 1,
    });
    expect(summarizeRoster(undefined).total).toBe(0);
  });

  it('writes a one-line summary', () => {
    expect(describeRosterSummary([])).toBe('Nenhum PC na lista');
    expect(describeRosterSummary([{ state: 'free' }])).toBe('1 PC · 1 livre');
    expect(
      describeRosterSummary([
        { state: 'free' },
        { state: 'free' },
        { state: 'in-use' },
        { state: 'offline' },
      ]),
    ).toBe('4 PCs · 2 livres · 1 em uso · 1 offline');
  });

  it('describes the result of adding a PC', () => {
    expect(describeAddResult({ ok: true, entry: { name: 'PC-B' } })).toEqual({
      kind: 'info',
      text: 'PC-B adicionado à lista',
    });
    expect(
      describeAddResult({
        ok: false,
        message: 'A pessoa no PC recusou o pedido',
      }),
    ).toEqual({
      kind: 'error',
      text: 'A pessoa no PC recusou o pedido',
    });
    expect(describeAddResult(undefined).kind).toBe('error');
  });

  it('describes who manages the PC', () => {
    expect(describeManagers([])).toBe('Ninguém gerencia este PC');
    expect(describeManagers(['a@x.com'])).toBe('1 gerente');
    expect(describeManagers(['a@x.com', 'b@x.com'])).toBe('2 gerentes');
    expect(describeManagers(undefined)).toBe('Ninguém gerencia este PC');
  });
});
