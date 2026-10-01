import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CREDENTIAL_NOTICE,
  SESSION_END_HINT,
  buildCredentialMessage,
  deleteConfirmText,
  describeActionError,
  describeCapacity,
  describeReservation,
  formatClock,
  formatGb,
  formatMinutes,
  lastSessionText,
  loadNotice,
  sanitizeNotice,
  saveNotice,
  studentStateLabel,
  studentStateTone,
  timeLeftText,
  usageTone,
  usedPercent,
  validateReservationForm,
  validateStudentForm,
} from '../lab';

const TZ = 'America/Sao_Paulo'; // UTC-3, sem horário de verão
const at = (iso) => Date.parse(iso);

describe('numbers and times', () => {
  it('writes gigabytes with a decimal comma and never shows a tiny use as zero', () => {
    expect(formatGb(4.24)).toBe('4,2 GB');
    expect(formatGb(25)).toBe('25 GB');
    expect(formatGb(0)).toBe('0 GB');
    expect(formatGb(0.04)).toBe('menos de 0,1 GB');
    expect(formatGb(undefined)).toBe('—');
    expect(formatGb(-1)).toBe('—');
    expect(formatGb(NaN)).toBe('—');
  });

  it('shows the use against the quota as a percentage that never passes 100', () => {
    expect(usedPercent({ usedGb: 5, quotaGb: 25 })).toBe(20);
    expect(usedPercent({ usedGb: 30, quotaGb: 25 })).toBe(100);
    expect(usedPercent({ usedGb: 0, quotaGb: 25 })).toBe(0);
    expect(usedPercent({ quotaGb: 25 })).toBe(0);
    expect(usedPercent({ usedGb: 5, quotaGb: 0 })).toBe(0);
    expect(usedPercent(null)).toBe(0);
    expect(usageTone(50)).toBe('accent');
    expect(usageTone(90)).toBe('warning');
    expect(usageTone(100)).toBe('danger');
  });

  it('formats local clock times and durations', () => {
    expect(formatClock(at('2026-10-01T17:30:00Z'), TZ)).toBe('14:30');
    expect(formatClock(0)).toBe('—');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(-1)).toBe('—');
  });

  it('says how long a session has left', () => {
    const now = at('2026-10-01T17:00:00Z');
    expect(timeLeftText(now + 42 * 60000, now)).toBe('faltam 42 min');
    expect(timeLeftText(now + 90 * 60000, now)).toBe('faltam 1 h 30 min');
    expect(timeLeftText(now - 1, now)).toBe('terminando');
    expect(timeLeftText(0, now)).toBe('');
  });

  it('describes the last session as today, yesterday or a date', () => {
    const now = at('2026-10-01T17:00:00Z');
    expect(lastSessionText(0, now, TZ)).toBe('nunca usou');
    expect(lastSessionText(at('2026-10-01T12:05:00Z'), now, TZ)).toBe('hoje às 09:05');
    expect(lastSessionText(at('2026-09-30T20:00:00Z'), now, TZ)).toBe('ontem às 17:00');
    expect(lastSessionText(at('2026-09-20T20:00:00Z'), now, TZ)).toBe('20/09 às 17:00');
  });
});

describe('student states', () => {
  it('names the states and gives them a tone', () => {
    expect(studentStateLabel('free')).toBe('Livre');
    expect(studentStateLabel('reserved')).toBe('Reservado');
    expect(studentStateLabel('in-use')).toBe('Em uso');
    expect(studentStateLabel('ending')).toBe('Encerrando');
    expect(studentStateLabel('weird')).toBe('Livre');
    expect(studentStateTone('reserved')).toBe('warning');
    expect(studentStateTone('in-use')).toBe('accent');
    expect(studentStateTone('free')).toBe('success');
  });

  it('summarises the reservation in one line', () => {
    const now = at('2026-10-01T17:00:00Z');
    expect(
      describeReservation(
        {
          label: 'Ana',
          account: 'ana',
          state: 'in-use',
          endsAt: now + 42 * 60000,
        },
        now,
        TZ,
      ),
    ).toBe('Ana · em uso · faltam 42 min (até 14:42)');
    expect(
      describeReservation(
        {
          label: 'João',
          account: 'joao',
          state: 'reserved',
          startBy: now + 30 * 60000,
          endsAt: now + 90 * 60000,
        },
        now,
        TZ,
      ),
    ).toBe('João · reservado · entrar até 14:30 · termina no máximo às 15:30');
    expect(describeReservation(null)).toBe('');
  });
});

describe('capacity box (the same numbers as the service)', () => {
  const base = {
    totalGb: 250,
    freeGb: 120,
    reserveGb: 50,
    quotaGb: 25,
    recommended: 2,
    assignedGb: 50,
    status: 'ok',
  };

  it('is calm when there is room', () => {
    const box = describeCapacity(base, 'enforce');
    expect(box.tone).toBe('success');
    expect(box.title).toBe('Cabem 2 alunos de 25 GB');
    expect(box.lines).toEqual([
      'Livre: 120 GB de 250 GB · reserva do sistema: 50 GB',
      'Cotas somadas: 50 GB',
    ]);
  });

  it('warns when it is tight or over, as a warning and never a block', () => {
    const tight = describeCapacity(
      { ...base, recommended: 1, assignedGb: 70, status: 'tight' },
      'enforce',
    );
    expect(tight.tone).toBe('warning');
    expect(tight.title).toBe('Cabe 1 aluno de 25 GB; não sobra espaço para mais um');
    const over = describeCapacity({ ...base, assignedGb: 90, status: 'over' }, 'enforce');
    expect(over.tone).toBe('danger');
    expect(over.title).toMatch(/passam do espaço livre/);
  });

  it('says when the disk quota is not enforcing, and survives a missing disk', () => {
    expect(describeCapacity(base, 'off').lines.at(-1)).toMatch(/desligada/);
    expect(describeCapacity(base, 'track').lines.at(-1)).toMatch(/só conta o uso/);
    expect(describeCapacity(base, 'enforce').lines).toHaveLength(2);
    expect(describeCapacity(null, 'enforce')).toMatchObject({ tone: 'faint' });
  });
});

describe('forms', () => {
  it('accepts a student name and quota, trimmed', () => {
    expect(validateStudentForm({ label: '  Ana Souza ', quotaGb: '25' })).toEqual({
      ok: true,
      label: 'Ana Souza',
      quotaGb: 25,
    });
    expect(validateStudentForm({ label: 'Ana', quotaGb: 2000 }).ok).toBe(true);
  });

  it.each([
    [{ label: '', quotaGb: 25 }],
    [{ label: '   ', quotaGb: 25 }],
    [{ label: 'x'.repeat(41), quotaGb: 25 }],
    [{ label: 'Ana\u0007', quotaGb: 25 }],
    [{ label: 'Ana', quotaGb: 0 }],
    [{ label: 'Ana', quotaGb: 2001 }],
    [{ label: 'Ana', quotaGb: '2,5' }],
    [{ label: 'Ana', quotaGb: 'abc' }],
    [{ label: 'Ana', quotaGb: '' }],
  ])('refuses %j', (form) => {
    const result = validateStudentForm(form);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('turns the reservation times into milliseconds the PC accepts', () => {
    expect(validateReservationForm({ validityMin: 60, startWithinMin: 30 })).toEqual({
      ok: true,
      validityMin: 60,
      startWithinMs: 30 * 60000,
      sessionMs: 60 * 60000,
    });
    expect(validateReservationForm({ validityMin: '120', startWithinMin: '1' }).ok).toBe(true);
    expect(validateReservationForm({ validityMin: 720, startWithinMin: 1440 }).ok).toBe(true);
  });

  it.each([
    [{ validityMin: 4, startWithinMin: 30 }],
    [{ validityMin: 721, startWithinMin: 30 }],
    [{ validityMin: 'x', startWithinMin: 30 }],
    [{ validityMin: 60, startWithinMin: 0 }],
    [{ validityMin: 60, startWithinMin: 1441 }],
    [{ validityMin: 60.5, startWithinMin: 30 }],
  ])('refuses the reservation times %j', (form) => {
    expect(validateReservationForm(form).ok).toBe(false);
  });
});

describe('credential message', () => {
  const input = {
    pcName: 'PC-LAB-01',
    host: '100.64.0.11',
    userName: 'LABPC\\ana',
    password: 'Qm7rXk2PzV9tHw4B',
    startBy: at('2026-10-01T17:30:00Z'),
    endsAt: at('2026-10-01T18:30:00Z'),
    sessionMinutes: 60,
    notice: DEFAULT_CREDENTIAL_NOTICE,
    timeZone: TZ,
  };

  it('carries the PC, address, user, password, the entry deadline, the end and the notices', () => {
    expect(buildCredentialMessage(input)).toBe(
      [
        'Acesso ao PC do laboratório',
        'PC: PC-LAB-01 (100.64.0.11)',
        'Usuário: LABPC\\ana',
        'Senha: Qm7rXk2PzV9tHw4B',
        'Entre pela Conexão de Área de Trabalho Remota do Windows até as 14:30.',
        'A sessão dura 1 h a partir da entrada e termina, no máximo, às 15:30.',
        DEFAULT_CREDENTIAL_NOTICE,
        SESSION_END_HINT,
      ].join('\n'),
    );
  });

  it('explains the generic Windows error that means the access ended', () => {
    expect(buildCredentialMessage(input)).toMatch(/erro de autenticação/);
    expect(buildCredentialMessage(input)).toMatch(/a senha pode ter expirado/);
  });

  it('uses the institution text, drops an empty one, and cleans control characters', () => {
    expect(buildCredentialMessage({ ...input, notice: 'Use só para a aula.' })).toContain(
      'Use só para a aula.',
    );
    const without = buildCredentialMessage({ ...input, notice: '   ' });
    expect(without).not.toContain(DEFAULT_CREDENTIAL_NOTICE);
    expect(without).toContain(SESSION_END_HINT);
    expect(sanitizeNotice('a\u0000b\u0007c')).toBe('a b c');
    expect(sanitizeNotice('x'.repeat(500))).toHaveLength(300);
    expect(sanitizeNotice(5)).toBe('');
  });

  it('works without a known session length', () => {
    const text = buildCredentialMessage({ ...input, sessionMinutes: undefined });
    expect(text).toContain('A sessão termina, no máximo, às 15:30.');
  });
});

describe('the notice is the only thing kept on this PC, never the password', () => {
  function memoryStorage() {
    const data = new Map();
    return {
      data,
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
    };
  }

  it('saves and loads the notice, with a default when nothing was saved', () => {
    const storage = memoryStorage();
    expect(loadNotice(storage)).toBe(DEFAULT_CREDENTIAL_NOTICE);
    saveNotice(storage, 'Texto da escola');
    expect(loadNotice(storage)).toBe('Texto da escola');
    saveNotice(storage, '');
    expect(loadNotice(storage)).toBe('');
  });

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadNotice(broken)).toBe(DEFAULT_CREDENTIAL_NOTICE);
    expect(() => saveNotice(broken, 'x')).not.toThrow();
    expect(loadNotice(undefined)).toBe(DEFAULT_CREDENTIAL_NOTICE);
  });

  it('building the message stores nothing', () => {
    const storage = memoryStorage();
    buildCredentialMessage({
      pcName: 'PC',
      userName: 'LAB\\ana',
      password: 'Qm7rXk2PzV9tHw4B',
      startBy: 1,
      endsAt: 2,
      notice: 'x',
    });
    saveNotice(storage, 'x');
    expect([...storage.data.values()].join('')).not.toContain('Qm7rXk2PzV9tHw4B');
  });
});

describe('action messages', () => {
  it('says who has the PC and until when when it is busy', () => {
    expect(
      describeActionError(
        {
          ok: false,
          error: 'busy',
          busyWith: { label: 'Ana', endsAt: at('2026-10-01T17:30:00Z') },
        },
        TZ,
      ),
    ).toBe('O PC está com Ana até 14:30. Use "Trocar aluno" para passar o PC.');
  });

  it('keeps the PC message otherwise, and notes when the previous session already ended', () => {
    expect(describeActionError({ ok: false, message: 'Sem espaço' })).toBe('Sem espaço');
    expect(describeActionError(null)).toBe('Não foi possível concluir a ação');
    expect(
      describeActionError({
        ok: false,
        step: 'reserve',
        ended: true,
        message: 'O PC já está reservado.',
      }),
    ).toBe('O PC já está reservado. A sessão anterior já foi encerrada.');
  });

  it('asks for confirmation naming the student and the size of the files', () => {
    expect(deleteConfirmText({ label: 'Ana', account: 'ana', usedGb: 4.2 })).toBe(
      'Apagar Ana e 4,2 GB de arquivos?',
    );
    expect(deleteConfirmText({ account: 'ana' })).toBe('Apagar ana e — de arquivos?');
  });
});
