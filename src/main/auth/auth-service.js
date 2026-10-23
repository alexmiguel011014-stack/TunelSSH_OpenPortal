'use strict';

// Contas do app (GOALS 20) no processo principal: cadastro, código por e-mail, entrada, recuperação
// de senha e o perfil (aluno ou professor). O supabase-js vive só aqui; a tela recebe o estado abaixo
// e nunca um token. Cada função devolve { ok: true, ... } ou { ok: false, error, message }.
//
// Estado enviado à tela:
//   status   loading | unconfigured | signed-out | awaiting-code | signed-in | offline
//   profile  { id, email, fullName, role: 'aluno' | 'professor', teacherPending } ou null
//   purpose  signup | recovery (só em awaiting-code), email, needsResend
//   noAccount  a pessoa escolheu "Usar sem conta (só este PC)" nesta abertura
//   notice   um aviso para a tela de entrada ("Sua sessão expirou...")

const { MESSAGES, describeAuthError, isNetworkError } = require('./errors');

const STORAGE_KEY = 'openportal-auth';
const PROFILE_KEY = 'openportal-profile';
const OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_TIMEOUT_MS = 8000;
const RETRY_ONLINE_MS = 60 * 1000;
const PENDING_POLL_MS = 60 * 1000;
const PROFILE_COLUMNS = 'id,email,full_name,role,teacher_requested_at';

const SIGNED_OUT = Object.freeze({
  status: 'signed-out',
  profile: null,
  purpose: null,
  email: '',
  needsResend: false,
});

function toProfile(row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') return null;
  const role = row.role === 'professor' ? 'professor' : 'aluno';
  return {
    id: row.id,
    email: String(row.email || ''),
    fullName: String(row.full_name ?? row.fullName ?? ''),
    role,
    teacherPending: role === 'aluno' && Boolean(row.teacher_requested_at ?? row.teacherPending),
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createAuthService({
  config,
  createClient,
  store,
  clientOptions = {},
  now = Date.now,
  restoreTimeoutMs = RESTORE_TIMEOUT_MS,
  retryOnlineMs = RETRY_ONLINE_MS,
  pendingPollMs = PENDING_POLL_MS,
  log = () => {},
}) {
  let client = null;
  let state = {
    status: 'loading',
    noAccount: false,
    profile: null,
    purpose: null,
    email: '',
    needsResend: false,
    notice: '',
  };
  const listeners = new Set();
  let retryTimer = null;
  let pendingTimer = null;

  const snapshot = () => ({ ...state, profile: state.profile ? { ...state.profile } : null });

  function setState(patch) {
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    const copy = snapshot();
    for (const listener of listeners) {
      try {
        listener(copy);
      } catch {}
    }
  }

  const unavailable = () => ({ ok: false, error: 'unconfigured', message: MESSAGES.unconfigured });

  function fail(error) {
    const info = describeAuthError(error);
    log(`falha (${info.code})`);
    return { ok: false, error: info.code, message: info.message };
  }

  // ---- perfil guardado (cifrado junto com a sessão) para abrir sem rede ----
  function saveProfile(profile) {
    try {
      store.setItem(PROFILE_KEY, JSON.stringify({ profile, savedAt: now() }));
    } catch {}
  }

  function savedProfile() {
    try {
      const saved = JSON.parse(store.getItem(PROFILE_KEY));
      if (!saved || !Number.isFinite(saved.savedAt)) return null;
      if (now() - saved.savedAt > OFFLINE_MAX_AGE_MS) return null;
      return toProfile(saved.profile);
    } catch {
      return null;
    }
  }

  const hasStoredSession = () => store.getItem(STORAGE_KEY) != null;

  // ---- temporizadores ----
  function stopRetry() {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
  }

  function stopPendingPoll() {
    if (pendingTimer) clearInterval(pendingTimer);
    pendingTimer = null;
  }

  // Um professor pendente vê a aprovação sem reabrir o app: o perfil é relido a cada minuto.
  function syncPendingPoll() {
    const waiting = state.status === 'signed-in' && state.profile?.teacherPending === true;
    if (!waiting) return stopPendingPoll();
    if (pendingTimer) return undefined;
    pendingTimer = setInterval(() => {
      refreshProfile().catch(() => {});
    }, pendingPollMs);
    pendingTimer.unref?.();
    return undefined;
  }

  // ---- entrar e sair do estado "conectado" ----
  function enterSignedIn(profile) {
    saveProfile(profile);
    stopRetry();
    setState({
      status: 'signed-in',
      profile,
      purpose: null,
      email: '',
      needsResend: false,
      notice: '',
      noAccount: false,
    });
    syncPendingPoll();
  }

  async function loadProfile(userId) {
    const { data, error } = await client
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return toProfile(data);
  }

  async function dropSession(notice = '') {
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch {}
    store.removeItem(PROFILE_KEY);
    stopRetry();
    stopPendingPoll();
    setState({ ...SIGNED_OUT, notice });
  }

  // Depois de qualquer autenticação que deu certo: busca o perfil e libera o app.
  async function finishSession(userId) {
    try {
      const profile = await loadProfile(userId);
      if (!profile) {
        await dropSession();
        return { ok: false, error: 'no-profile', message: MESSAGES['no-profile'] };
      }
      enterSignedIn(profile);
      return { ok: true, profile: { ...profile } };
    } catch (error) {
      return fail(error);
    }
  }

  // ---- abertura do app ----
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      if (state.status !== 'offline') return stopRetry();
      return restore().catch(() => {});
    }, retryOnlineMs);
    retryTimer.unref?.();
  }

  // Sem rede, mas com sessão guardada e um perfil recente: o app abre com o papel de antes.
  function goOffline() {
    const profile = savedProfile();
    if (!profile || !hasStoredSession()) {
      setState({ ...SIGNED_OUT, notice: MESSAGES.network });
      return;
    }
    log('sem conexão com o servidor de contas; usando o perfil guardado');
    setState({ status: 'offline', profile, purpose: null, email: '', needsResend: false });
    scheduleRetry();
  }

  async function restoreWithSession(session) {
    try {
      const profile = await withTimeout(loadProfile(session.user.id), restoreTimeoutMs);
      if (!profile) return dropSession();
      return enterSignedIn(profile);
    } catch (error) {
      if (isNetworkError(error)) return goOffline();
      return dropSession(MESSAGES['session-expired']);
    }
  }

  async function restore() {
    let session = null;
    let failure = null;
    try {
      const { data, error } = await withTimeout(client.auth.getSession(), restoreTimeoutMs);
      session = data?.session || null;
      failure = error || null;
    } catch (error) {
      failure = error;
    }
    if (session) return restoreWithSession(session);
    if (failure && isNetworkError(failure) && hasStoredSession()) return goOffline();
    // Sem sessão (nunca entrou, ou o servidor recusou a guardada): esquece o perfil que sobrou e, se
    // havia uma sessão que deixou de valer, avisa.
    const hadProfile = store.getItem(PROFILE_KEY) != null;
    store.removeItem(PROFILE_KEY);
    return setState({
      ...SIGNED_OUT,
      notice: failure && hadProfile ? MESSAGES['session-expired'] : '',
    });
  }

  async function init() {
    if (!config.configured) {
      setState({ status: 'unconfigured', profile: null });
      return;
    }
    client = createClient(config.url, config.publishableKey, {
      auth: {
        storage: store,
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      // Sem as repetições automáticas das consultas (1 s, 2 s e 4 s depois de uma falha de rede): sem
      // internet o app cai no modo offline na hora em vez de esperar 7 segundos, e este serviço já
      // tem a própria volta (relê o perfil a cada minuto).
      db: { retry: false },
      global: { headers: { 'X-Client-Info': 'openportal-remote' } },
      ...clientOptions,
    });
    // O supabase-js avisa para não chamar outro método dele dentro desta função: adia.
    client.auth.onAuthStateChange((event) => {
      if (event !== 'SIGNED_OUT') return;
      setTimeout(() => {
        if (state.status !== 'signed-in' && state.status !== 'offline') return;
        store.removeItem(PROFILE_KEY);
        stopRetry();
        stopPendingPoll();
        setState({ ...SIGNED_OUT, notice: MESSAGES['session-expired'] });
      }, 0);
    });
    setState({ status: 'loading' });
    await restore();
  }

  // ---- cadastro e entrada ----
  async function signUp({ fullName, email, password, wantsTeacher = false }) {
    if (!client) return unavailable();
    try {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName, wants_teacher: wantsTeacher === true } },
      });
      if (error) return fail(error);
      // Projeto sem "Confirm email": já veio com sessão.
      if (data?.session && data.user) return finishSession(data.user.id);
      setState({
        status: 'awaiting-code',
        purpose: 'signup',
        email,
        needsResend: false,
        notice: '',
      });
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }

  async function verifyCode({ email, code }) {
    if (!client) return unavailable();
    const type = state.purpose === 'recovery' ? 'recovery' : 'email';
    try {
      const { data, error } = await client.auth.verifyOtp({ email, token: code, type });
      if (error) return fail(error);
      if (!data?.user) return fail(null);
      return finishSession(data.user.id);
    } catch (error) {
      return fail(error);
    }
  }

  async function resendCode({ email }) {
    if (!client) return unavailable();
    try {
      const { error } =
        state.purpose === 'recovery'
          ? await client.auth.resetPasswordForEmail(email)
          : await client.auth.resend({ type: 'signup', email });
      if (error) return fail(error);
      setState({ needsResend: false });
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }

  async function signIn({ email, password }) {
    if (!client) return unavailable();
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        if (error.code === 'email_not_confirmed') {
          setState({ status: 'awaiting-code', purpose: 'signup', email, needsResend: true });
        }
        return fail(error);
      }
      return finishSession(data.user.id);
    } catch (error) {
      return fail(error);
    }
  }

  async function signOut() {
    if (!client) return unavailable();
    await dropSession();
    setState({ noAccount: false });
    return { ok: true };
  }

  // ---- senha esquecida: código por e-mail, depois a senha nova ----
  async function requestReset({ email }) {
    if (!client) return unavailable();
    try {
      const { error } = await client.auth.resetPasswordForEmail(email);
      // Sem erro de "e-mail desconhecido": quem pede nunca descobre se há conta.
      if (error) return fail(error);
      setState({
        status: 'awaiting-code',
        purpose: 'recovery',
        email,
        needsResend: false,
        notice: '',
      });
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }

  async function confirmReset({ email, code, password }) {
    if (!client) return unavailable();
    try {
      const verified = await client.auth.verifyOtp({ email, token: code, type: 'recovery' });
      if (verified.error) return fail(verified.error);
      const updated = await client.auth.updateUser({ password });
      if (updated.error) {
        // O código já foi usado: a pessoa precisa pedir outro.
        await dropSession();
        return fail(updated.error);
      }
      return finishSession(verified.data.user.id);
    } catch (error) {
      return fail(error);
    }
  }

  function useWithoutAccount() {
    if (state.status === 'signed-in' || state.status === 'offline') return { ok: true };
    setState({ noAccount: true });
    return { ok: true };
  }

  // ---- perfil e pedidos de professor ----
  async function refreshProfile() {
    if (!client || !state.profile) return unavailable();
    if (state.status !== 'signed-in') return { ok: true };
    const result = await finishSession(state.profile.id);
    return result;
  }

  async function listTeacherRequests() {
    if (!client) return unavailable();
    if (state.profile?.role !== 'professor') {
      return { ok: false, error: 'not-teacher', message: MESSAGES['not-teacher'] };
    }
    try {
      const { data, error } = await client
        .from('profiles')
        .select('id,email,full_name,teacher_requested_at')
        .eq('role', 'aluno')
        .not('teacher_requested_at', 'is', null)
        .order('teacher_requested_at', { ascending: true })
        .limit(200);
      if (error) return fail(error);
      return {
        ok: true,
        requests: (data || []).map((row) => ({
          id: row.id,
          email: String(row.email || ''),
          fullName: String(row.full_name || ''),
          requestedAt: row.teacher_requested_at,
        })),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function decideTeacherRequest({ id, approve }) {
    if (!client) return unavailable();
    if (state.profile?.role !== 'professor') {
      return { ok: false, error: 'not-teacher', message: MESSAGES['not-teacher'] };
    }
    try {
      const { error } = await client.rpc(approve ? 'approve_teacher' : 'refuse_teacher', {
        target: id,
      });
      if (error) return fail(error);
      log(approve ? 'pedido de professor aprovado' : 'pedido de professor recusado');
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }

  function stop() {
    stopRetry();
    stopPendingPoll();
    try {
      client?.auth.stopAutoRefresh();
    } catch {}
    listeners.clear();
  }

  return {
    init,
    stop,
    getState: snapshot,
    getProfile: () => (state.profile ? { ...state.profile } : null),
    getClient: () => client,
    onState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signUp,
    verifyCode,
    resendCode,
    signIn,
    signOut,
    requestReset,
    confirmReset,
    useWithoutAccount,
    refreshProfile,
    listTeacherRequests,
    decideTeacherRequest,
  };
}

module.exports = {
  OFFLINE_MAX_AGE_MS,
  PROFILE_KEY,
  STORAGE_KEY,
  createAuthService,
  toProfile,
};
