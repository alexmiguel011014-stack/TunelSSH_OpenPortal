import { describe, expect, it, vi } from 'vitest';
import { CHANNELS, createLabIpcHandlers } from '../ipc.js';

// GOALS 21: depois de reservar, trocar de aluno, estender e encerrar, o app do professor avisa o
// app do aluno. A resposta da ação ganha `published`; a ação em si nunca muda por causa disso.

const reserved = {
  ok: true,
  credentials: {
    reservationId: 'r-1',
    account: 'ana',
    userName: 'PC1\\ana',
    password: 'Xk29-pass-77',
  },
  pc: { hostId: 'host-1', name: 'PC 1', host: '100.64.0.7' },
};

function build({ handovers, manager } = {}) {
  const fullManager = {
    reserve: vi.fn(async () => reserved),
    handOver: vi.fn(async () => ({ ...reserved, previous: { account: 'joao', label: 'João' } })),
    extend: vi.fn(async () => ({ ok: true, reservationId: 'r-1', endsAt: 123 })),
    end: vi.fn(async () => ({ ok: true, reason: 'manager-ended' })),
    ...manager,
  };
  const publisher = handovers ?? {
    afterReserve: vi.fn(async () => ({ status: 'sent', message: 'Enviado para o app de Ana' })),
    afterExtend: vi.fn(async () => ({
      status: 'sent',
      message: 'Novo horário enviado ao app do aluno',
    })),
    afterEnd: vi.fn(async () => null),
  };
  const handlers = createLabIpcHandlers({
    manager: fullManager,
    store: {},
    startWithWindows: {},
    serviceControl: {},
    handovers: handovers === null ? null : publisher,
  });
  return { handlers, manager: fullManager, publisher };
}

const reservePayload = { hostId: 'host-1', account: 'ana', startWithinMs: 1000, sessionMs: 2000 };

describe('lab IPC publica o acesso liberado', () => {
  it('reservar devolve o resultado do gerente mais o que foi publicado', async () => {
    const { handlers, publisher } = build();
    const result = await handlers[CHANNELS.reserve](reservePayload);
    expect(result).toEqual({
      ...reserved,
      published: { status: 'sent', message: 'Enviado para o app de Ana' },
    });
    expect(publisher.afterReserve).toHaveBeenCalledWith('host-1', reserved);
  });

  it('trocar de aluno publica com o mesmo gancho (o acesso antigo sai dentro dele)', async () => {
    const { handlers, publisher } = build();
    const result = await handlers[CHANNELS.handOver](reservePayload);
    expect(result.published.status).toBe('sent');
    expect(result.previous).toEqual({ account: 'joao', label: 'João' });
    expect(publisher.afterReserve).toHaveBeenCalledTimes(1);
  });

  it('estender e encerrar avisam o app do aluno', async () => {
    const { handlers, publisher } = build();
    const extended = await handlers[CHANNELS.extend]({
      hostId: 'host-1',
      reservationId: 'r-1',
      addMs: 60_000,
    });
    expect(extended.published.status).toBe('sent');
    expect(publisher.afterExtend).toHaveBeenCalledWith('host-1', {
      ok: true,
      reservationId: 'r-1',
      endsAt: 123,
    });

    const ended = await handlers[CHANNELS.end]({ hostId: 'host-1', reservationId: 'r-1' });
    expect(ended).toEqual({ ok: true, reason: 'manager-ended' }); // nada a dizer: sem `published`
    expect(publisher.afterEnd).toHaveBeenCalledWith('host-1', {
      ok: true,
      reason: 'manager-ended',
    });
  });

  it('um publicador que lança nunca muda o resultado da ação', async () => {
    const boom = vi.fn(async () => {
      throw new Error('o banco caiu');
    });
    const { handlers } = build({
      handovers: { afterReserve: boom, afterExtend: boom, afterEnd: boom },
    });
    expect(await handlers[CHANNELS.reserve](reservePayload)).toEqual(reserved);
    expect(
      await handlers[CHANNELS.extend]({ hostId: 'host-1', reservationId: 'r-1', addMs: 60_000 }),
    ).toEqual({ ok: true, reservationId: 'r-1', endsAt: 123 });
    expect(await handlers[CHANNELS.end]({ hostId: 'host-1', reservationId: 'r-1' })).toEqual({
      ok: true,
      reason: 'manager-ended',
    });
  });

  it('sem publicador (build sem contas) tudo é como antes', async () => {
    const { handlers } = build({ handovers: null });
    expect(await handlers[CHANNELS.reserve](reservePayload)).toEqual(reserved);
  });

  it('pedido inválido não chega ao gerente nem ao publicador', async () => {
    const { handlers, manager, publisher } = build();
    expect(
      await handlers[CHANNELS.reserve]({ hostId: 'host-1', account: 'Ana Maria' }),
    ).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(await handlers[CHANNELS.end]({ hostId: '', reservationId: 'r' })).toMatchObject({
      error: 'bad-request',
    });
    expect(manager.reserve).not.toHaveBeenCalled();
    expect(publisher.afterReserve).not.toHaveBeenCalled();
  });

  it('o resultado de uma ação que falhou ainda passa pelo publicador (a troca que encerrou e não reservou)', async () => {
    const failure = { ok: false, step: 'reserve', ended: true, message: 'o PC está cheio' };
    const { handlers, publisher } = build({ manager: { handOver: vi.fn(async () => failure) } });
    publisher.afterReserve.mockResolvedValueOnce(null);
    expect(await handlers[CHANNELS.handOver](reservePayload)).toEqual(failure);
    expect(publisher.afterReserve).toHaveBeenCalledWith('host-1', failure);
  });
});
