import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveAccount } from '../../shared/lib/accounts';
import { AuthContext } from './AuthContext';
import AuthScreen from './AuthScreen';
import { useTeacherRequests } from './useTeacherRequests';

// O tema escolhido é aplicado pelo App; esta tela aparece antes dele, então lê a mesma escolha.
function applyStoredTheme() {
  try {
    document.documentElement.setAttribute(
      'data-theme',
      localStorage.getItem('openportal-theme') || 'dark',
    );
  } catch {}
}

function Splash() {
  return (
    <div
      role="status"
      className="h-screen w-screen flex items-center justify-center bg-canvas text-text-faint text-sm"
    >
      Carregando...
    </div>
  );
}

// Envolve o app (GOALS 20): enquanto ninguém entrou (nem escolheu "Usar sem conta") mostra a tela de
// entrada; depois entrega o app e o papel da pessoa. Sem contas neste build, o app abre como sempre.
export default function AuthGate({ children }) {
  const [auth, setAuth] = useState(() =>
    window.electronAPI?.getAuthState ? null : { status: 'unconfigured' },
  );

  useEffect(() => {
    applyStoredTheme();
    const api = window.electronAPI;
    if (!api?.getAuthState) return undefined;
    let alive = true;
    // Assina primeiro: o estado que chegar por aqui vale mais que a resposta de getAuthState.
    const unsubscribe = api.onAuthState?.((state) => {
      if (alive) setAuth(state);
    });
    api
      .getAuthState()
      .then((state) => {
        if (alive) setAuth((current) => current ?? state);
      })
      .catch(() => {
        if (alive) setAuth((current) => current ?? { status: 'unconfigured' });
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const account = resolveAccount(auth);
  const requests = useTeacherRequests(account.kind === 'teacher');
  // "Sair" (quem entrou) e "Entrar" (quem escolheu "sem conta") levam à mesma tela de entrada.
  const signOut = useCallback(() => window.electronAPI?.authSignOut?.(), []);
  const value = useMemo(
    () => ({ auth, account, requests, signOut }),
    [auth, account, requests, signOut],
  );

  if (account.kind === 'loading') return <Splash />;
  if (account.kind === 'signed-out') return <AuthScreen auth={auth} />;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
