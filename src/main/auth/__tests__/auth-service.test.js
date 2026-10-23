import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_KEY, STORAGE_KEY, createAuthService } from '../auth-service.js';
import { MESSAGES } from '../errors.js';
import {
  SECRETS,
  USER_ID,
  authError,
  createFakeSupabase,
  networkError,
  profileRow,
  session,
} from './fake-supabase.js';

const CONFIG = { configured: true, url: 'https://abc.supabase.co', publishableKey: 'k' };
const EMAIL = 'ana@escola.com';

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function build({ client = createFakeSupabase(), store = memoryStore(), ...options } = {}) {
  const logs = [];
  const states = [];
  const createClient = vi.fn(() => client);
  const service = createAuthService({
    config: CONFIG,
    createClient,
    store,
    restoreTimeoutMs: 50,
    log: (line) => logs.push(line),
    ...options,
  });
  service.onState((state) => states.push(state));
  return { service, client, store, logs, states, createClient };
}

const stored = (profile, savedAt) =>
  JSON.stringify({
    profile: {
      id: USER_ID,
      email: EMAIL,
      fullName: 'Ana Souza',
      role: 'aluno',
      teacherPending: false,
      ...profile,
    },
    savedAt,
  });

describe('sem projeto configurado', () => {
  it('fica "unconfigured" e nenhuma ação funciona', async () => {
    const { service, createClient } = build({ config: { configured: false, reason: 'missing' } });
    await service.init();
    expect(service.getState().status).toBe('unconfigured');
    expect(createClient).not.toHaveBeenCalled();

    for (const result of [
      await service.signIn({ email: EMAIL, password: SECRETS.password }),
      await service.signUp({ fullName: 'A', email: EMAIL, password: SECRETS.password }),
      await service.signOut(),
      await service.listTeacherRequests(),
    ]) {
      expect(result).toMatchObject({ ok: false, error: 'unconfigured' });
    }
  });
});

describe('cadastro', () => {
  it('manda o nome e se quer ser professor; o papel não vai de lá (o banco decide)', async () => {
    const { service, client } = build();
    await service.init();

    await service.signUp({ fullName: 'Ana Souza', email: EMAIL, password: SECRETS.password });
    expect(client.auth.signUp).toHaveBeenLastCalledWith({
      email: EMAIL,
      password: SECRETS.password,
      options: { data: { full_name: 'Ana Souza', wants_teacher: false } },
    });

    await service.signUp({
      fullName: 'Pedro',
      email: 'pedro@escola.com',
      password: SECRETS.password,
      wantsTeacher: true,
    });
    const sent = client.auth.signUp.mock.calls[1][0].options.data;
    expect(sent).toEqual({ full_name: 'Pedro', wants_teacher: true });
    expect(Object.keys(sent)).not.toContain('role');
  });

  it('vai para a tela do código e lembra o e-mail', async () => {
    const { service } = build();
    await service.init();
    const result = await service.signUp({
      fullName: 'Ana',
      email: EMAIL,
      password: SECRETS.password,
    });
    expect(result).toEqual({ ok: true });
    expect(service.getState()).toMatchObject({
      status: 'awaiting-code',
      purpose: 'signup',
      email: EMAIL,
      profile: null,
    });
  });

  it('o projeto sem confirmação por e-mail já entra com a sessão do cadastro', async () => {
    const client = createFakeSupabase();
    client.auth.signUp.mockResolvedValue({
      data: { user: { id: USER_ID }, session: session() },
      error: null,
    });
    const { service } = build({ client });
    await service.init();
    const result = await service.signUp({
      fullName: 'Ana',
      email: EMAIL,
      password: SECRETS.password,
    });
    expect(result.ok).toBe(true);
    expect(service.getState().status).toBe('signed-in');
  });

  it('confirma com o código (type "email") e entra com o perfil do banco', async () => {
    const client = createFakeSupabase({
      profile: profileRow({ teacher_requested_at: '2026-10-22T10:00:00Z' }),
    });
    const { service } = build({ client });
    await service.init();
    await service.signUp({
      fullName: 'Ana',
      email: EMAIL,
      password: SECRETS.password,
      wantsTeacher: true,
    });

    const result = await service.verifyCode({ email: EMAIL, code: '123456' });
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      email: EMAIL,
      token: '123456',
      type: 'email',
    });
    expect(result.ok).toBe(true);
    expect(service.getState()).toMatchObject({
      status: 'signed-in',
      purpose: null,
      profile: { id: USER_ID, role: 'aluno', teacherPending: true, fullName: 'Ana Souza' },
    });
  });

  it('código errado ou vencido: mensagem em português e continua na tela do código', async () => {
    const client = createFakeSupabase();
    client.auth.verifyOtp.mockResolvedValue({ data: {}, error: authError('otp_expired') });
    const { service } = build({ client });
    await service.init();
    await service.signUp({ fullName: 'Ana', email: EMAIL, password: SECRETS.password });

    const result = await service.verifyCode({ email: EMAIL, code: '000000' });
    expect(result).toEqual({ ok: false, error: 'otp_expired', message: MESSAGES.otp_expired });
    expect(service.getState().status).toBe('awaiting-code');
  });

  it('reenviar: cadastro pede outro código de cadastro, recuperação pede outro de recuperação', async () => {
    const { service, client } = build();
    await service.init();
    await service.signUp({ fullName: 'Ana', email: EMAIL, password: SECRETS.password });
    await service.resendCode({ email: EMAIL });
    expect(client.auth.resend).toHaveBeenCalledWith({ type: 'signup', email: EMAIL });

    await service.requestReset({ email: EMAIL });
    await service.resendCode({ email: EMAIL });
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledTimes(2);
  });

  it('limite de e-mails e falta de rede viram frases claras', async () => {
    const client = createFakeSupabase();
    client.auth.signUp.mockResolvedValueOnce({
      data: {},
      error: authError('over_email_send_rate_limit'),
    });
    client.auth.signUp.mockRejectedValueOnce(networkError());
    const { service } = build({ client });
    await service.init();

    expect(
      await service.signUp({ fullName: 'A', email: EMAIL, password: SECRETS.password }),
    ).toMatchObject({
      error: 'over_email_send_rate_limit',
      message: MESSAGES.over_email_send_rate_limit,
    });
    expect(
      await service.signUp({ fullName: 'A', email: EMAIL, password: SECRETS.password }),
    ).toMatchObject({
      error: 'network',
      message: MESSAGES.network,
    });
  });
});

describe('entrada e saída', () => {
  it('entra com e-mail e senha e mostra o papel', async () => {
    const client = createFakeSupabase({ profile: profileRow({ role: 'professor' }) });
    const { service, store } = build({ client });
    await service.init();

    const result = await service.signIn({ email: EMAIL, password: SECRETS.password });
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: EMAIL,
      password: SECRETS.password,
    });
    expect(result.ok).toBe(true);
    expect(service.getState()).toMatchObject({
      status: 'signed-in',
      profile: { role: 'professor', teacherPending: false },
    });
    // o perfil fica guardado junto da sessão para abrir sem rede
    expect(JSON.parse(store.getItem(PROFILE_KEY)).profile.role).toBe('professor');
  });

  it('senha errada e e-mail desconhecido dão exatamente a mesma resposta', async () => {
    const client = createFakeSupabase();
    client.auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: authError('invalid_credentials'),
    });
    const { service } = build({ client });
    await service.init();

    const wrongPassword = await service.signIn({ email: EMAIL, password: 'errada123' });
    const unknownEmail = await service.signIn({
      email: 'ninguem@escola.com',
      password: 'errada123',
    });
    expect(wrongPassword).toEqual(unknownEmail);
    expect(wrongPassword).toEqual({
      ok: false,
      error: 'invalid_credentials',
      message: 'E-mail ou senha incorretos.',
    });
    expect(service.getState().status).toBe('signed-out');
  });

  it('e-mail não confirmado leva à tela do código, já pedindo para reenviar', async () => {
    const client = createFakeSupabase();
    client.auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: authError('email_not_confirmed'),
    });
    const { service } = build({ client });
    await service.init();

    const result = await service.signIn({ email: EMAIL, password: SECRETS.password });
    expect(result.error).toBe('email_not_confirmed');
    expect(service.getState()).toMatchObject({
      status: 'awaiting-code',
      purpose: 'signup',
      email: EMAIL,
      needsResend: true,
    });
  });

  it('conta sem perfil no banco: sai e explica', async () => {
    const { service } = build({ client: createFakeSupabase({ profile: null }) });
    await service.init();
    const result = await service.signIn({ email: EMAIL, password: SECRETS.password });
    expect(result).toMatchObject({ ok: false, error: 'no-profile' });
    expect(service.getState().status).toBe('signed-out');
  });

  it('sair encerra só esta sessão (scope local) e esquece o perfil guardado', async () => {
    const { service, client, store } = build();
    await service.init();
    await service.signIn({ email: EMAIL, password: SECRETS.password });

    expect(await service.signOut()).toEqual({ ok: true });
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(store.getItem(PROFILE_KEY)).toBeNull();
    expect(service.getState()).toMatchObject({
      status: 'signed-out',
      profile: null,
      noAccount: false,
    });
  });

  it('"Usar sem conta" vale só enquanto ninguém entrou, e entrar desfaz', async () => {
    const { service } = build();
    await service.init();
    service.useWithoutAccount();
    expect(service.getState()).toMatchObject({ status: 'signed-out', noAccount: true });

    await service.signIn({ email: EMAIL, password: SECRETS.password });
    expect(service.getState()).toMatchObject({ status: 'signed-in', noAccount: false });
    service.useWithoutAccount();
    expect(service.getState().noAccount).toBe(false);
  });

  it('a sessão revogada no servidor derruba o app para a tela de entrada, com aviso', async () => {
    vi.useFakeTimers();
    try {
      const { service, client } = build();
      await service.init();
      await service.signIn({ email: EMAIL, password: SECRETS.password });
      client.emitAuthEvent('SIGNED_OUT');
      await vi.advanceTimersByTimeAsync(1);
      expect(service.getState()).toMatchObject({
        status: 'signed-out',
        profile: null,
        notice: MESSAGES['session-expired'],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('senha esquecida', () => {
  it('pede o código sem revelar se o e-mail tem conta e depois troca a senha', async () => {
    const { service, client } = build();
    await service.init();

    expect(await service.requestReset({ email: 'ninguem@escola.com' })).toEqual({ ok: true });
    expect(service.getState()).toMatchObject({ status: 'awaiting-code', purpose: 'recovery' });

    const result = await service.confirmReset({
      email: EMAIL,
      code: '123456',
      password: 'NovaSenha123',
    });
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      email: EMAIL,
      token: '123456',
      type: 'recovery',
    });
    expect(client.auth.updateUser).toHaveBeenCalledWith({ password: 'NovaSenha123' });
    expect(result.ok).toBe(true);
    expect(service.getState().status).toBe('signed-in');
  });

  it('código inválido: nada é trocado', async () => {
    const client = createFakeSupabase();
    client.auth.verifyOtp.mockResolvedValue({ data: {}, error: authError('otp_expired') });
    const { service } = build({ client });
    await service.init();
    const result = await service.confirmReset({
      email: EMAIL,
      code: '000000',
      password: 'NovaSenha123',
    });
    expect(result.error).toBe('otp_expired');
    expect(client.auth.updateUser).not.toHaveBeenCalled();
  });

  it('se a senha nova for recusada depois do código, sai da sessão de recuperação', async () => {
    const client = createFakeSupabase();
    client.auth.updateUser.mockResolvedValue({ data: {}, error: authError('same_password') });
    const { service } = build({ client });
    await service.init();
    const result = await service.confirmReset({
      email: EMAIL,
      code: '123456',
      password: 'Repetida123',
    });
    expect(result).toMatchObject({ ok: false, error: 'same_password' });
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(service.getState().status).toBe('signed-out');
  });
});

describe('abertura do app', () => {
  it('sem sessão guardada abre na tela de entrada', async () => {
    const { service } = build();
    await service.init();
    expect(service.getState()).toMatchObject({ status: 'signed-out', profile: null });
  });

  it('com sessão guardada entra direto, com o perfil atual do banco', async () => {
    const client = createFakeSupabase({
      currentSession: session(),
      profile: profileRow({ role: 'professor' }),
    });
    const { service } = build({ client });
    await service.init();
    expect(service.getState()).toMatchObject({
      status: 'signed-in',
      profile: { role: 'professor' },
    });
  });

  it('sem rede, com sessão e perfil guardados há menos de 7 dias: abre "offline" com o papel de antes', async () => {
    const now = Date.UTC(2026, 9, 22);
    const store = memoryStore({
      [STORAGE_KEY]: '{"sessão":"guardada"}',
      [PROFILE_KEY]: stored({ role: 'professor' }, now - 6 * 24 * 60 * 60 * 1000),
    });
    const client = createFakeSupabase({
      currentSession: session(),
      profile: { error: networkError() },
    });
    const { service } = build({ client, store, now: () => now });
    await service.init();
    expect(service.getState()).toMatchObject({ status: 'offline', profile: { role: 'professor' } });
  });

  it('perfil guardado há mais de 7 dias não vale: pede para entrar, explicando', async () => {
    const now = Date.UTC(2026, 9, 22);
    const store = memoryStore({
      [STORAGE_KEY]: '{"sessão":"guardada"}',
      [PROFILE_KEY]: stored({ role: 'professor' }, now - 8 * 24 * 60 * 60 * 1000),
    });
    const client = createFakeSupabase({
      currentSession: session(),
      profile: { error: networkError() },
    });
    const { service } = build({ client, store, now: () => now });
    await service.init();
    expect(service.getState()).toMatchObject({
      status: 'signed-out',
      profile: null,
      notice: MESSAGES.network,
    });
  });

  it('servidor que nem responde (pausado) também cai no perfil guardado', async () => {
    const now = Date.UTC(2026, 9, 22);
    const store = memoryStore({
      [STORAGE_KEY]: '{"sessão":"guardada"}',
      [PROFILE_KEY]: stored({}, now - 1000),
    });
    const client = createFakeSupabase({ currentSession: session() });
    client.auth.getSession.mockImplementation(() => new Promise(() => {}));
    const { service } = build({ client, store, now: () => now, restoreTimeoutMs: 20 });
    await service.init();
    expect(service.getState()).toMatchObject({ status: 'offline', profile: { role: 'aluno' } });
  });

  it('token recusado pelo servidor (não é falta de rede): esquece a sessão e avisa', async () => {
    const client = createFakeSupabase({
      currentSession: session(),
      profile: { error: { code: 'PGRST303', message: 'JWT expired' } },
    });
    const { service, store } = build({ client });
    store.setItem(PROFILE_KEY, stored({}, Date.now()));
    await service.init();
    expect(service.getState()).toMatchObject({
      status: 'signed-out',
      notice: MESSAGES['session-expired'],
    });
    expect(store.getItem(PROFILE_KEY)).toBeNull();
  });

  describe('com o relógio controlado', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('offline volta a "signed-in" sozinho quando o servidor responde', async () => {
      const now = Date.now();
      const store = memoryStore({
        [STORAGE_KEY]: '{"sessão":"guardada"}',
        [PROFILE_KEY]: stored({ role: 'professor' }, now),
      });
      let online = false;
      const client = createFakeSupabase({
        currentSession: session(),
        profile: () => (online ? profileRow({ role: 'professor' }) : { error: networkError() }),
      });
      const { service } = build({ client, store, retryOnlineMs: 1000, restoreTimeoutMs: 500 });
      await service.init();
      expect(service.getState().status).toBe('offline');

      online = true;
      await vi.advanceTimersByTimeAsync(1100);
      expect(service.getState()).toMatchObject({
        status: 'signed-in',
        profile: { role: 'professor' },
      });
      service.stop();
    });

    it('professor pendente: relê o perfil a cada minuto e vira professor sem reabrir o app', async () => {
      let row = profileRow({ teacher_requested_at: '2026-10-22T10:00:00Z' });
      const client = createFakeSupabase({ currentSession: session(), profile: () => row });
      const { service } = build({ client, pendingPollMs: 60_000, restoreTimeoutMs: 500 });
      await service.init();
      expect(service.getState().profile).toMatchObject({ role: 'aluno', teacherPending: true });

      row = profileRow({ role: 'professor', teacher_requested_at: null });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(service.getState().profile).toMatchObject({
        role: 'professor',
        teacherPending: false,
      });

      const fetches = client.from.mock.calls.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(client.from.mock.calls.length).toBe(fetches); // parou de perguntar
      service.stop();
    });
  });
});

describe('pedidos de professor', () => {
  const asTeacher = async (extra = {}) => {
    const client = createFakeSupabase({
      currentSession: session(),
      profile: profileRow({ role: 'professor' }),
      list: [
        {
          id: 'a',
          email: 'a@x.com',
          full_name: 'Aluno A',
          teacher_requested_at: '2026-10-01T10:00:00Z',
        },
        {
          id: 'b',
          email: 'b@x.com',
          full_name: 'Aluno B',
          teacher_requested_at: '2026-10-02T10:00:00Z',
        },
      ],
      ...extra,
    });
    const built = build({ client });
    await built.service.init();
    return built;
  };

  it('um professor lista os pedidos pendentes', async () => {
    const { service } = await asTeacher();
    const result = await service.listTeacherRequests();
    expect(result).toEqual({
      ok: true,
      requests: [
        { id: 'a', email: 'a@x.com', fullName: 'Aluno A', requestedAt: '2026-10-01T10:00:00Z' },
        { id: 'b', email: 'b@x.com', fullName: 'Aluno B', requestedAt: '2026-10-02T10:00:00Z' },
      ],
    });
  });

  it('um aluno (ou professor pendente) não lista nem decide, e o banco nem é consultado', async () => {
    const client = createFakeSupabase({ currentSession: session(), profile: profileRow() });
    const { service } = build({ client });
    await service.init();
    const tablesBefore = client.from.mock.calls.length;

    expect(await service.listTeacherRequests()).toMatchObject({ ok: false, error: 'not-teacher' });
    expect(await service.decideTeacherRequest({ id: 'a', approve: true })).toMatchObject({
      ok: false,
      error: 'not-teacher',
    });
    expect(client.from.mock.calls.length).toBe(tablesBefore);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('aprovar e recusar chamam as funções do banco com o id do aluno', async () => {
    const { service, client } = await asTeacher();
    await service.decideTeacherRequest({ id: 'a', approve: true });
    await service.decideTeacherRequest({ id: 'b', approve: false });
    expect(client.rpc.mock.calls).toEqual([
      ['approve_teacher', { target: 'a' }],
      ['refuse_teacher', { target: 'b' }],
    ]);
  });

  it('pedido já decidido por outro professor e perda de permissão têm mensagens próprias', async () => {
    const { service, client } = await asTeacher();
    client.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'no pending' },
    });
    client.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'only a teacher' },
    });
    expect(await service.decideTeacherRequest({ id: 'a', approve: true })).toMatchObject({
      error: 'already-decided',
      message: MESSAGES['already-decided'],
    });
    expect(await service.decideTeacherRequest({ id: 'a', approve: true })).toMatchObject({
      error: 'not-teacher',
    });
  });
});

describe('segredos', () => {
  it('nenhum log, estado ou resposta carrega senha, token ou código', async () => {
    const client = createFakeSupabase({ profile: profileRow({ role: 'professor' }) });
    const { service, logs, states } = build({ client });
    const results = [];
    await service.init();
    results.push(
      await service.signUp({ fullName: 'Ana', email: EMAIL, password: SECRETS.password }),
    );
    results.push(await service.verifyCode({ email: EMAIL, code: '654321' }));
    results.push(await service.signOut());
    results.push(await service.signIn({ email: EMAIL, password: SECRETS.password }));
    results.push(await service.requestReset({ email: EMAIL }));
    results.push(
      await service.confirmReset({ email: EMAIL, code: '654321', password: 'OutraSenha123' }),
    );
    client.auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: authError('invalid_credentials'),
    });
    results.push(await service.signIn({ email: EMAIL, password: SECRETS.password }));

    const everything = JSON.stringify({ logs, states, results, now: service.getState() });
    for (const secret of [
      SECRETS.password,
      SECRETS.accessToken,
      SECRETS.refreshToken,
      'OutraSenha123',
      '654321',
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
    // O e-mail aparece no estado (a tela precisa dele), mas nunca nos logs.
    expect(logs.join('\n')).not.toContain(EMAIL);
    expect(logs.length).toBeGreaterThan(0);
  });
});
