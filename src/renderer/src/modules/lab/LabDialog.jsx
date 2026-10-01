import { useCallback, useEffect, useRef, useState } from 'react';
import { describeActionError } from '../../shared/lib/lab';

// Janela de diálogo simples para as ações do laboratório (reservar, cota, apagar...).
// `busy`: enquanto uma ação está em andamento a janela não fecha por Esc nem por clique fora.
// `locked`: nunca fecha por clique fora ou Esc (a janela das credenciais, onde a senha
// aparece uma vez só).
export function Modal({ title, onClose, busy = false, locked = false, wide = false, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy && !locked) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, locked, onClose]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy && !locked) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'} max-h-full overflow-auto bg-surface border border-line rounded-xl p-5 shadow-xl text-text-primary`}
      >
        <h2 className="text-sm font-semibold mb-3">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const inputClass =
  'w-full px-2.5 py-2 rounded-lg border border-line bg-inset text-text-primary text-sm outline-none focus:border-accent transition-colors';

export function Field({ label, children, hint }) {
  return (
    <label className="block mb-3">
      <span className="block text-[11px] text-text-faint mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-text-faint mt-1">{hint}</span>}
    </label>
  );
}

export function PrimaryButton({ children, ...props }) {
  return (
    <button
      {...props}
      className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-50 disabled:hover:bg-accent"
    >
      {children}
    </button>
  );
}

export function DangerButton({ children, ...props }) {
  return (
    <button
      {...props}
      className="px-4 py-2 rounded-lg text-sm font-medium bg-danger hover:opacity-90 text-white transition-opacity whitespace-nowrap disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, ...props }) {
  return (
    <button
      {...props}
      className="px-4 py-2 rounded-lg text-sm border border-line text-text-secondary hover:border-text-faint transition-colors whitespace-nowrap disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function ErrorLine({ text }) {
  if (!text) return null;
  return (
    <div
      role="alert"
      className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
    >
      {text}
    </div>
  );
}

// Roda a ação de uma janela: mostra "trabalhando", guarda o erro para mostrar dentro
// dela e só chama `onDone` quando deu certo. `action` devolve { ok, ... }.
export function useDialogAction(onDone) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (action) => {
      setWorking(true);
      setError('');
      try {
        const result = await action();
        if (!mounted.current) return result;
        if (result?.ok) onDone?.(result);
        else setError(describeActionError(result));
        return result;
      } catch (err) {
        if (mounted.current) setError(err.message);
        return { ok: false, message: err.message };
      } finally {
        if (mounted.current) setWorking(false);
      }
    },
    [onDone],
  );
  return { working, error, setError, run };
}
