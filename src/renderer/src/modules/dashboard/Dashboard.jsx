import { useState, useContext } from 'react';
import { MachineContext } from '../../App';
import { isPrivateNetworkHost } from '../../shared/lib/net';

const card = {
  background: '#1e293b', borderRadius: '8px', border: '1px solid #334155',
  padding: '18px', marginBottom: '16px'
};
const btn = {
  padding: '6px 14px', borderRadius: '4px', border: '1px solid #475569',
  background: '#1e293b', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px'
};
const sectionTitle = {
  fontSize: '12px', fontWeight: 600, marginBottom: '12px', textTransform: 'uppercase',
  letterSpacing: '0.5px', color: '#94a3b8'
};

export default function Dashboard({ onConnect }) {
  const { machines, activeMachine, connectMachine, addLog, connHistory } = useContext(MachineContext);
  const [quickIp, setQuickIp] = useState('');
  const [connecting, setConnecting] = useState(false);

  const handleConnectMachine = async (machine) => {
    if (activeMachine && activeMachine.id === machine.id) return;
    await connectMachine(machine);
  };

  const handleQuickConnect = async () => {
    const ip = quickIp.trim();
    if (!ip) {
      addLog('Digite um IP para conectar', 'warn');
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
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: '#0f172a', color: '#e2e8f0', padding: '40px', overflow: 'auto'
    }}>
      <div style={{ maxWidth: '600px', width: '100%' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 300, marginBottom: '8px', color: '#e2e8f0' }}>OpenPortal Remote</h1>
        <p style={{ fontSize: '14px', color: '#64748b', marginBottom: '24px' }}>
          Acesso remoto seguro via Tailscale
        </p>

        {/* Conectar a um PC card */}
        <div style={card}>
          <h2 style={sectionTitle}>
            Conectar a um PC
          </h2>
          {availableMachines.length === 0 ? (
            <div style={{ color: '#64748b', fontSize: '13px' }}>
              Nenhum PC cadastrado.
            </div>
          ) : (
            availableMachines.map((m) => (
              <div key={m.id} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 12px', marginBottom: '6px',
                background: '#0f172a', borderRadius: '6px',
                border: activeMachine?.id === m.id ? '1px solid #3b82f6' : '1px solid #1e293b'
              }}>
                <span style={{ fontSize: '16px' }}>{'\uD83D\uDDA5\uFE0F'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                  <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>{m.mask || `${m.host}${m.port !== 5900 ? ':' + m.port : ''}`}</div>
                </div>
                <button style={{ ...btn, background: '#2563eb', borderColor: '#2563eb', color: '#fff' }} onClick={() => handleConnectMachine(m)}>
                  {activeMachine?.id === m.id ? 'Visualizando' : 'Conectar'}
                </button>
              </div>
            ))
          )}
        </div>

        {/* Conectar por IP card */}
        <div style={card}>
          <h2 style={sectionTitle}>
            Conectar por IP
          </h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>
                Endereço IP do PC remoto
              </label>
              <input
                type="text"
                value={quickIp}
                onChange={(e) => setQuickIp(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleQuickConnect(); }}
                placeholder="100.x.x.x"
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: '6px',
                  border: '1px solid #475569', background: '#0f172a', color: '#e2e8f0',
                  fontSize: '14px', fontFamily: 'monospace', outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
            </div>
            <button onClick={handleQuickConnect} disabled={connecting} style={{
              ...btn, padding: '8px 16px', background: '#2563eb', borderColor: '#2563eb',
              color: '#fff', fontWeight: 500, whiteSpace: 'nowrap',
              opacity: connecting ? 0.6 : 1
            }}>
              {connecting ? 'Solicitando...' : 'Solicitar'}
            </button>
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '8px' }}>
            O PC remoto receberá um pedido de conexão e precisa aceitar.
          </div>
        </div>

        {/* Histórico de conexões */}
        <div style={{ ...card, marginTop: '20px' }}>
          <h2 style={sectionTitle}>
            Histórico de Conexões
          </h2>
          {!connHistory || connHistory.length === 0 ? (
            <div style={{ color: '#64748b', fontSize: '12px' }}>Nenhuma conexão registrada ainda.</div>
          ) : (
            <div style={{ maxHeight: '220px', overflow: 'auto' }}>
              {connHistory.slice().reverse().map((c) => (
                <div key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  fontSize: '12px', padding: '5px 4px',
                  borderBottom: '1px solid #1e293b'
                }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                    background: c.state === 'connect' ? '#22c55e' : c.state === 'error' ? '#ef4444' : '#94a3b8' }} />
                  <span style={{ color: '#94a3b8', flexShrink: 0 }}>{c.date} {c.time}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name} · {c.host || '-'}</span>
                  <span style={{ color: '#64748b' }}>{c.message || c.state}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
