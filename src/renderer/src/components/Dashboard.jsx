import { useState, useEffect, useContext } from 'react';
import { MachineContext } from '../App';

const card = {
  background: '#1e293b', borderRadius: '8px', border: '1px solid #334155',
  padding: '20px', marginBottom: '20px'
};
const btn = {
  padding: '6px 14px', borderRadius: '4px', border: '1px solid #475569',
  background: '#1e293b', color: '#e2e8f0', cursor: 'pointer', fontSize: '13px'
};

export default function Dashboard({ onConnect }) {
  const { machines, activeMachine, setActiveMachine, setShowFiles, setShowConfig, addLog } = useContext(MachineContext);
  const [serverStatus, setServerStatus] = useState({ running: false, port: 0, rootDir: '' });
  const [localIp, setLocalIp] = useState('');
  const [copied, setCopied] = useState(false);
  const [quickIp, setQuickIp] = useState('');
  const [quickPort, setQuickPort] = useState(5900);

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
    const tempMachine = {
      id: 'quick-' + Date.now(),
      name: 'Conexão Direta',
      host: ip,
      port: quickPort || 5900
    };
    if (activeMachine) {
      try { await window.electronAPI.disconnectVnc(); } catch {}
    }
    try {
      await window.electronAPI.connectVnc(tempMachine);
      setActiveMachine(tempMachine);
      addLog(`Conectando a ${ip}:${quickPort}`);
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
          <h2 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#94a3b8' }}>
            Minha Máquina (Agente)
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <span style={{
              width: '10px', height: '10px', borderRadius: '50%',
              background: serverStatus.running ? '#22c55e' : '#ef4444',
              display: 'inline-block'
            }} />
            <span style={{ fontSize: '14px', fontWeight: 500 }}>
              Servidor de Arquivos: {serverStatus.running ? 'ATIVO' : 'INATIVO'}
            </span>
            {serverStatus.running && (
              <span style={{ fontSize: '12px', color: '#64748b' }}>porta {serverStatus.port}</span>
            )}
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
          {serverStatus.rootDir && (
            <div style={{ fontSize: '12px', color: '#64748b' }}>
              Raiz: {serverStatus.rootDir}
            </div>
          )}
        </div>

        {/* Conectar a um PC card */}
        <div style={card}>
          <h2 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#94a3b8' }}>
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
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '14px', fontWeight: 500 }}>{m.name}</div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>{m.host}{m.port !== 5900 ? ':' + m.port : ''}</div>
                </div>
                <button style={btn} onClick={() => handleConnectMachine(m)}>
                  VNC
                </button>
                <button style={{ ...btn, borderColor: '#3b82f6' }} onClick={() => handleOpenFiles(m)}>
                  Files
                </button>
              </div>
            ))
          )}
        </div>

        {/* Conectar por IP card */}
        <div style={card}>
          <h2 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#94a3b8' }}>
            Conectar por IP
          </h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>
                Endereço IP
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
            <div style={{ width: '80px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>
                Porta
              </label>
              <input
                type="number"
                value={quickPort}
                onChange={(e) => setQuickPort(parseInt(e.target.value) || 5900)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleQuickConnect(); }}
                placeholder="5900"
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: '6px',
                  border: '1px solid #475569', background: '#0f172a', color: '#e2e8f0',
                  fontSize: '14px', fontFamily: 'monospace', outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
            </div>
            <button onClick={handleQuickConnect} style={{
              ...btn, padding: '8px 16px', background: '#2563eb', borderColor: '#2563eb',
              color: '#fff', fontWeight: 500, whiteSpace: 'nowrap'
            }}>
              Conectar
            </button>
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
