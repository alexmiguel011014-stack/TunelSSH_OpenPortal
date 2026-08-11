import { useState, useContext } from 'react';
import { Monitor } from 'lucide-react';
import { MachineContext } from '../../App';
import { isPrivateNetworkHost } from '../../shared/lib/net';

const sectionTitle = 'text-xs font-semibold mb-3 uppercase tracking-wide text-text-muted';

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

export default function Dashboard({ onConnect }) {
  const { machines, activeMachine, connectMachine, addLog, connHistory } = useContext(MachineContext);
  const [quickIp, setQuickIp] = useState('');
  const [connecting, setConnecting] = useState(false);

  const handleConnectMachine = async (machine) => {
    if (activeMachine && activeMachine.id === machine.id) return;
    await connectMachine(machine);
  };

  const handleQuickConnect = async () => {
    // Aceita IP:porta colado sem quebrar — a porta é sempre 5900 aqui, então
    // só descartamos o que vier depois dos dois-pontos em vez de mandar pro
    // backend e deixar o erro genérico de validação explicar o formato.
    const ip = quickIp.trim().split(':')[0];
    if (!ip) {
      addLog('Digite um IP para conectar', 'warn');
      return;
    }
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      addLog(`IP inválido: use o formato 100.x.x.x (sem porta, sem espaços)`, 'error');
      return;
    }
    if (!isPrivateNetworkHost(ip)) {
      addLog(`Aviso: ${ip} não parece ser da rede Tailscale. A conexão pode falhar.`, 'warn');
    }
    if (connecting) return;
    setConnecting(true);
    try {
      await connectMachine({ id: 'quick-' + Date.now(), name: 'Conexão Direta', host: ip, port: 5900 });
    } finally {
      setConnecting(false);
    }
  };

  const availableMachines = machines ? machines.filter(m => m.host) : [];

  return (
    <div className="flex-1 flex flex-col items-center bg-canvas text-text-primary p-10 overflow-auto">
      <div className="max-w-3xl w-full">
        <h1 className="text-2xl font-light mb-1 text-text-primary">OpenPortal Remote</h1>
        <p className="text-sm text-text-faint mb-6">Acesso remoto seguro via Tailscale</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-surface rounded-xl border border-line-subtle p-5">
            <h2 className={sectionTitle}>Conectar a um PC</h2>
            {availableMachines.length === 0 ? (
              <div className="text-text-faint text-sm">Nenhum PC cadastrado.</div>
            ) : (
              <div className="space-y-1.5">
                {availableMachines.map((m) => (
                  <div
                    key={m.id}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border ${
                      activeMachine?.id === m.id ? 'border-accent bg-inset' : 'border-line-subtle bg-inset'
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
                      {activeMachine?.id === m.id ? 'Visualizando' : 'Conectar'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-surface rounded-xl border border-line-subtle p-5">
            <h2 className={sectionTitle}>Conectar por IP</h2>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="block text-[11px] text-text-faint mb-1">Endereço IP do PC remoto</label>
                <input
                  type="text"
                  value={quickIp}
                  onChange={(e) => setQuickIp(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleQuickConnect(); }}
                  placeholder="100.x.x.x"
                  className="w-full px-2.5 py-2 rounded-lg border border-line bg-inset text-text-primary text-sm font-mono outline-none focus:border-accent transition-colors"
                />
              </div>
              <button
                onClick={handleQuickConnect}
                disabled={connecting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-60"
              >
                {connecting ? 'Solicitando...' : 'Solicitar'}
              </button>
            </div>
            <div className="text-[11px] text-text-faint mt-2">
              Apenas o IP, sem porta (a porta VNC padrão 5900 é usada automaticamente). O PC remoto receberá um pedido de conexão e precisa aceitar.
            </div>
          </div>
        </div>

        <div className="bg-surface rounded-xl border border-line-subtle p-5 mt-4">
          <h2 className={sectionTitle}>Histórico de Conexões</h2>
          {!connHistory || connHistory.length === 0 ? (
            <div className="text-text-faint text-xs">Nenhuma conexão registrada ainda.</div>
          ) : (
            <div className="max-h-56 overflow-auto">
              {groupHistory(connHistory).map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-xs py-1.5 border-b border-line-subtle last:border-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    c.state === 'connect' ? 'bg-success' : c.state === 'error' ? 'bg-danger' : 'bg-text-muted'
                  }`} />
                  <span className="text-text-muted shrink-0">{c.date} {c.time}</span>
                  <span className="flex-1 truncate">{c.name} · {c.host || '-'}</span>
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
