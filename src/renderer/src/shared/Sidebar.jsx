import { useContext, useMemo } from 'react';
import { MachineContext } from '../App';
import StatusBadge from './StatusBadge';
import { isPrivateNetworkHost } from './lib/net';

export default function Sidebar() {
  const {
    machines,
    activeMachineId,
    connectMachine,
    addMachine,
    removeMachine,
    showFiles,
    setShowFiles,
    sidebarCollapsed,
    toggleSidebar,
    maxMachines,
    addLog,
    statuses,
    theme,
    toggleTheme,
  } = useContext(MachineContext);

  const otherMachines = useMemo(
    () => machines.filter(m => m.id !== activeMachineId),
    [machines, activeMachineId]
  );

  if (sidebarCollapsed) return null;

  const handleClickMachine = (machine) => {
    const isConfigured = machine.host && machine.host.trim() !== '';
    if (!isConfigured) {
      if (addLog) addLog('Sidebar: machine not configured (no host)', 'warn');
      return;
    }
    if (!isPrivateNetworkHost(machine.host)) {
      if (addLog) addLog(`Aviso: ${machine.host} não parece ser da rede Tailscale. A conexão pode falhar.`, 'warn');
    }
    if (addLog) addLog(`Sidebar: connecting to ${machine.host}:${machine.port}`);
    connectMachine(machine);
  };

  const handleRemove = (id, name) => {
    if (addLog) addLog(`Sidebar: removing ${name}`);
    removeMachine(id);
  };

  const handleCheckUpdate = async () => {
    if (addLog) addLog('Verificando atualizações...');
    try {
      const res = await window.electronAPI?.checkForUpdates?.();
      if (res && res.checking === false && res.message) {
        if (addLog) addLog(res.message, 'warn');
      }
    } catch (err) {
      if (addLog) addLog(`Erro ao verificar atualizações: ${err.message}`, 'error');
    }
  };

  return (
    <aside style={{ width: '256px', minWidth: '256px', background: '#1e293b', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column' }}>
      {/* Header with collapse */}
      <div style={{ padding: '16px', borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: 600, color: '#f1f5f9' }}>OpenPortal</h1>
          <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>Remote Desktop Gateway</p>
        </div>
        <button
          onClick={toggleSidebar}
          style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: '4px', fontSize: '16px' }}
          title="Recolher barra lateral"
        >
          ◀
        </button>
      </div>

      {/* Machines List */}
      <nav style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
        <p style={{ fontSize: '11px', fontWeight: 500, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 8px', marginBottom: '8px' }}>
          PCs ({otherMachines.length}/{maxMachines})
        </p>
        {otherMachines.length === 0 && (
          <div style={{ padding: '12px 8px', fontSize: '12px', color: '#475569', textAlign: 'center' }}>
            Nenhum PC cadastrado
          </div>
        )}
        {otherMachines.map((machine) => {
          const isConfigured = machine.host && machine.host.trim() !== '';
          return (
            <div key={machine.id} style={{ position: 'relative', marginBottom: '2px' }}>
              <button
                onClick={() => handleClickMachine(machine)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  cursor: isConfigured ? 'pointer' : 'not-allowed',
                  background: 'transparent',
                  color: isConfigured ? '#cbd5e1' : '#475569',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {machine.name}
                    </div>
                    {isConfigured && (
                      <div style={{ fontSize: '12px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px', fontFamily: 'monospace' }}>
                        {machine.mask || `${machine.host}:${machine.port}`}
                      </div>
                    )}
                  </div>
                  <StatusBadge state={statuses[machine.id] || 'disconnected'} />
                </div>
              </button>
              <button
                onClick={() => handleRemove(machine.id, machine.name)}
                style={{
                  position: 'absolute', top: '2px', right: '2px',
                  background: 'none', border: 'none', color: '#475569',
                  cursor: 'pointer', fontSize: '12px', padding: '2px 6px',
                  borderRadius: '4px', display: 'none',
                }}
                className="remove-machine-btn"
                title="Remover PC"
              >
                ✕
              </button>
            </div>
          );
        })}

        {/* Add PC button */}
        {machines.length < maxMachines && (
          <button
            onClick={addMachine}
            style={{
              width: '100%', padding: '8px 12px', marginTop: '8px',
              borderRadius: '8px', fontSize: '13px', border: '1px dashed #475569',
              cursor: 'pointer', background: 'transparent', color: '#64748b',
            }}
          >
            + Adicionar PC
          </button>
        )}
      </nav>

      {/* Files button */}
      <div style={{ padding: '0 12px', borderTop: '1px solid #334155' }}>
        <button
          onClick={() => setShowFiles(!showFiles)}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: '8px',
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            background: showFiles ? '#475569' : 'transparent',
            color: showFiles ? '#ffffff' : '#94a3b8',
            marginTop: '8px',
          }}
        >
          📁 Arquivos
        </button>
      </div>

      {/* Atualizações button */}
      <div style={{ padding: '0 12px', borderTop: '1px solid #334155' }}>
        <button
          onClick={handleCheckUpdate}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: '8px',
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            background: 'transparent',
            color: '#94a3b8',
          }}
          title="Verificar atualizações"
        >
          🔄 Atualizações
        </button>
      </div>

      {/* Tema button */}
      <div style={{ padding: '0 12px', borderTop: '1px solid #334155' }}>
        <button
          onClick={toggleTheme}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: '8px',
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            background: 'transparent',
            color: '#94a3b8',
          }}
          title="Alternar tema claro/escuro"
        >
          {theme === 'dark' ? '☀️ Tema claro' : '🌙 Tema escuro'}
        </button>
      </div>
    </aside>
  );
}
