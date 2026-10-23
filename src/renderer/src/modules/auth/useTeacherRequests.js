import { useCallback, useEffect, useRef, useState } from 'react';

const REFRESH_MS = 60 * 1000;

// Os pedidos de professor pendentes (GOALS 20), para a tela de Aprovações e para o contador na
// barra lateral. Só consulta quando `enabled` (um professor aprovado); atualiza a cada minuto.
export function useTeacherRequests(enabled) {
  const [state, setState] = useState({ list: [], loaded: false, loading: false, error: '' });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.getTeacherRequests) return;
    setState((current) => ({ ...current, loading: true }));
    let next;
    try {
      const result = await api.getTeacherRequests();
      next = result?.ok
        ? { list: result.requests, loaded: true, loading: false, error: '' }
        : { loading: false, error: result?.message || 'Não foi possível carregar os pedidos.' };
    } catch (err) {
      next = { loading: false, error: err.message };
    }
    if (alive.current) setState((current) => ({ ...current, ...next }));
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const first = setTimeout(reload, 0);
    const timer = setInterval(reload, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled, reload]);

  return { ...state, reload };
}
