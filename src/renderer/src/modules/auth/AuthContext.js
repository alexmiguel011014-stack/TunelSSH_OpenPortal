import { createContext, useContext } from 'react';

// O que o AuthGate entrega ao app: o estado das contas, quem a pessoa é para o app (accounts.js) e os
// pedidos de professor (só para professor). Nenhum token passa por aqui.
export const AuthContext = createContext(null);

const NO_REQUESTS = {
  list: [],
  loaded: false,
  loading: false,
  error: '',
  reload: () => {},
};

// Fora do AuthGate (testes, o painel do navegador sem preload) vale o app de sempre.
const FALLBACK = {
  auth: null,
  account: { kind: 'legacy' },
  requests: NO_REQUESTS,
  signOut: async () => ({ ok: true }),
};

export function useAuth() {
  return useContext(AuthContext) || FALLBACK;
}
