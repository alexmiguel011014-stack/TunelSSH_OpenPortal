import { useState, useContext } from 'react';
import { Monitor } from 'lucide-react';
import { MachineContext } from '../../App';
import { isPrivateNetworkHost } from '../../shared/lib/net';
import {
  formatAccessPassword,
  formatIpInput,
  normalizeQuickVncHost,
} from '../../shared/lib/vncSession';
import LocalAccessCard from './LocalAccessCard';

const sectionTitle = 'text-xs font-semibold mb-3 uppercase tracking-wide text-text-muted';

// A tela inicial é desmontada durante a sessão remota e voltava com o campo
// de IP vazio ao desconectar; o último IP fica guardado só nesta janela.
const QUICK_IP_KEY = 'openportal.quickIp';

function readQuickIp() {
  try {
    return sessionStorage.getItem(QUICK_IP_KEY) || '';
  } catch {
    return '';
  }
}

function rememberQuickIp(value) {
  try {
    sessionStorage.setItem(QUICK_IP_KEY, value);
  } catch {}
}

// Resultado do último pedido, visível no próprio cartão: antes erros de
// validação e recusas iam só para o log e a tela parecia travada.
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

// Mescla entradas consecutivas do mesmo PC (name+host) em uma só linha com
// contador — evita poluir a lista quando uma conexão aprova/desconecta em
// sequência rápida (ex.: retentativas), o que geraria várias linhas por
// tentativa.
function groupHistory(history) {
  const reversed = history.slice().reverse();
  const groups = [];
  for (const entry of reversed) {
    const last = groups[groups.length - 1];
    if (last && last.name === entry.name && last.host === entry.host) {
      last.count += 1;
      last.state = entry.state;
      last.message = entry.message;
    } else {
      groups.push({ ...entry, count: 1 });
    }
  }
  return groups;
}

export default function Dashboard() {
  const { machines, connectedMachines, focusedMachineId, connectMachine, addLog, connHistory } =
    useContext(MachineContext);
  const [quickIp, setQuickIp] = useState(readQuickIp);
  const [quickPassword, setQuickPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [quickFeedback, setQuickFeedback] = useState(null);
  const [machineFeedback, setMachineFeedback] = useState(null);

  // connectMachine já resolve sozinho: se a máquina estiver conectada, só
  // troca o foco; senão, inicia uma conexão nova. Nenhum guard extra aqui.
  const handleConnectMachine = async (machine) => {
    if (!connectedMachines[machine.id]) {
      setMachineFeedback({
        kind: 'info',
        text: `Aguardando alguém clicar em Aceitar em ${machine.name} (até 60 s)...`,
      });
    }
    const result = await connectMachine(machine);
    setMachineFeedback(
      result?.ok === false ? { kind: 'error', text: `${machine.name}: ${result.message}` } : null,
    );
  };

  const handleQuickConnect = async () => {
    const { host: ip, error } = normalizeQuickVncHost(quickIp);
    if (error) {
      addLog(error, 'warn');
      setQuickFeedback({
        kind: 'error',
        text: `${error}. Ex.: 100.81.199.56 (a senha de acesso vai no campo de baixo).`,
      });
      return;
    }
    if (!isPrivateNetworkHost(ip)) {
      addLog(`Aviso: ${ip} não parece ser da rede Tailscale. A conexão pode falhar.`, 'warn');
    }
    if (connecting) return;
    setConnecting(true);
    const password = quickPassword.trim();
    setQuickFeedback({
      kind: 'info',
      text: password
        ? 'Conferindo a senha de acesso no PC remoto...'
        : 'Aguardando alguém clicar em Aceitar no PC remoto (até 60 s)...',
    });
    try {
      const result = await connectMachine({
        id: 'quick-' + Date.now(),
        name: 'Conexão Direta',
        host: ip,
        port: 5900,
        sessionPassword: password,
      });
      setQuickFeedback(result?.ok === false ? { kind: 'error', text: result.message } : null);
    } finally {
      setConnecting(false);
      // A senha de acesso vale para um único pedido (o outro PC a troca após o uso).
      setQuickPassword('');
    }
  };

  const availableMachines = machines ? machines.filter((m) => m.host) : [];

  return (
    <div className="flex-1 flex flex-col items-center bg-canvas text-text-primary p-10 overflow-auto">
      <div className="max-w-3xl w-full">
        <h1 className="text-2xl font-light mb-1 text-text-primary">OpenPortal Remote</h1>
        <p className="text-sm text-text-faint mb-6">Acesso remoto seguro via Tailscale</p>

        <LocalAccessCard />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-surface rounded-xl border border-line-subtle p-5">
            <h2 className={sectionTitle}>Conectar a um PC</h2>
            {availableMachines.length === 0 ? (
              <div className="text-text-faint text-sm">Nenhum PC cadastrado.</div>
            ) : (
              <div className="space-y-1.5">
                {availableMachines.map((m) => {
                  const isConnected = !!connectedMachines[m.id];
                  const isFocused = focusedMachineId === m.id;
                  return (
                    <div
                      key={m.id}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border ${
                        isFocused ? 'border-accent bg-inset' : 'border-line-subtle bg-inset'
                      }`}
                    >
                      <Monitor size={16} className="text-text-muted shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{m.name}</div>
                        <div className="text-[11px] text-text-faint font-mono truncate">
                          {m.mask || `${m.host}${m.port !== 5900 ? ':' + m.port : ''}`}
                        </div>
                      </div>
                      <button
                        className="px-3.5 py-1.5 rounded-md text-xs font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap"
                        onClick={() => handleConnectMachine(m)}
                      >
                        {isFocused ? 'Visualizando' : isConnected ? 'Focar' : 'Solicitar acesso'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <Feedback feedback={machineFeedback} />
          </div>

          <div className="bg-surface rounded-xl border border-line-subtle p-5">
            <h2 className={sectionTitle}>Solicitar acesso por IP</h2>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="block text-[11px] text-text-faint mb-1">
                  IP Tailscale do PC remoto
                </label>
                <input
                  type="text"
                  value={quickIp}
                  onChange={(e) => {
                    const next = formatIpInput(e.target.value, quickIp);
                    setQuickIp(next);
                    rememberQuickIp(next);
                    setQuickFeedback(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleQuickConnect();
                  }}
                  placeholder="100.x.x.x (sem porta)"
                  inputMode="decimal"
                  autoComplete="off"
                  className="w-full px-2.5 py-2 rounded-lg border border-line bg-inset text-text-primary text-sm font-mono outline-none focus:border-accent transition-colors"
                />
              </div>
              <button
                onClick={handleQuickConnect}
                disabled={connecting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-60"
              >
                {connecting ? 'Solicitando...' : 'Solicitar acesso'}
              </button>
            </div>
            <div className="mt-2">
              <label className="block text-[11px] text-text-faint mb-1">
                Senha de acesso do PC remoto (opcional)
              </label>
              <input
                type="text"
                value={quickPassword}
                onChange={(e) => {
                  setQuickPassword(formatAccessPassword(e.target.value));
                  setQuickFeedback(null);
                }}
                maxLength={9}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleQuickConnect();
                }}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                className="w-full px-2.5 py-2 rounded-lg border border-line bg-inset text-text-primary text-sm font-mono uppercase outline-none focus:border-accent transition-colors"
              />
            </div>
            <div className="text-[11px] text-text-faint mt-2">
              Use apenas o IP, sem porta. Com a senha de acesso mostrada no outro PC a conexão entra
              direto; sem ela, alguém lá precisa clicar em Aceitar.
            </div>
            <Feedback feedback={quickFeedback} />
          </div>
        </div>

        <div className="bg-surface rounded-xl border border-line-subtle p-5 mt-4">
          <h2 className={sectionTitle}>Histórico de Conexões</h2>
          {!connHistory || connHistory.length === 0 ? (
            <div className="text-text-faint text-xs">Nenhuma conexão registrada ainda.</div>
          ) : (
            <div className="max-h-56 overflow-auto">
              {groupHistory(connHistory).map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 text-xs py-1.5 border-b border-line-subtle last:border-0"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      c.state === 'connect'
                        ? 'bg-success'
                        : c.state === 'error'
                          ? 'bg-danger'
                          : 'bg-text-muted'
                    }`}
                  />
                  <span className="text-text-muted shrink-0">
                    {c.date} {c.time}
                  </span>
                  <span className="flex-1 truncate">
                    {c.name} · {c.host || '-'}
                  </span>
                  <span className="text-text-faint">{c.message || c.state}</span>
                  {c.count > 1 && (
                    <span className="text-text-faint bg-inset rounded-full px-2 py-0.5 text-[11px] shrink-0">
                      {c.count}x
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
