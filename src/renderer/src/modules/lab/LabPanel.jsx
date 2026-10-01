import { useContext, useEffect, useState } from 'react';
import { Monitor, Trash2 } from 'lucide-react';
import { MachineContext } from '../../App';
import { formatIpInput, normalizeQuickVncHost } from '../../shared/lib/vncSession';
import {
  canOpenLabScreen,
  describeAddResult,
  describeRosterSummary,
  labOpenHint,
  labStateLabel,
  labStateTone,
} from '../../shared/lib/lab';

// Classes fixas por tom: o Tailwind só gera o que aparece escrito por inteiro.
const TONE_CLASSES = {
  success: 'border-success/50 text-success bg-success/10',
  warning: 'border-warning/50 text-warning bg-warning/10',
  danger: 'border-danger/50 text-danger bg-danger/10',
  accent: 'border-accent/50 text-accent bg-accent/10',
  faint: 'border-line text-text-faint bg-inset',
};

const sectionTitle = 'text-xs font-semibold mb-3 uppercase tracking-wide text-text-muted';

function Feedback({ feedback }) {
  if (!feedback) return null;
  const isError = feedback.kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
        isError
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-line bg-inset text-text-secondary'
      }`}
    >
      {feedback.text}
    </div>
  );
}

// Tela "Laboratório" (GOALS 16): os PCs que este app gerencia, o estado de cada
// um (consultado a cada 10 s pelo main) e "Adicionar PC", que pede a quem está
// no PC para clicar em Aceitar.
export default function LabPanel() {
  const { connectMachine, addLog } = useContext(MachineContext);
  const [roster, setRoster] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [ip, setIp] = useState('');
  const [adding, setAdding] = useState(false);
  const [addFeedback, setAddFeedback] = useState(null);
  const [rowFeedback, setRowFeedback] = useState(null);
  const [confirmingRemove, setConfirmingRemove] = useState(null);

  useEffect(() => {
    const api = window.electronAPI;
    api
      ?.getLabRoster?.()
      .then((list) => setRoster(Array.isArray(list) ? list : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
    const unsubscribe = api?.onLabStatus?.((list) => setRoster(Array.isArray(list) ? list : []));
    return () => unsubscribe?.();
  }, []);

  const handleAdd = async () => {
    const { host, error } = normalizeQuickVncHost(ip);
    if (error) {
      setAddFeedback({
        kind: 'error',
        text: `${error}. Use o IP do PC no Tailscale, no formato 100.x.x.x.`,
      });
      return;
    }
    if (adding) return;
    setAdding(true);
    setAddFeedback({
      kind: 'info',
      text: 'Aguardando a pessoa no PC clicar em Aceitar (até 60 s)...',
    });
    try {
      const result = await window.electronAPI.addLabPc(host);
      setAddFeedback(describeAddResult(result));
      if (result?.ok) {
        setIp('');
        if (addLog) addLog(`Laboratório: ${result.entry?.name || host} adicionado`);
      } else if (addLog) {
        addLog(`Laboratório: não adicionou ${host}: ${result?.message || result?.error}`, 'warn');
      }
    } catch (err) {
      setAddFeedback({ kind: 'error', text: err.message });
    } finally {
      setAdding(false);
    }
  };

  const handleOpen = async (entry) => {
    setRowFeedback(null);
    const opened = await window.electronAPI.openLabPc(entry.hostId);
    if (!opened?.ok) {
      setRowFeedback({
        kind: 'error',
        text: `${entry.name}: ${opened?.message || 'Não foi possível abrir'}`,
      });
      return;
    }
    const result = await connectMachine({ ...opened.machine, stayOnScreen: true });
    if (result?.ok === false) {
      setRowFeedback({
        kind: 'error',
        text: `${entry.name}: ${result.message}`,
      });
    }
  };

  const handleRemove = async (entry) => {
    if (confirmingRemove !== entry.hostId) {
      setConfirmingRemove(entry.hostId);
      return;
    }
    setConfirmingRemove(null);
    await window.electronAPI.removeLabPc(entry.hostId);
    if (addLog) addLog(`Laboratório: ${entry.name} removido da lista`);
  };

  return (
    <div className="flex-1 flex flex-col items-center bg-canvas text-text-primary p-10 overflow-auto">
      <div className="max-w-3xl w-full">
        <h1 className="text-2xl font-light mb-1 text-text-primary">Laboratório</h1>
        <p className="text-sm text-text-faint mb-6">
          Os PCs do laboratório que você gerencia. Para entrar em um, a pessoa que está nele precisa
          aceitar o seu pedido uma vez.
        </p>

        <div className="bg-surface rounded-xl border border-line-subtle p-5">
          <h2 className={sectionTitle}>Adicionar PC</h2>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-[11px] text-text-faint mb-1">
                IP Tailscale do PC do laboratório
              </label>
              <input
                type="text"
                value={ip}
                onChange={(e) => {
                  setIp(formatIpInput(e.target.value, ip));
                  setAddFeedback(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                }}
                placeholder="100.x.x.x (sem porta)"
                inputMode="decimal"
                autoComplete="off"
                className="w-full px-2.5 py-2 rounded-lg border border-line bg-inset text-text-primary text-sm font-mono outline-none focus:border-accent transition-colors"
              />
            </div>
            <button
              onClick={handleAdd}
              disabled={adding}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-60"
            >
              {adding ? 'Aguardando...' : 'Adicionar PC'}
            </button>
          </div>
          <Feedback feedback={addFeedback} />
        </div>

        <div className="bg-surface rounded-xl border border-line-subtle p-5 mt-4">
          <h2 className={sectionTitle}>PCs do laboratório</h2>
          {!loaded ? (
            <div className="text-text-faint text-xs">Carregando...</div>
          ) : roster.length === 0 ? (
            <div className="text-text-faint text-sm">
              Nenhum PC ainda. Adicione o primeiro pelo IP dele.
            </div>
          ) : (
            <div className="space-y-1.5">
              {roster.map((entry) => {
                const canOpen = canOpenLabScreen(entry.state);
                return (
                  <div
                    key={entry.hostId}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-line-subtle bg-inset"
                  >
                    <Monitor size={16} className="text-text-muted shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{entry.name}</div>
                      <div className="text-[11px] text-text-faint font-mono truncate">
                        {entry.host}
                        {entry.appVersion ? ` · v${entry.appVersion}` : ''}
                      </div>
                    </div>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${TONE_CLASSES[labStateTone(entry.state)]}`}
                    >
                      {labStateLabel(entry.state)}
                    </span>
                    {entry.state === 'in-use' ? (
                      <button
                        disabled
                        title="Disponível com os alunos (GOALS 18)"
                        className="px-3 py-1.5 rounded-md text-xs font-medium border border-line text-text-faint opacity-60 whitespace-nowrap"
                      >
                        Ver pasta
                      </button>
                    ) : (
                      <button
                        onClick={() => handleOpen(entry)}
                        disabled={!canOpen}
                        title={labOpenHint(entry.state)}
                        className="px-3.5 py-1.5 rounded-md text-xs font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-40 disabled:hover:bg-accent"
                      >
                        Abrir tela
                      </button>
                    )}
                    <button
                      onClick={() => handleRemove(entry)}
                      onBlur={() => setConfirmingRemove(null)}
                      title="Remover da lista (o PC continua aceitando você até o dono remover)"
                      className={`p-1.5 rounded-md border bg-transparent transition-colors ${
                        confirmingRemove === entry.hostId
                          ? 'border-danger/50 text-danger text-xs px-2'
                          : 'border-transparent text-text-faint hover:text-danger'
                      }`}
                    >
                      {confirmingRemove === entry.hostId ? 'Confirmar?' : <Trash2 size={14} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <Feedback feedback={rowFeedback} />
          {roster.length > 0 && (
            <div className="text-[11px] text-text-faint mt-3">{describeRosterSummary(roster)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
