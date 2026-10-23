import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createAccessService } from '../../access/access-service.js';
import { createHandoverPublisher } from '../../lab/handover-publisher.js';
import { PROFILE_KEY, STORAGE_KEY, createAuthService } from '../auth-service.js';
import { MESSAGES } from '../errors.js';
import { GOOD_CODE, startFakeSupabase } from './fake-gotrue-server.js';

// O app com o @supabase/supabase-js REAL falando com um servidor local (fake-gotrue-server.js): prova
// que os códigos de erro, as falhas de rede e as consultas que o app espera são mesmo o que a
// biblioteca produz. Sem rede externa, sem projeto Supabase.

const EMAIL = 'ana@escola.com';
const PASSWORD = 'Senha1234';

function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

let server;
const services = [];

beforeEach(async () => {
  server = await startFakeSupabase();
});

afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  await server.close();
});

function newService({ store = memoryStore(), url = server.url, ...options } = {}) {
  const service = createAuthService({
    config: { configured: true, url, publishableKey: 'sb_publishable_FAKEFAKEFAKEFAKEFAKE0000' },
    createClient,
    store,
    restoreTimeoutMs: 1500,
    ...options,
  });
  services.push(service);
  return { service, store };
}

async function signedUpStudent(options) {
  const built = newService(options);
  await built.service.init();
  await built.service.signUp({ fullName: 'Ana Souza', email: EMAIL, password: PASSWORD });
  const verified = await built.service.verifyCode({ email: EMAIL, code: GOOD_CODE });
  expect(verified.ok).toBe(true);
  return built;
}

describe('login com o supabase-js real', () => {
  it('senha errada e e-mail desconhecido: o código invalid_credentials chega e a frase é a mesma', async () => {
    const { service } = newService();
    await service.init();
    await service.signUp({ fullName: 'Ana', email: EMAIL, password: PASSWORD });
    await service.verifyCode({ email: EMAIL, code: GOOD_CODE });
    await service.signOut();

    const wrong = await service.signIn({ email: EMAIL, password: 'Errada1234' });
    const unknown = await service.signIn({ email: 'ninguem@escola.com', password: 'Errada1234' });
    expect(wrong).toEqual({
      ok: false,
      error: 'invalid_credentials',
      message: 'E-mail ou senha incorretos.',
    });
    expect(unknown).toEqual(wrong);
  });

  it('cadastro → código → entra com o perfil do banco; o papel não vai no pedido', async () => {
    const { service } = newService();
    await service.init();
    await service.signUp({
      fullName: 'Pedro',
      email: 'pedro@escola.com',
      password: PASSWORD,
      wantsTeacher: true,
    });

    const signUp = server.requests.find((r) => r.path === '/auth/v1/signup');
    expect(signUp.body.data).toEqual({ full_name: 'Pedro', wants_teacher: true });
    expect(JSON.stringify(signUp.body)).not.toContain('"role"');
    expect(service.getState()).toMatchObject({
      status: 'awaiting-code',
      purpose: 'signup',
      email: 'pedro@escola.com',
    });

    expect(await service.verifyCode({ email: 'pedro@escola.com', code: '000000' })).toMatchObject({
      ok: false,
      error: 'otp_expired',
    });
    const verify = server.requests.filter((r) => r.path === '/auth/v1/verify').at(-1);
    expect(verify.body).toMatchObject({
      type: 'email',
      token: '000000',
      email: 'pedro@escola.com',
    });

    expect((await service.verifyCode({ email: 'pedro@escola.com', code: GOOD_CODE })).ok).toBe(
      true,
    );
    expect(service.getState()).toMatchObject({
      status: 'signed-in',
      profile: { fullName: 'Pedro', role: 'aluno', teacherPending: true },
    });
    // O perfil foi lido com o filtro certo.
    const read = server.requests.find((r) => r.path === '/rest/v1/profiles');
    expect(read.query.id).toMatch(/^eq\./);
  });

  it('e-mail ainda não confirmado: a entrada leva à tela do código', async () => {
    const { service } = newService();
    await service.init();
    await service.signUp({ fullName: 'Ana', email: EMAIL, password: PASSWORD });
    await service.signOut(); // volta à tela de entrada sem confirmar

    const result = await service.signIn({ email: EMAIL, password: PASSWORD });
    expect(result.error).toBe('email_not_confirmed');
    expect(service.getState()).toMatchObject({ status: 'awaiting-code', needsResend: true });
  });

  it('limite de e-mails do servidor vira a frase certa', async () => {
    const { service } = newService();
    await service.init();
    server.state.rateLimitEmails = true;
    expect(await service.signUp({ fullName: 'Ana', email: EMAIL, password: PASSWORD })).toEqual({
      ok: false,
      error: 'over_email_send_rate_limit',
      message: MESSAGES.over_email_send_rate_limit,
    });
  });

  it('senha esquecida: código de recuperação, senha nova e entra', async () => {
    const { service } = await signedUpStudent();
    await service.signOut();

    expect(await service.requestReset({ email: EMAIL })).toEqual({ ok: true });
    expect(server.requests.some((r) => r.path === '/auth/v1/recover')).toBe(true);
    expect(service.getState()).toMatchObject({ status: 'awaiting-code', purpose: 'recovery' });

    const result = await service.confirmReset({
      email: EMAIL,
      code: GOOD_CODE,
      password: 'NovaSenha123',
    });
    expect(result.ok).toBe(true);
    expect(server.users.get(EMAIL).password).toBe('NovaSenha123');
    expect(service.getState().status).toBe('signed-in');
  });

  it('senha nova igual à antiga: o código da recuperação não fica preso numa sessão', async () => {
    const { service } = await signedUpStudent();
    await service.signOut();
    await service.requestReset({ email: EMAIL });
    const result = await service.confirmReset({
      email: EMAIL,
      code: GOOD_CODE,
      password: PASSWORD,
    });
    expect(result).toMatchObject({ ok: false, error: 'same_password' });
    expect(service.getState().status).toBe('signed-out');
  });

  it('sair encerra só esta sessão no servidor e esquece o perfil', async () => {
    const { service, store } = await signedUpStudent();
    expect(store.getItem(PROFILE_KEY)).not.toBeNull();
    await service.signOut();
    const logout = server.requests.find((r) => r.path === '/auth/v1/logout');
    expect(logout.query.scope).toBe('local');
    expect(store.getItem(PROFILE_KEY)).toBeNull();
    expect(store.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('abrir o app de novo com o supabase-js real', () => {
  it('uma sessão guardada entra direto, sem pedir a senha de novo', async () => {
    const { store } = await signedUpStudent();
    const passwordLogins = () =>
      server.requests.filter(
        (r) => r.path === '/auth/v1/token' && r.query.grant_type === 'password',
      ).length;
    const before = passwordLogins();

    const { service: restarted } = newService({ store });
    await restarted.init();
    expect(restarted.getState()).toMatchObject({
      status: 'signed-in',
      profile: { fullName: 'Ana Souza' },
    });
    expect(passwordLogins()).toBe(before);
  });

  it('servidor fora do ar, sessão e perfil recentes: abre "offline" com o papel de antes', async () => {
    const { store } = await signedUpStudent();
    await server.close();

    const { service } = newService({ store, restoreTimeoutMs: 5000 });
    const started = Date.now();
    await service.init();
    expect(service.getState()).toMatchObject({ status: 'offline', profile: { role: 'aluno' } });
    // O supabase-js repetiria a consulta por 7 s (1 s + 2 s + 4 s) se o app não desligasse isso: o
    // modo offline tem de vir da falha de rede, não do tempo limite.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('servidor fora do ar e token vencido: a falha de rede da biblioteca também cai no offline', async () => {
    const { store } = await signedUpStudent();
    const saved = JSON.parse(store.getItem(STORAGE_KEY));
    saved.expires_at = Math.floor(Date.now() / 1000) - 60;
    store.setItem(STORAGE_KEY, JSON.stringify(saved));
    await server.close();

    const { service } = newService({ store });
    await service.init();
    expect(service.getState().status).toBe('offline');
  });

  it('sem perfil guardado e sem servidor: pede para entrar, explicando a falta de conexão', async () => {
    const { store } = await signedUpStudent();
    store.removeItem(PROFILE_KEY);
    await server.close();
    const { service } = newService({ store });
    await service.init();
    expect(service.getState()).toMatchObject({ status: 'signed-out', notice: MESSAGES.network });
  });

  it('refresh token que o servidor não reconhece: volta para a tela de entrada', async () => {
    const { store } = await signedUpStudent();
    const saved = JSON.parse(store.getItem(STORAGE_KEY));
    saved.expires_at = Math.floor(Date.now() / 1000) - 60;
    saved.refresh_token = 'revogado';
    store.setItem(STORAGE_KEY, JSON.stringify(saved));

    const { service } = newService({ store });
    await service.init();
    expect(service.getState().status).toBe('signed-out');
    expect(store.getItem(PROFILE_KEY)).toBeNull();
  });
});

describe('consultas que o app faz, pela biblioteca real', () => {
  async function asTeacher() {
    const built = newService();
    await built.service.init();
    await built.service.signUp({ fullName: 'Prof', email: 'prof@escola.com', password: PASSWORD });
    await built.service.verifyCode({ email: 'prof@escola.com', code: GOOD_CODE });
    const id = server.users.get('prof@escola.com').id;
    server.profiles.get(id).role = 'professor';
    server.profiles.get(id).teacher_requested_at = null;
    await built.service.signOut();
    await built.service.signIn({ email: 'prof@escola.com', password: PASSWORD });
    expect(built.service.getState().profile.role).toBe('professor');
    return { ...built, id };
  }

  it('pedidos de professor: filtros eq/not.is e a função do banco com o parâmetro "target"', async () => {
    const { service } = await asTeacher();
    server.state.teacherRows = [
      {
        id: 'a',
        email: 'a@x.com',
        full_name: 'Aluno A',
        teacher_requested_at: '2026-10-01T10:00:00Z',
      },
    ];
    const listed = await service.listTeacherRequests();
    expect(listed.requests).toEqual([
      { id: 'a', email: 'a@x.com', fullName: 'Aluno A', requestedAt: '2026-10-01T10:00:00Z' },
    ]);
    const query = server.requests.filter((r) => r.path === '/rest/v1/profiles').at(-1).query;
    expect(query.role).toBe('eq.aluno');
    expect(query.teacher_requested_at).toBe('not.is.null');
    expect(query.order).toBe('teacher_requested_at.asc');

    await service.decideTeacherRequest({ id: 'a', approve: true });
    await service.decideTeacherRequest({ id: 'b', approve: false });
    const rpcs = server.requests.filter((r) => r.path.startsWith('/rest/v1/rpc/'));
    expect(rpcs.map((r) => [r.path, r.body])).toEqual([
      ['/rest/v1/rpc/approve_teacher', { target: 'a' }],
      ['/rest/v1/rpc/refuse_teacher', { target: 'b' }],
    ]);
  });

  it('busca de alunos, vínculos e acesso do aluno: as consultas têm o formato esperado', async () => {
    const { service } = await asTeacher();
    const access = createAccessService({
      auth: service,
      clipboard: {},
      rdpLauncher: { open: () => ({ ok: true }) },
    });

    await access.searchStudents('ana, (x)');
    const search = server.requests.filter((r) => r.path === '/rest/v1/profiles').at(-1).query;
    expect(search.role).toBe('eq.aluno');
    expect(search.or).toBe('(full_name.ilike.%ana x%,email.ilike.%ana x%)');
    expect(search.limit).toBe('20');

    await access.link({
      hostId: 'host-1',
      account: 'ana',
      label: 'Ana',
      studentId: '11111111-1111-4111-8111-111111111111',
    });
    const links = server.requests.filter((r) => r.path === '/rest/v1/lab_student_links');
    expect(links.map((r) => r.method)).toEqual(['DELETE', 'DELETE', 'POST']);
    expect(links[0].query).toMatchObject({ host_id: 'eq.host-1', windows_account: 'eq.ana' });
    expect(links[1].query).toMatchObject({
      host_id: 'eq.host-1',
      student_id: 'eq.11111111-1111-4111-8111-111111111111',
    });
    expect(links[2].body).toMatchObject({
      host_id: 'host-1',
      windows_account: 'ana',
      label: 'Ana',
    });
  });

  it('o publicador usa filtros e corpos corretos (apagar por PC, inserir, atualizar ends_at)', async () => {
    const { service } = await asTeacher();
    const publisher = createHandoverPublisher({
      getContext: () => ({ client: service.getClient(), profile: service.getProfile() }),
    });
    server.requests.length = 0;
    const published = await publisher.afterReserve('host-1', {
      ok: true,
      credentials: {
        reservationId: 'r-1',
        account: 'ana',
        userName: 'PC1\\ana',
        password: 'Xk29-pass-77',
        startBy: Date.UTC(2026, 9, 22, 15, 30),
        endsAt: Date.UTC(2026, 9, 22, 17, 0),
      },
      pc: { hostId: 'host-1', name: 'PC 1', host: '100.64.0.7' },
    });
    // Sem vínculo no servidor de mentira (lista vazia): avisa e não insere.
    expect(published.status).toBe('skipped');
    const handoverCalls = server.requests.filter((r) => r.path === '/rest/v1/lab_handovers');
    expect(handoverCalls.map((r) => r.method)).toEqual(['DELETE']);
    expect(handoverCalls[0].query).toEqual({ host_id: 'eq.host-1' });

    server.requests.length = 0;
    await publisher.afterExtend('host-1', { ok: true, endsAt: Date.UTC(2026, 9, 22, 18, 0) });
    const update = server.requests.find((r) => r.path === '/rest/v1/lab_handovers');
    expect(update.method).toBe('PATCH');
    expect(update.body).toEqual({ ends_at: '2026-10-22T18:00:00.000Z' });
    expect(update.query).toEqual({ host_id: 'eq.host-1' });
  });

  it('o aluno lê só os acessos que ainda valem, mais novo primeiro, e a linha vira o cartão', async () => {
    const { service } = await signedUpStudent();
    server.state.handoverRows = [
      {
        id: 'h-1',
        host_name: 'PC 1',
        host_address: '100.64.0.7',
        windows_user: 'PC1\\ana',
        password: 'Xk29-pass-77',
        start_by: '2026-10-22T15:30:00.000Z',
        ends_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    ];
    const access = createAccessService({
      auth: service,
      clipboard: {},
      rdpLauncher: { open: () => ({ ok: true }) },
    });
    const result = await access.mine();
    expect(result.ok).toBe(true);
    expect(result.access).toMatchObject({
      hostName: 'PC 1',
      address: '100.64.0.7',
      userName: 'PC1\\ana',
    });

    const query = server.requests.filter((r) => r.path === '/rest/v1/lab_handovers').at(-1).query;
    expect(query.ends_at).toMatch(/^gt\./);
    expect(query.order).toBe('ends_at.desc');
    expect(query.limit).toBe('1');
    expect(query.select).toBe('id,host_name,host_address,windows_user,password,start_by,ends_at');
  });
});
