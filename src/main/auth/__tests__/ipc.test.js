import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNELS,
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  createAuthIpcHandlers,
  isCode,
  isEmail,
  isPassword,
  isStrongPassword,
  isUuid,
  registerAuthIpc,
} from '../ipc.js';
import { describeAuthError, isNetworkError } from '../errors.js';

const UUID = '11111111-1111-4111-8111-111111111111';

function serviceMock() {
  const ok = () => vi.fn(async () => ({ ok: true }));
  return {
    getState: vi.fn(() => ({ status: 'signed-out' })),
    signUp: ok(),
    verifyCode: ok(),
    resendCode: ok(),
    signIn: ok(),
    signOut: ok(),
    requestReset: ok(),
    confirmReset: ok(),
    useWithoutAccount: vi.fn(() => ({ ok: true })),
    listTeacherRequests: ok(),
    decideTeacherRequest: ok(),
  };
}

describe('auth IPC surface', () => {
  const root = path.resolve(__dirname, '../../..');
  const authChannelsIn = (file) =>
    new Set(
      [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/'(auth:[A-Za-z]+)'/g)].map(
        (m) => m[1],
      ),
    );

  it('lists exactly the documented names', () => {
    expect([...INVOKE_CHANNELS, ...PUSH_CHANNELS].sort()).toEqual(
      [
        'auth:getState',
        'auth:state',
        'auth:signUp',
        'auth:verifyCode',
        'auth:resendCode',
        'auth:signIn',
        'auth:signOut',
        'auth:resetRequest',
        'auth:resetConfirm',
        'auth:noAccount',
        'auth:teacherRequests',
        'auth:decideTeacher',
      ].sort(),
    );
    expect(new Set(Object.values(CHANNELS)).size).toBe(Object.values(CHANNELS).length);
  });

  it('preload exposes exactly those channels, no more and no fewer', () => {
    expect(authChannelsIn('main/preload.js')).toEqual(
      new Set([...INVOKE_CHANNELS, ...PUSH_CHANNELS]),
    );
  });

  it('registers a handler for every invoke channel and for nothing else', () => {
    const registered = [];
    const handlers = createAuthIpcHandlers({ service: serviceMock() });
    registerAuthIpc({ ipcMain: { handle: (channel) => registered.push(channel) }, handlers });
    expect(registered.sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('the handler receives the payload, not the IPC event', async () => {
    const service = serviceMock();
    const handle = {};
    registerAuthIpc({
      ipcMain: { handle: (channel, fn) => (handle[channel] = fn) },
      handlers: createAuthIpcHandlers({ service }),
    });
    await handle[CHANNELS.signIn]({ sender: 'event' }, { email: 'a@b.co', password: 'Senha1234' });
    expect(service.signIn).toHaveBeenCalledWith({ email: 'a@b.co', password: 'Senha1234' });
  });
});

describe('validators', () => {
  it('isEmail', () => {
    for (const good of ['a@b.co', 'ana.souza+lab@escola.edu.br']) expect(isEmail(good)).toBe(true);
    for (const bad of [
      '',
      'sem-arroba',
      'a@b',
      'a b@c.de',
      'a@@b.co',
      `${'x'.repeat(250)}@b.co`,
      null,
      42,
      {},
    ]) {
      expect(isEmail(bad), String(bad)).toBe(false);
    }
  });

  it('isPassword vai de 8 a 72 e isStrongPassword exige letras e números', () => {
    expect(isPassword('12345678')).toBe(true);
    expect(isPassword('x'.repeat(72))).toBe(true);
    expect(isPassword('x'.repeat(73))).toBe(false);
    expect(isPassword('curta1')).toBe(false);
    expect(isPassword(12345678)).toBe(false);
    expect(isStrongPassword('Senha1234')).toBe(true);
    expect(isStrongPassword('somenteletras')).toBe(false);
    expect(isStrongPassword('123456789')).toBe(false);
  });

  it('isCode e isUuid', () => {
    expect(isCode('012345')).toBe(true);
    for (const bad of ['12345', '1234567', 'abcdef', '12 345', 123456, null]) {
      expect(isCode(bad), String(bad)).toBe(false);
    }
    expect(isUuid(UUID)).toBe(true);
    for (const bad of ['', 'x', `${UUID}0`, '1; drop table', null, 5]) {
      expect(isUuid(bad), String(bad)).toBe(false);
    }
  });
});

describe('handlers validate their input', () => {
  const run = async (channel, payload) => {
    const service = serviceMock();
    const handlers = createAuthIpcHandlers({ service });
    const result = await handlers[channel](payload);
    return { result, service };
  };
  const signUp = (extra = {}) => ({
    fullName: 'Ana Souza',
    email: 'ana@escola.com',
    password: 'Senha1234',
    role: 'aluno',
    ...extra,
  });

  it('signUp: dados bons passam limpos e o papel vira "quer ser professor"', async () => {
    const student = await run(
      CHANNELS.signUp,
      signUp({ fullName: '  Ana   Souza ', email: ' ana@escola.com ' }),
    );
    expect(student.service.signUp).toHaveBeenCalledWith({
      fullName: 'Ana Souza',
      email: 'ana@escola.com',
      password: 'Senha1234',
      wantsTeacher: false,
    });
    const teacher = await run(CHANNELS.signUp, signUp({ role: 'professor' }));
    expect(teacher.service.signUp.mock.calls[0][0].wantsTeacher).toBe(true);
  });

  it.each([
    ['sem nome', { fullName: '   ' }],
    ['nome com caractere de controle', { fullName: 'Ana\u0007' }],
    ['nome com 81 letras', { fullName: 'x'.repeat(81) }],
    ['e-mail torto', { email: 'ana@' }],
    ['senha curta', { password: 'Ab1' }],
    ['senha só com letras', { password: 'somenteletras' }],
    ['senha com 73 caracteres', { password: `a1${'x'.repeat(71)}` }],
    ['papel inventado', { role: 'admin' }],
    ['papel de professor já aprovado', { role: 'service_role' }],
  ])('signUp recusa %s', async (_label, extra) => {
    const { result, service } = await run(CHANNELS.signUp, signUp(extra));
    expect(result).toMatchObject({ ok: false, error: 'bad-request' });
    expect(service.signUp).not.toHaveBeenCalled();
  });

  it.each([
    [CHANNELS.signUp, 'signUp'],
    [CHANNELS.verifyCode, 'verifyCode'],
    [CHANNELS.resendCode, 'resendCode'],
    [CHANNELS.signIn, 'signIn'],
    [CHANNELS.resetRequest, 'requestReset'],
    [CHANNELS.resetConfirm, 'confirmReset'],
    [CHANNELS.decideTeacher, 'decideTeacherRequest'],
  ])('%s recusa carga que não é objeto', async (channel, method) => {
    for (const payload of [undefined, null, 'texto', 42, [], true]) {
      const { result, service } = await run(channel, payload);
      expect(result, String(payload)).toMatchObject({ ok: false, error: 'bad-request' });
      expect(service[method]).not.toHaveBeenCalled();
    }
  });

  it('verifyCode, signIn, resetRequest e resetConfirm validam e repassam o limpo', async () => {
    const verify = await run(CHANNELS.verifyCode, { email: 'ana@escola.com', code: '123456' });
    expect(verify.service.verifyCode).toHaveBeenCalledWith({
      email: 'ana@escola.com',
      code: '123456',
    });
    expect(
      (await run(CHANNELS.verifyCode, { email: 'ana@escola.com', code: '12345' })).result,
    ).toMatchObject({ error: 'bad-request' });

    expect(
      (await run(CHANNELS.signIn, { email: 'ana@escola.com', password: 'curta' })).result,
    ).toMatchObject({
      error: 'bad-request',
    });
    expect((await run(CHANNELS.resetRequest, { email: 'x' })).result).toMatchObject({
      error: 'bad-request',
    });

    const reset = await run(CHANNELS.resetConfirm, {
      email: 'ana@escola.com',
      code: '123456',
      password: 'NovaSenha1',
      extra: 'ignorado',
    });
    expect(reset.service.confirmReset).toHaveBeenCalledWith({
      email: 'ana@escola.com',
      code: '123456',
      password: 'NovaSenha1',
    });
    expect(
      (
        await run(CHANNELS.resetConfirm, {
          email: 'ana@escola.com',
          code: '123456',
          password: 'semnumeros',
        })
      ).result,
    ).toMatchObject({ error: 'bad-request' });
  });

  it('decideTeacher só aceita um UUID e um booleano', async () => {
    const good = await run(CHANNELS.decideTeacher, { id: UUID, approve: true });
    expect(good.service.decideTeacherRequest).toHaveBeenCalledWith({ id: UUID, approve: true });
    for (const payload of [
      { id: 'x', approve: true },
      { id: UUID, approve: 'true' },
      { id: UUID },
      { approve: true },
    ]) {
      const { result, service } = await run(CHANNELS.decideTeacher, payload);
      expect(result).toMatchObject({ error: 'bad-request' });
      expect(service.decideTeacherRequest).not.toHaveBeenCalled();
    }
  });

  it('o estado e as ações sem carga repassam direto', async () => {
    const state = await run(CHANNELS.getState);
    expect(state.result).toEqual({ status: 'signed-out' });
    expect((await run(CHANNELS.noAccount)).service.useWithoutAccount).toHaveBeenCalled();
    expect((await run(CHANNELS.signOut)).service.signOut).toHaveBeenCalled();
    expect((await run(CHANNELS.teacherRequests)).service.listTeacherRequests).toHaveBeenCalled();
  });
});

describe('mensagens de erro', () => {
  it('traduz os códigos do Supabase e esconde o resto', () => {
    expect(describeAuthError({ code: 'invalid_credentials' }).message).toBe(
      'E-mail ou senha incorretos.',
    );
    expect(describeAuthError({ code: 'weak_password' }).code).toBe('weak_password');
    expect(describeAuthError({ code: 'refresh_token_not_found' }).code).toBe('session-expired');
    expect(describeAuthError({ code: '42501' }).code).toBe('not-teacher');
    expect(describeAuthError({ code: 'P0002' }).code).toBe('already-decided');
    const unknown = describeAuthError({
      code: 'algo_novo',
      message: 'detalhe interno do servidor',
    });
    expect(unknown.code).toBe('unknown');
    expect(unknown.message).not.toContain('detalhe interno');
    expect(describeAuthError(null).code).toBe('unknown');
  });

  it('reconhece falta de rede de várias formas', () => {
    expect(isNetworkError({ name: 'AuthRetryableFetchError', message: 'x' })).toBe(true);
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkError({ message: 'getaddrinfo ENOTFOUND abc.supabase.co' })).toBe(true);
    expect(isNetworkError({ code: 'timeout' })).toBe(true);
    expect(
      isNetworkError({ code: 'invalid_credentials', message: 'Invalid login credentials' }),
    ).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});
