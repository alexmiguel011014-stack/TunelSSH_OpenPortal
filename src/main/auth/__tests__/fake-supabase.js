import { vi } from 'vitest';

// Um Supabase de mentira para os testes das contas: só as chamadas que o app usa. Cada método é um
// vi.fn() que devolve o que `script` mandar (ou um resultado de sucesso), para o teste montar o cenário
// sem rede. Nada aqui é a lógica de segurança: ela está no banco e é provada em supabase/tests.

export const SECRETS = {
  password: 'S3nhaSecreta123',
  accessToken: 'tok-access-AAA',
  refreshToken: 'tok-refresh-BBB',
};

export const USER_ID = '11111111-1111-4111-8111-111111111111';

export const profileRow = (extra = {}) => ({
  id: USER_ID,
  email: 'ana@escola.com',
  full_name: 'Ana Souza',
  role: 'aluno',
  teacher_requested_at: null,
  ...extra,
});

export const session = (id = USER_ID) => ({
  access_token: SECRETS.accessToken,
  refresh_token: SECRETS.refreshToken,
  user: { id },
});

export const authError = (code, extra = {}) =>
  Object.assign(new Error(code), { code, __isAuthError: true, ...extra });

export const networkError = () =>
  Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError', status: 0 });

// `profile`: o que a tabela devolve (uma linha, null, ou { error }); `list`: o resultado de uma consulta
// em lista. Ambos podem ser funções para mudar ao longo do teste.
export function createFakeSupabase({
  profile = profileRow(),
  list = [],
  currentSession = null,
} = {}) {
  let authListener = null;
  const state = { session: currentSession, profile, list };
  const resolve = (value) => (typeof value === 'function' ? value() : value);

  const query = (kind) => {
    const chain = {
      filters: [],
      select: vi.fn(() => chain),
      eq: vi.fn((column, value) => {
        chain.filters.push(['eq', column, value]);
        return chain;
      }),
      not: vi.fn((column, op, value) => {
        chain.filters.push(['not', column, op, value]);
        return chain;
      }),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => {
        const value = resolve(state.profile);
        if (value && value.error) return { data: null, error: value.error };
        return { data: value, error: null };
      }),
      then: (onFulfilled, onRejected) =>
        Promise.resolve()
          .then(() => {
            const value = resolve(state.list);
            if (value && value.error) return { data: null, error: value.error };
            return { data: value, error: null };
          })
          .then(onFulfilled, onRejected),
    };
    chain.kind = kind;
    return chain;
  };

  const ok = (data = {}) => vi.fn(async () => ({ data, error: null }));

  const client = {
    state,
    emitAuthEvent: (event) => authListener?.(event, state.session),
    auth: {
      onAuthStateChange: vi.fn((callback) => {
        authListener = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
      signUp: ok({ user: { id: USER_ID }, session: null }),
      verifyOtp: vi.fn(async () => ({
        data: { user: { id: USER_ID }, session: session() },
        error: null,
      })),
      resend: ok(),
      signInWithPassword: vi.fn(async () => ({
        data: { user: { id: USER_ID }, session: session() },
        error: null,
      })),
      signOut: vi.fn(async () => {
        state.session = null;
        authListener?.('SIGNED_OUT', null);
        return { error: null };
      }),
      resetPasswordForEmail: ok(),
      updateUser: ok({ user: { id: USER_ID } }),
      stopAutoRefresh: vi.fn(async () => {}),
    },
    from: vi.fn((table) => query(table)),
    rpc: ok(null),
  };
  return client;
}
