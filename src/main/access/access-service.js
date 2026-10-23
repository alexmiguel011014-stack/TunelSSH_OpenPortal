'use strict';

// "Meu acesso" e os vínculos (GOALS 21), no processo principal. Duas metades:
//
//  - Professor: procura alunos pelo nome ou e-mail e vincula a conta do aplicativo de um aluno à
//    conta do Windows dele num PC do laboratório (tabela lab_student_links).
//  - Aluno: lê o acesso que o professor liberou (tabela lab_handovers), acompanha as mudanças em
//    tempo real e abre a Área de Trabalho Remota. A senha fica só neste processo e na tela do aluno;
//    "Copiar senha" passa por aqui para a área de transferência ser limpa depois de 1 minuto.
//
// Quem pode ler ou escrever o quê é decidido pelo banco (RLS, supabase/migrations); as checagens de
// papel daqui só evitam pedidos que o banco ia recusar de qualquer forma.

const { MESSAGES, describeAuthError } = require('../auth/errors');

const POLL_MS = 60 * 1000;
const CLIPBOARD_CLEAR_MS = 60 * 1000;
const HANDOVER_COLUMNS = 'id,host_name,host_address,windows_user,password,start_by,ends_at';

// Só letras, números, espaço e @ . _ + - entram na busca: o resto poderia mexer na sintaxe do filtro.
function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\p{L}\p{N} @._+-]/gu, '')
    .trim()
    .slice(0, 40);
}

function toAccess(row) {
  if (!row || typeof row !== 'object') return null;
  const endsAt = Date.parse(row.ends_at);
  if (!Number.isFinite(endsAt)) return null;
  const startBy = row.start_by ? Date.parse(row.start_by) : Number.NaN;
  return {
    id: String(row.id),
    hostName: String(row.host_name),
    address: String(row.host_address),
    userName: String(row.windows_user),
    password: String(row.password),
    startBy: Number.isFinite(startBy) ? startBy : null,
    endsAt,
  };
}

function createAccessService({
  auth,
  clipboard,
  rdpLauncher,
  now = Date.now,
  pollMs = POLL_MS,
  clipboardClearMs = CLIPBOARD_CLEAR_MS,
  onMineChanged = () => {},
  log = () => {},
}) {
  function failure(error) {
    const info = describeAuthError(error);
    log(`falha (${info.code})`);
    return { ok: false, error: info.code, message: info.message };
  }

  const unavailable = () => ({ ok: false, error: 'unconfigured', message: MESSAGES.unconfigured });
  const notTeacher = () => ({ ok: false, error: 'not-teacher', message: MESSAGES['not-teacher'] });

  function teacherContext() {
    const client = auth.getClient();
    if (!client) return { error: unavailable() };
    const profile = auth.getProfile();
    if (profile?.role !== 'professor') return { error: notTeacher() };
    return { client, profile };
  }

  // ---- professor: alunos e vínculos ----

  async function searchStudents(query) {
    const ctx = teacherContext();
    if (ctx.error) return ctx.error;
    const text = cleanQuery(query);
    try {
      let request = ctx.client
        .from('profiles')
        .select('id,email,full_name')
        .eq('role', 'aluno')
        .order('full_name', { ascending: true })
        .limit(20);
      if (text) request = request.or(`full_name.ilike.%${text}%,email.ilike.%${text}%`);
      const { data, error } = await request;
      if (error) return failure(error);
      return {
        ok: true,
        students: (data || []).map((row) => ({
          id: row.id,
          email: String(row.email || ''),
          fullName: String(row.full_name || ''),
        })),
      };
    } catch (error) {
      return failure(error);
    }
  }

  async function listLinks(hostId) {
    const ctx = teacherContext();
    if (ctx.error) return ctx.error;
    try {
      const links = await ctx.client
        .from('lab_student_links')
        .select('windows_account,student_id,label,linked_at')
        .eq('host_id', hostId);
      if (links.error) return failure(links.error);
      const rows = links.data || [];
      const people = new Map();
      if (rows.length > 0) {
        const profiles = await ctx.client
          .from('profiles')
          .select('id,email,full_name')
          .in(
            'id',
            rows.map((row) => row.student_id),
          );
        if (profiles.error) return failure(profiles.error);
        for (const person of profiles.data || []) people.set(person.id, person);
      }
      return {
        ok: true,
        links: rows.map((row) => ({
          account: row.windows_account,
          studentId: row.student_id,
          label: row.label,
          email: String(people.get(row.student_id)?.email || ''),
          fullName: String(people.get(row.student_id)?.full_name || ''),
        })),
      };
    } catch (error) {
      return failure(error);
    }
  }

  // Vincula (ou troca o vínculo): a conta do Windows e o aluno só podem ter um vínculo cada em
  // cada PC, então os antigos saem antes do novo entrar.
  async function link({ hostId, account, label, studentId }) {
    const ctx = teacherContext();
    if (ctx.error) return ctx.error;
    const table = () => ctx.client.from('lab_student_links');
    try {
      let result = await table().delete().eq('host_id', hostId).eq('windows_account', account);
      if (result.error) return failure(result.error);
      result = await table().delete().eq('host_id', hostId).eq('student_id', studentId);
      if (result.error) return failure(result.error);
      result = await table().insert({
        host_id: hostId,
        windows_account: account,
        student_id: studentId,
        label,
        linked_by: ctx.profile.id,
      });
      if (result.error) return failure(result.error);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async function unlink({ hostId, account }) {
    const ctx = teacherContext();
    if (ctx.error) return ctx.error;
    try {
      const result = await ctx.client
        .from('lab_student_links')
        .delete()
        .eq('host_id', hostId)
        .eq('windows_account', account);
      if (result.error) return failure(result.error);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  // ---- aluno: o acesso liberado ----

  let current = null; // { id, hostName, address, userName, password, startBy, endsAt }: só aqui
  let lastPushed = 'null';
  let channel = null;
  let timer = null;
  let watchingFor = null;
  let clearTimer = null;

  function studentContext() {
    const state = auth.getState();
    const client = auth.getClient();
    if (!client || (state.status !== 'signed-in' && state.status !== 'offline')) return null;
    if (state.profile?.role !== 'aluno') return null;
    return { client, profile: state.profile };
  }

  // O acesso que vale agora (já vencido não vale, mesmo que a releitura ainda não tenha chegado).
  const activeAccess = () => (current && current.endsAt > now() ? { ...current } : null);

  async function mine() {
    const ctx = studentContext();
    if (!ctx) {
      current = null;
      return { ok: true, access: null };
    }
    try {
      const { data, error } = await ctx.client
        .from('lab_handovers')
        .select(HANDOVER_COLUMNS)
        .gt('ends_at', new Date(now()).toISOString())
        .order('ends_at', { ascending: false })
        .limit(1);
      if (error) return failure(error);
      current = data && data[0] ? toAccess(data[0]) : null;
      return { ok: true, access: activeAccess() };
    } catch (error) {
      return failure(error);
    }
  }

  function push(access) {
    const key = JSON.stringify(access);
    if (key === lastPushed) return;
    lastPushed = key;
    onMineChanged(access);
  }

  async function refresh() {
    const result = await mine();
    if (result.ok) push(result.access);
    return result;
  }

  function stopWatching() {
    if (timer) clearInterval(timer);
    timer = null;
    if (channel) {
      try {
        auth.getClient()?.removeChannel(channel);
      } catch {}
    }
    channel = null;
    watchingFor = null;
    current = null;
    push(null);
  }

  // Liga (ou desliga) o acompanhamento conforme quem está conectado: só aluno acompanha.
  function syncWatching() {
    const ctx = studentContext();
    if (!ctx) {
      if (watchingFor !== null || current !== null) stopWatching();
      return;
    }
    if (watchingFor === ctx.profile.id) return;
    stopWatching();
    watchingFor = ctx.profile.id;
    try {
      channel = ctx.client
        .channel(`lab-handovers-${ctx.profile.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_handovers' }, () => {
          refresh().catch(() => {});
        })
        .subscribe();
    } catch (err) {
      log(`não consegui acompanhar em tempo real: ${err.message}`);
    }
    timer = setInterval(() => {
      refresh().catch(() => {});
    }, pollMs);
    timer.unref?.();
    refresh().catch(() => {});
  }

  function openRdp() {
    const access = activeAccess();
    if (!access) {
      return { ok: false, error: 'no-access', message: 'Nenhum acesso liberado agora.' };
    }
    // Endereço e usuário vêm do que este processo leu do banco, nunca do que a tela mandar.
    return rdpLauncher.open({ address: access.address, userName: access.userName });
  }

  function copyPassword() {
    const access = activeAccess();
    if (!access) {
      return { ok: false, error: 'no-access', message: 'Nenhum acesso liberado agora.' };
    }
    const { password } = access;
    try {
      clipboard.writeText(password);
    } catch {
      return { ok: false, error: 'clipboard', message: 'Não consegui copiar a senha.' };
    }
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      clearTimer = null;
      try {
        if (clipboard.readText() === password) clipboard.clear();
      } catch {}
    }, clipboardClearMs);
    clearTimer.unref?.();
    return { ok: true, clearsInSeconds: Math.round(clipboardClearMs / 1000) };
  }

  function stop() {
    stopWatching();
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
  }

  return {
    searchStudents,
    listLinks,
    link,
    unlink,
    mine,
    refresh,
    syncWatching,
    openRdp,
    copyPassword,
    stop,
  };
}

module.exports = { cleanQuery, createAccessService, toAccess };
