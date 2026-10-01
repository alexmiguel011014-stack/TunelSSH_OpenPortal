import { useContext, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { MachineContext } from '../../App';
import { describeManagers } from '../../shared/lib/lab';

// Cartão da tela inicial "Este PC é gerenciado" (GOALS 16): mostra quem gerencia
// este PC e deixa a pessoa que está nele remover qualquer gerente — ela sempre
// pode desistir. Só aparece quando há ao menos um gerente.
export default function ManagedHostCard() {
  const { labHost, setLabHost, addLog } = useContext(MachineContext);
  const [confirming, setConfirming] = useState(null);
  const [error, setError] = useState('');

  if (!labHost?.managed) return null;

  const handleRemove = async (login) => {
    if (confirming !== login) {
      setConfirming(login);
      return;
    }
    setConfirming(null);
    setError('');
    try {
      const result = await window.electronAPI.removeLabManager(login);
      if (!result?.ok) {
        setError('Não foi possível remover esse gerente');
        return;
      }
      setLabHost({
        mode: result.mode,
        managed: result.managed,
        managers: result.managers,
      });
      if (addLog) addLog(`Laboratório: gerente removido: ${login}`);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-line-subtle p-5 mb-4">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={16} className="text-accent shrink-0" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Este PC é gerenciado
        </h2>
        <span className="text-[11px] text-text-faint">· {describeManagers(labHost.managers)}</span>
      </div>
      <p className="text-xs text-text-faint mb-3">
        Estas pessoas veem o estado deste PC e abrem a tela e os arquivos dele sem pedir permissão.
        Você pode remover qualquer uma a qualquer momento.
      </p>
      <ul className="space-y-1.5">
        {labHost.managers.map((login) => (
          <li
            key={login}
            className="flex items-center justify-between bg-inset rounded-lg px-3 py-2 border border-line-subtle"
          >
            <span className="text-sm text-text-primary font-mono truncate">{login}</span>
            <button
              onClick={() => handleRemove(login)}
              onBlur={() => setConfirming(null)}
              className="text-xs text-danger hover:opacity-80 transition-opacity bg-transparent border border-danger/40 rounded px-2 py-1 shrink-0"
            >
              {confirming === login ? 'Confirmar remoção?' : 'Remover gerente'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
    </div>
  );
}
