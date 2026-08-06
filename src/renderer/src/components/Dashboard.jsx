import { useState, useEffect, useContext } from 'react';
import { MachineContext } from '../App';
import { isPrivateNetworkHost } from '../lib/net';

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
  const { machines, activeMachine, setActiveMachine, setShowFiles, setShowConfig, addLog } = useContext(MachineContext);
  const [serverStatus, setServerStatus] = useState({ running: false, port: 0, rootDir: '' });
  const [localIp, setLocalIp] = useState('');
  const [copied, setCopied] = useState(false);
  const [quickIp, setQuickIp] = useState('');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    window.electronAPI.getServerStatus().then(setServerStatus);
    window.electronAPI.getLocalIp().then(res => setLocalIp(res.ip || ''));
  }, []);

  const handleCopyIp = () => {
    if (localIp) {
      navigator.clipboard.writeText(localIp).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const handleConnectMachine = async (machine) => {
    if (activeMachine && activeMachine.id === machine.id) return;
    if (activeMachine) {
      try { await window.electronAPI.disconnectVnc(); } catch {}
    }
    try {
      await window.electronAPI.connectVnc(machine);
      setActiveMachine(machine);
      addLog(`Conectando a ${machine.name} (${machine.host})`);
    } catch (err) {
      addLog(`Erro ao conectar: ${err.message}`, 'error');
    }
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
    addLog(`Solicitando conexão a ${ip}...`);

    let localIp = '';
    try {
      const res = await window.electronAPI.getLocalIp();
      localIp = (res && res.ip) || '';
    } catch {}

    try {
      const reqRes = await window.electronAPI.requestConnection(ip, { fromIp: localIp });
      if (!reqRes || !reqRes.success || !reqRes.approved) {
        addLog(`Conexão recusada: ${(reqRes && reqRes.message) || 'não aprovada'}`, 'error');
        return;
      }
    } catch (err) {
      addLog(`Erro ao solicitar conexão: ${err.message}`, 'error');
      return;
    } finally {
      setConnecting(false);
    }

    addLog('Conexão aceita pelo PC remoto. Abrindo visualização...');
    const tempMachine = {
      id: 'quick-' + Date.now(),
      name: 'Conexão Direta',
      host: ip,
      port: 5900
    };
    if (activeMachine) {
      try { await window.electronAPI.disconnectVnc(); } catch {}
    }
    try {
      await window.electronAPI.connectVnc(tempMachine);
      setActiveMachine(tempMachine);
      addLog(`Conectando a ${ip}:5900`);
    } catch (err) {
      addLog(`Erro ao conectar: ${err.message}`, 'error');
    }
  };

  const handleOpenFiles = async (machine) => {
    if (!activeMachine || activeMachine.id !== machine.id) {
      await handleConnectMachine(machine);
    }
    setShowFiles(true);
    if (setShowConfig) setShowConfig(false);
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

        {/* Minha Maquina card */}
        <div style={card}>
          <h2 style={sectionTitle}>
            Minha Máquina (Agente)
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 500 }}>
              <span style={{
                width: '10px', height: '10px', borderRadius: '50%',
                background: serverStatus.running ? '#22c55e' : '#ef4444', display: 'inline-block'
              }} />
              {serverStatus.running ? 'Servidor ativo' : 'Servidor inativo'}
            </span>
            {serverStatus.running && <span style={{ fontSize: '11px', color: '#22c55e', background: '#052e16', border: '1px solid #15803d', padding: '2px 8px', borderRadius: '999px' }}>pronto para receber</span>}
          </div>
          {localIp && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '13px' }}>
              <span style={{ color: '#94a3b8' }}>IP Tailscale:</span>
              <code style={{ background: '#0f172a', padding: '3px 8px', borderRadius: '4px', fontSize: '13px', color: '#3b82f6' }}>
                {localIp}
              </code>
              <button onClick={handleCopyIp} style={{ ...btn, padding: '3px 10px', fontSize: '11px' }}>
                {copied ? 'Copiado!' : 'Copiar IP'}
              </button>
            </div>
          )}
          {serverStatus.running && (
            <div style={{ fontSize: '12px', color: '#64748b' }}>
              Porta {serverStatus.port}{serverStatus.rootDir ? ` · Raiz: ${serverStatus.rootDir}` : ''}
            </div>
          )}
        </div>

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
                  <div style={{ fontSize: '11px', color: '#64748b' }}>{m.host}{m.port !== 5900 ? ':' + m.port : ''}</div>
                </div>
                <button style={{ ...btn, background: '#2563eb', borderColor: '#2563eb', color: '#fff' }} onClick={() => handleConnectMachine(m)}>
                  {activeMachine?.id === m.id ? 'Visualizando' : 'Conectar'}
                </button>
                <button style={{ ...btn, borderColor: '#3b82f6', color: '#93c5fd' }} onClick={() => handleOpenFiles(m)}>
                  Enviar arquivos
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

        {/* Status row */}
        <div style={{ fontSize: '12px', color: '#475569', textAlign: 'center', marginTop: '8px' }}>
          {serverStatus.running
            ? `Pronto para receber conexões na porta ${serverStatus.port}`
            : 'Servidor de arquivos não disponível'}
        </div>
      </div>
    </div>
  );
}
