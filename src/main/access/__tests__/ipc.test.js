import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNELS,
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  createAccessIpcHandlers,
  registerAccessIpc,
} from '../ipc.js';

const UUID = '11111111-1111-4111-8111-111111111111';

function serviceMock() {
  return {
    searchStudents: vi.fn(async () => ({ ok: true, students: [] })),
    listLinks: vi.fn(async () => ({ ok: true, links: [] })),
    link: vi.fn(async () => ({ ok: true })),
    unlink: vi.fn(async () => ({ ok: true })),
    mine: vi.fn(async () => ({ ok: true, access: null })),
    openRdp: vi.fn(() => ({ ok: true })),
    copyPassword: vi.fn(() => ({ ok: true })),
  };
}

const run = async (channel, ...args) => {
  const service = serviceMock();
  const handlers = createAccessIpcHandlers({ service });
  return { result: await handlers[channel](...args), service };
};

describe('access IPC surface', () => {
  const root = path.resolve(__dirname, '../../..');
  const preloadText = fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8');

  it('lists exactly the documented names', () => {
    expect([...INVOKE_CHANNELS, ...PUSH_CHANNELS].sort()).toEqual(
      [
        'access:searchStudents',
        'access:links',
        'access:link',
        'access:unlink',
        'access:mine',
        'access:mineChanged',
        'access:openRdp',
        'access:copyPassword',
      ].sort(),
    );
  });

  it('preload exposes each of them, and every access: name it uses is one of them', () => {
    const used = new Set([...preloadText.matchAll(/'(access:[A-Za-z]+)'/g)].map((m) => m[1]));
    // O preload também tem os canais antigos da tela inicial (access:getLocal, access:rotate...).
    for (const channel of [...INVOKE_CHANNELS, ...PUSH_CHANNELS])
      expect(used.has(channel), channel).toBe(true);
    const legacy = new Set(['access:getLocal', 'access:rotate', 'access:changed']);
    for (const channel of used) {
      expect(
        legacy.has(channel) || [...INVOKE_CHANNELS, ...PUSH_CHANNELS].includes(channel),
        channel,
      ).toBe(true);
    }
  });

  it('does not collide with the channels of the home screen', () => {
    for (const channel of [...INVOKE_CHANNELS, ...PUSH_CHANNELS]) {
      expect(['access:getLocal', 'access:rotate', 'access:changed']).not.toContain(channel);
    }
  });

  it('registers a handler for every invoke channel and for nothing else', () => {
    const registered = [];
    const handlers = createAccessIpcHandlers({ service: serviceMock() });
    registerAccessIpc({ ipcMain: { handle: (channel) => registered.push(channel) }, handlers });
    expect(registered.sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('the handler receives the payload, not the IPC event', async () => {
    const service = serviceMock();
    const handle = {};
    registerAccessIpc({
      ipcMain: { handle: (channel, fn) => (handle[channel] = fn) },
      handlers: createAccessIpcHandlers({ service }),
    });
    await handle[CHANNELS.links]({ sender: 'event' }, 'host-1');
    expect(service.listLinks).toHaveBeenCalledWith('host-1');
  });
});

describe('handlers validate their input', () => {
  it('searchStudents aceita texto (ou nada) e recusa o resto', async () => {
    expect((await run(CHANNELS.searchStudents, 'ana')).service.searchStudents).toHaveBeenCalledWith(
      'ana',
    );
    expect((await run(CHANNELS.searchStudents)).service.searchStudents).toHaveBeenCalledWith('');
    for (const bad of [42, {}, [], 'x'.repeat(61)]) {
      const { result, service } = await run(CHANNELS.searchStudents, bad);
      expect(result, String(bad)).toMatchObject({ ok: false, error: 'bad-request' });
      expect(service.searchStudents).not.toHaveBeenCalled();
    }
  });

  it('links pede o id do PC', async () => {
    expect((await run(CHANNELS.links, 'host-1')).service.listLinks).toHaveBeenCalled();
    for (const bad of [undefined, '', 42, 'x'.repeat(65), {}]) {
      const { result, service } = await run(CHANNELS.links, bad);
      expect(result).toMatchObject({ error: 'bad-request' });
      expect(service.listLinks).not.toHaveBeenCalled();
    }
  });

  it('link valida o PC, a conta do Windows, o nome e o aluno, e repassa só isso', async () => {
    const good = {
      hostId: 'host-1',
      account: 'ana',
      label: '  Ana  ',
      studentId: UUID,
      extra: 'ignorado',
    };
    const { service } = await run(CHANNELS.link, good);
    expect(service.link).toHaveBeenCalledWith({
      hostId: 'host-1',
      account: 'ana',
      label: 'Ana',
      studentId: UUID,
    });

    for (const override of [
      { hostId: '' },
      { account: 'Ana Maria' },
      { account: 'a'.repeat(21) },
      { label: '   ' },
      { label: 'x'.repeat(41) },
      { label: 'Ana\u0007' },
      { studentId: 'nao-e-uuid' },
      { studentId: `${UUID}; drop table` },
    ]) {
      const { result, service: s } = await run(CHANNELS.link, { ...good, ...override });
      expect(result, JSON.stringify(override)).toMatchObject({ ok: false, error: 'bad-request' });
      expect(s.link).not.toHaveBeenCalled();
    }
    for (const payload of [null, 'texto', [], undefined]) {
      expect((await run(CHANNELS.link, payload)).result).toMatchObject({ error: 'bad-request' });
    }
  });

  it('unlink valida o PC e a conta', async () => {
    const { service } = await run(CHANNELS.unlink, { hostId: 'host-1', account: 'ana' });
    expect(service.unlink).toHaveBeenCalledWith({ hostId: 'host-1', account: 'ana' });
    for (const payload of [
      { hostId: 'host-1' },
      { account: 'ana' },
      { hostId: 'h', account: 'A B' },
      null,
    ]) {
      expect((await run(CHANNELS.unlink, payload)).result).toMatchObject({ error: 'bad-request' });
    }
  });

  it('mine, openRdp e copyPassword não aceitam carga: ignoram o que a tela mandar', async () => {
    expect((await run(CHANNELS.mine)).service.mine).toHaveBeenCalled();
    const open = await run(CHANNELS.openRdp, { address: '6.6.6.6', userName: 'hacker' });
    expect(open.service.openRdp).toHaveBeenCalledWith();
    const copy = await run(CHANNELS.copyPassword, { password: 'x' });
    expect(copy.service.copyPassword).toHaveBeenCalledWith();
  });
});
