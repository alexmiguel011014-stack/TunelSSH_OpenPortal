import { describe, expect, it, vi } from 'vitest';
import mainEvents from '../../../../../main/lab/events.js';
import {
  END_REASON_LABELS,
  TYPE_FILTERS,
  TYPE_LABELS,
  dayBoundary,
  describeEvent,
  describeGap,
  describeReservationRow,
  describeRetention,
  distinctSources,
  downloadText,
  eventTone,
  filtersToQuery,
  formatDateTime,
  formatSpan,
  formatTimeOnly,
  hasActiveFilters,
} from '../labLog';

const TZ = 'America/Sao_Paulo';
const AT = Date.parse('2026-10-01T17:30:00Z');

describe('labels match the ones the main process writes into the CSV', () => {
  it('has a label for every event type and end reason, equal to the main process', () => {
    for (const type of mainEvents.EVENT_TYPES) {
      expect(TYPE_LABELS[type], type).toBe(mainEvents.typeLabel(type));
    }
    for (const reason of mainEvents.END_REASONS) {
      expect(END_REASON_LABELS[reason], reason).toBe(mainEvents.endReasonLabel(reason));
    }
    expect(Object.keys(TYPE_LABELS)).toHaveLength(mainEvents.EVENT_TYPES.length);
  });

  it('offers every event type in some filter group, and only real ones', () => {
    const offered = TYPE_FILTERS.flatMap((option) => option.types);
    expect([...new Set(offered)].sort()).toEqual([...mainEvents.EVENT_TYPES].sort());
  });
});

describe('dates and spans', () => {
  it('formats local time and spans', () => {
    expect(formatDateTime(AT, TZ)).toBe('01/10/2026 14:30');
    expect(formatTimeOnly(AT, TZ)).toBe('14:30');
    expect(formatDateTime(0)).toBe('—');
    expect(formatSpan(30 * 1000)).toBe('30 s');
    expect(formatSpan(42 * 60000)).toBe('42 min');
    expect(formatSpan(65 * 60000)).toBe('1 h 05 min');
    expect(formatSpan(2 * 3600000)).toBe('2 h');
    expect(formatSpan(0)).toBe('—');
  });

  it('turns a date field into the start or the end of that day, and refuses a bad date', () => {
    const start = dayBoundary('2026-10-01', 'start');
    const end = dayBoundary('2026-10-01', 'end');
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(start).getDate()).toBe(1);
    expect(new Date(end).getHours()).toBe(23);
    expect(end - start).toBe(24 * 3600000 - 1);
    expect(dayBoundary('', 'start')).toBeUndefined();
    expect(dayBoundary('01/10/2026', 'start')).toBeUndefined();
    expect(dayBoundary('2026-02-31', 'start')).toBeUndefined();
    expect(dayBoundary(undefined, 'end')).toBeUndefined();
  });
});

describe('filters', () => {
  it('builds the query the main process understands, leaving empty fields out', () => {
    expect(filtersToQuery({})).toEqual({});
    expect(filtersToQuery()).toEqual({});
    const query = filtersToQuery({
      student: 'ana',
      hostId: 'host-b',
      from: '2026-10-01',
      to: '2026-10-02',
      typeGroup: 'access',
    });
    expect(query).toMatchObject({
      student: 'ana',
      hostId: 'host-b',
      types: ['session-logon', 'session-logoff'],
    });
    expect(query.to).toBeGreaterThan(query.from);
    expect(filtersToQuery({ typeGroup: '' })).toEqual({});
    expect(filtersToQuery({ typeGroup: 'nope' })).toEqual({});
  });

  it('knows when a filter is on', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ student: 'ana' })).toBe(true);
    expect(hasActiveFilters({ from: 'lixo' })).toBe(false);
  });
});

describe('describing events', () => {
  const ev = (extra) => ({
    v: 2,
    hostId: 'h',
    hostName: 'PC-B',
    seq: 1,
    at: AT,
    student: { label: 'Ana Souza', account: 'anasouza' },
    ...extra,
  });

  it('writes one sentence per event, with the source address of a sign-in', () => {
    expect(
      describeEvent(ev({ type: 'session-logon', detail: 'logon', sourceIp: '100.64.0.9' })),
    ).toBe('Ana Souza entrou · de 100.64.0.9');
    expect(
      describeEvent(ev({ type: 'session-logon', detail: 'reconnect', sourceIp: '10.0.0.5' })),
    ).toBe('Ana Souza reconectou · de 10.0.0.5');
    expect(describeEvent(ev({ type: 'session-logoff', detail: 'disconnect' }))).toBe(
      'Ana Souza desconectou',
    );
    expect(describeEvent(ev({ type: 'session-logoff', detail: 'logoff' }))).toBe('Ana Souza saiu');
    expect(describeEvent(ev({ type: 'reservation-end', endReason: 'deadline' }))).toBe(
      'Reserva de Ana Souza encerrada (fim do prazo)',
    );
    expect(describeEvent(ev({ type: 'reservation-end' }))).toBe('Reserva de Ana Souza encerrada');
    expect(describeEvent(ev({ type: 'reservation-start', detail: 'sessão de 60 min' }))).toContain(
      'Ana Souza',
    );
    expect(describeEvent(ev({ type: 'student-added', detail: '25 GB' }))).toBe(
      'Ana Souza adicionado (cota 25 GB)',
    );
    expect(describeEvent(ev({ type: 'quota-changed', detail: '40 GB' }))).toBe(
      'Cota de Ana Souza alterada para 40 GB',
    );
    expect(describeEvent(ev({ type: 'student-deleted' }))).toBe('Ana Souza apagado');
    expect(describeEvent({ type: 'manager-enrolled', detail: 'prof@escola.com' })).toBe(
      'Gerente adicionado: prof@escola.com',
    );
    expect(describeEvent({ type: 'host-lost', detail: 'sem resposta há 30 s' })).toBe(
      'O PC deixou de responder (sem resposta há 30 s)',
    );
    expect(describeEvent({ type: 'host-back' })).toBe('O PC voltou a responder');
    expect(describeEvent({ type: 'novo-tipo' })).toBe('novo-tipo');
  });

  it('gives each kind a tone', () => {
    expect(eventTone({ type: 'host-lost' })).toBe('danger');
    expect(eventTone({ type: 'host-back' })).toBe('success');
    expect(eventTone({ type: 'reservation-end', endReason: 'deadline' })).toBe('warning');
    expect(eventTone({ type: 'session-logon' })).toBe('accent');
    expect(eventTone({ type: 'quota-changed' })).toBe('faint');
  });
});

describe('reservations and gaps', () => {
  const group = {
    student: { label: 'Ana Souza', account: 'anasouza' },
    hostName: 'PC-B',
    startedAt: AT,
    endedAt: AT + 64 * 60000,
    durationMs: 60 * 60000,
    endReason: 'deadline',
    events: [{ at: AT }],
    signIns: [
      { kind: 'logon', sourceIp: '100.64.0.9' },
      { kind: 'logoff', sourceIp: '100.64.0.9' },
      { kind: 'logon', sourceIp: '192.168.1.50' },
    ],
  };

  it('summarises a reservation row and lists the different source addresses', () => {
    expect(describeReservationRow(group, TZ)).toEqual({
      title: 'Ana Souza · PC-B',
      when: '01/10/2026 14:30 → 15:34',
      span: '1 h',
      reason: 'Fim do prazo',
      signIns: 2,
    });
    expect(distinctSources(group)).toEqual(['100.64.0.9', '192.168.1.50']);
    expect(
      describeReservationRow({ ...group, endedAt: 0, durationMs: 0, endReason: '' }, TZ),
    ).toMatchObject({
      when: '01/10/2026 14:30 (em andamento)',
      span: '',
      reason: '',
    });
  });

  it('explains a gap in plain words', () => {
    expect(describeGap({ hostName: 'PC-B', fromSeq: 3, toSeq: 9, reason: 'rotated' })).toBe(
      'PC-B: eventos 3 a 9 — o diário do PC já não os tem (o arquivo girou ou passou do prazo)',
    );
    expect(describeGap({ hostName: 'PC-B', fromSeq: 4, toSeq: 4, reason: 'reset' })).toContain(
      'evento'.slice(0, 5),
    );
    expect(describeGap({ fromSeq: 1, toSeq: 2, reason: 'weird' })).toContain('não os entregou');
  });

  it('writes the retention in days or years', () => {
    expect(describeRetention(1)).toBe('1 dia');
    expect(describeRetention(180)).toBe('180 dias');
    expect(describeRetention(365)).toBe('1 ano');
    expect(describeRetention(730)).toBe('2 anos');
    expect(describeRetention(NaN)).toBe('');
  });
});

describe('downloading the CSV', () => {
  it('hands the text to a temporary link and cleans up', () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const link = { style: {}, click };
    const doc = {
      createElement: vi.fn(() => link),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    };
    const urlApi = { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() };
    downloadText('registro.csv', '﻿a;b', doc, urlApi);
    expect(link.download).toBe('registro.csv');
    expect(link.href).toBe('blob:x');
    expect(click).toHaveBeenCalled();
    expect(doc.body.removeChild).toHaveBeenCalledWith(link);
    vi.advanceTimersByTime(1500);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:x');
    vi.useRealTimers();
  });
});
