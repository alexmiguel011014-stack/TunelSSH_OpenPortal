import { useContext, useEffect, useState } from 'react';
import { MachineContext } from '../../App';
import { isLabModeOn } from '../../shared/lib/lab';

function Toggle({ on, onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
        on
          ? 'border-success/50 text-success bg-success/10'
          : 'border-line text-text-muted hover:border-text-faint'
      }`}
    >
      {children}
    </button>
  );
}

// Configurações → "Modo laboratório" (GOALS 16): liga a tela "Laboratório" deste
// PC (o PC do professor) e, com o modo ligado ou este PC gerenciado, oferece
// "Iniciar com o Windows" para o PC voltar a ser gerenciado depois de reiniciar.
export default function LabModeSettings() {
  const { labHost, setLabHost, addLog } = useContext(MachineContext);
  const [startup, setStartup] = useState(null); // { supported, enabled } | null
  const [error, setError] = useState('');
  const labOn = isLabModeOn(labHost);

  useEffect(() => {
    if (!labOn) return;
    window.electronAPI
      ?.getStartWithWindows?.()
      .then(setStartup)
      .catch(() => setStartup({ supported: false, enabled: false }));
  }, [labOn]);

  const toggleMode = async () => {
    const next = !labHost.mode;
    setError('');
    try {
      const saved = await window.electronAPI?.saveConfig({
        lab: { mode: next },
      });
      if (!saved) {
        setError('Não foi possível salvar a configuração');
        return;
      }
      setLabHost({ ...labHost, mode: next });
      if (addLog) addLog(`Modo laboratório ${next ? 'ligado' : 'desligado'}`);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleStartup = async () => {
    setError('');
    const result = await window.electronAPI.setStartWithWindows(!startup.enabled);
    setStartup({ supported: result.supported, enabled: result.enabled });
    if (!result.ok) setError('O Windows não guardou a opção "Iniciar com o Windows"');
  };

  return (
    <div className="mt-10 pt-8 border-t border-line">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-medium text-text-secondary">Modo laboratório</h3>
        <Toggle on={labHost.mode} onClick={toggleMode}>
          {labHost.mode ? 'Ligado' : 'Desligado'}
        </Toggle>
      </div>
      <p className="text-xs text-text-faint mb-2">
        Mostra a tela &quot;Laboratório&quot;, onde este PC gerencia os PCs de um laboratório: a
        pessoa em cada PC aceita o seu pedido uma vez e depois você vê o estado dele e abre a tela
        sem novo diálogo.
      </p>
      {labHost.managed && !labHost.mode && (
        <p className="text-xs text-text-faint mb-2">
          Este PC é gerenciado por outra pessoa, então o modo laboratório continua valendo nele.
        </p>
      )}

      {labOn && startup && (
        <div className="mt-4 pt-4 border-t border-line-subtle">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-sm font-medium text-text-secondary">Iniciar com o Windows</h4>
            <Toggle on={startup.enabled} onClick={toggleStartup} disabled={!startup.supported}>
              {startup.enabled ? 'Ligado' : 'Desligado'}
            </Toggle>
          </div>
          <p className="text-xs text-text-faint">
            {startup.supported
              ? 'Abre o OpenPortal quando esta conta do Windows entra. Num PC de laboratório, use uma conta comum dedicada (por exemplo "openportal-host") com login automático, para o PC voltar a ser gerenciado sozinho depois de reiniciar.'
              : 'Disponível só no app instalado (no modo de desenvolvimento esta opção fica desligada).'}
          </p>
        </div>
      )}
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
    </div>
  );
}
