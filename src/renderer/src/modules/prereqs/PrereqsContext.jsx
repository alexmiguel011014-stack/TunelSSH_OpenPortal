import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// O estado dos programas necessários (Tailscale e TightVNC, GOALS 22) para o app todo: lido ao abrir
// e de novo quando a janela volta ao foco (quem foi entrar no Tailscale volta e o cartão some sozinho).
// A instalação e a detecção são do processo principal (src/main/system/prerequisites*.js).
export const PrereqsContext = createContext(null);

// Fora do provedor (testes, painel do navegador sem preload) nada é bloqueado.
const FALLBACK = {
  prerequisites: null,
  loaded: false,
  busy: '',
  notice: null,
  refresh: async () => {},
  install: async () => {},
  openTailscale: async () => {},
};

export function usePrereqs() {
  return useContext(PrereqsContext) || FALLBACK;
}

const MIN_REFRESH_GAP_MS = 4000;

export function PrereqsProvider({ children }) {
  const [prerequisites, setPrerequisites] = useState(null);
  const [loaded, setLoaded] = useState(false);
  // O nome do programa que está sendo instalado ('' = nenhum) e o último resultado mostrado.
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const lastRefresh = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Só mexe no estado depois da resposta (nunca de forma síncrona), por isso a cadeia de promessas.
  const refresh = useCallback(({ force = false } = {}) => {
    const api = window.electronAPI;
    if (!api?.getPrerequisites) return Promise.resolve();
    const now = Date.now();
    if (!force && now - lastRefresh.current < MIN_REFRESH_GAP_MS) return Promise.resolve();
    lastRefresh.current = now;
    return Promise.resolve()
      .then(() => api.getPrerequisites())
      .then((next) => {
        if (alive.current && next) setPrerequisites(next);
      })
      .catch(() => {
        // Sem leitura, fica como estava: 'unknown' nunca bloqueia.
      })
      .then(() => {
        if (alive.current) setLoaded(true);
      });
  }, []);

  useEffect(() => {
    refresh({ force: true });
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const install = useCallback(async (name) => {
    const api = window.electronAPI;
    if (!api?.installPrerequisite) return;
    setBusy(name);
    setNotice(null);
    try {
      const result = await api.installPrerequisite(name);
      if (!alive.current) return;
      if (result?.prerequisites) setPrerequisites(result.prerequisites);
      const label = name === 'tailscale' ? 'Tailscale' : 'TightVNC';
      if (result?.success) {
        const next =
          name === 'tailscale'
            ? ' Abra o Tailscale e entre na sua conta para terminar.'
            : ' Agora configure o TightVNC no cartão "Este PC" da tela inicial.';
        setNotice({
          name,
          kind: 'success',
          text: result.restartNeeded
            ? `${label} instalado. O Windows pede para reiniciar o computador para terminar.`
            : `${label} instalado.${next}`,
        });
      } else {
        setNotice({
          name,
          kind: 'error',
          text: result?.error || `Não foi possível instalar o ${label}.`,
        });
      }
    } catch (err) {
      if (alive.current)
        setNotice({ name, kind: 'error', text: err?.message || 'Falha ao instalar.' });
    } finally {
      if (alive.current) setBusy('');
    }
  }, []);

  const openTailscale = useCallback(async () => {
    const result = await window.electronAPI?.openTailscale?.();
    if (result && result.success === false) {
      setNotice({
        name: 'tailscale',
        kind: 'error',
        text: result.error || 'Não foi possível abrir o Tailscale.',
      });
    }
  }, []);

  const value = useMemo(
    () => ({ prerequisites, loaded, busy, notice, refresh, install, openTailscale }),
    [prerequisites, loaded, busy, notice, refresh, install, openTailscale],
  );

  return <PrereqsContext.Provider value={value}>{children}</PrereqsContext.Provider>;
}
