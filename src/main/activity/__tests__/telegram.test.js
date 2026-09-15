import { describe, it, expect, vi } from 'vitest';
import { formatActivityMessage, formatDuration, sendTelegramAlert } from '../telegram.js';

describe('formatDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatDuration(45000)).toBe('45s');
  });

  it('formats multi-minute durations as min + sec', () => {
    expect(formatDuration(125000)).toBe('2min 5s');
  });
});

describe('formatActivityMessage', () => {
  it('includes identity, machine, duration and file count', () => {
    const msg = formatActivityMessage({
      identity: 'prof@example.com',
      machineName: 'DESKTOP-01',
      startedAt: new Date('2026-01-01T10:00:00').getTime(),
      endedAt: new Date('2026-01-01T10:05:00').getTime(),
      durationMs: 5 * 60 * 1000,
      filesTransferred: 3,
    });
    expect(msg).toContain('prof@example.com conectou-se a DESKTOP-01');
    expect(msg).toContain('5min 0s');
    expect(msg).toContain('Arquivos transferidos: 3.');
  });

  it('defaults file count to 0 when missing', () => {
    const msg = formatActivityMessage({
      identity: 'a@example.com',
      machineName: 'PC',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 1000,
    });
    expect(msg).toContain('Arquivos transferidos: 0.');
  });
});

// Um construtor de verdade (não vi.fn().mockImplementation com arrow) para o
// falso Telegraf — evita depender de como o mock do vitest interage com
// `new` quando a implementação retorna um objeto.
function makeFakeTelegraf(sendMessage) {
  const receivedTokens = [];
  function FakeTelegraf(token) {
    receivedTokens.push(token);
    this.telegram = { sendMessage };
  }
  FakeTelegraf.receivedTokens = receivedTokens;
  return FakeTelegraf;
}

describe('sendTelegramAlert', () => {
  it('does nothing when token or chatId is missing', async () => {
    const Telegraf = makeFakeTelegraf(vi.fn());
    await sendTelegramAlert({ token: '', chatId: '123' }, {}, { Telegraf });
    await sendTelegramAlert({ token: 'abc', chatId: '' }, {}, { Telegraf });
    expect(Telegraf.receivedTokens).toEqual([]);
  });

  it('sends the formatted message via the injected Telegraf client', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    const Telegraf = makeFakeTelegraf(sendMessage);
    const event = {
      identity: 'prof@example.com',
      machineName: 'PC-1',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 1000,
      filesTransferred: 1,
    };
    await sendTelegramAlert({ token: 'tok', chatId: '999' }, event, {
      Telegraf,
    });
    expect(Telegraf.receivedTokens).toEqual(['tok']);
    expect(sendMessage).toHaveBeenCalledWith('999', expect.stringContaining('prof@example.com'));
  });

  it('never throws when the send itself fails', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('network down'));
    const Telegraf = makeFakeTelegraf(sendMessage);
    await expect(
      sendTelegramAlert({ token: 'tok', chatId: '999' }, {}, { Telegraf }),
    ).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalled();
  });
});
