import { useCallback, useContext, useEffect, useState } from 'react';
import { MachineContext } from '../../App';
import { describeServiceState, isLabModeOn } from '../../shared/lib/lab';

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

// Habilita (com UAC) o serviço que cria as contas dos alunos, a cota de disco e os
// prazos neste PC (GOALS 17). Só faz sentido nos PCs onde os alunos vão entrar.
function ServiceSection() {
  const { addLog } = useContext(MachineContext);
  const [state, setState] = useState(null);
  const [studentsOnSite, setStudentsOnSite] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState(null);

  const refresh = useCallback(() => {
    window.electronAPI
      ?.getLabServiceState?.()
      .then(setState)
      .catch(() => setState(null));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (action, doing, done) => {
    setWorking(true);
    setMessage({ kind: 'info', text: doing });
    try {
      const result = await action();
      setMessage(
        result?.ok
          ? { kind: 'info', text: done }
          : { kind: 'error', text: result?.message || 'Não foi possível concluir' },
      );
      if (addLog) addLog(`Laboratório: ${result?.ok ? done : result?.message || 'falhou'}`);
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setWorking(false);
      refresh();
    }
  };

  const installed = state?.installed === true;
  return (
    <div className="mt-4 pt-4 border-t border-line-subtle">
      <h4 className="text-sm font-medium text-text-secondary mb-1">Alunos neste PC</h4>
      <p className="text-xs text-text-faint mb-2">
        Habilita o serviço do laboratório (pede permissão de administrador): ele cria as contas dos
        alunos, limita o disco de cada um e encerra a sessão no prazo. Faça isso só nos PCs onde os
        alunos vão entrar. Estado: <strong>{describeServiceState(state)}</strong>
      </p>
      <label className="flex items-center gap-2 text-xs text-text-secondary mb-3">
        <input
          type="checkbox"
          checked={studentsOnSite}
          onChange={(e) => setStudentsOnSite(e.target.checked)}
          disabled={working}
        />
        Os alunos estão na mesma rede deste PC (sala de aula): libera a porta do Remote Desktop
        também para a rede local
      </label>
      <div className="flex items-center gap-2">
        <button
          onClick={() =>
            run(
              () => window.electronAPI.enableLabService({ studentsOnSite }),
              'Aguardando a permissão de administrador...',
              'Modo laboratório habilitado neste PC',
            )
          }
          disabled={working}
          className="px-4 py-2 text-sm rounded-lg border border-line text-text-secondary hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
        >
          {installed ? 'Reaplicar' : 'Habilitar neste PC'}
        </button>
        {installed && (
          <button
            onClick={() =>
              run(
                () => window.electronAPI.disableLabService(),
                'Aguardando a permissão de administrador...',
                'Modo laboratório desabilitado neste PC (as contas dos alunos ficam, desativadas)',
              )
            }
            disabled={working}
            className="px-4 py-2 text-sm rounded-lg border border-danger/40 text-danger hover:opacity-80 transition-opacity disabled:opacity-50"
          >
            Desabilitar
          </button>
        )}
      </div>
      {message && (
        <p
          className={`text-xs mt-2 ${message.kind === 'error' ? 'text-danger' : 'text-text-secondary'}`}
        >
          {message.text}
        </p>
      )}
    </div>
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
      {labOn && <ServiceSection />}
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
    </div>
  );
}
