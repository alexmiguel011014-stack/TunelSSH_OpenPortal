import { useContext, useState, useMemo, useEffect, useRef } from 'react';
import { MachineContext } from '../App';
import StatusBadge from './StatusBadge';

export default function Sidebar() {
  const {
    machines,
    activeMachineId,
    activeMachine,
    statuses,
    connectMachine,
    disconnectMachine,
    addMachine,
    removeMachine,
    triggerReconnect,
    showConfig,
    setShowConfig,
    showFiles,
    setShowFiles,
    sidebarCollapsed,
    toggleSidebar,
    maxMachines,
    logs,
    setLogs,
    showLogs,
    setShowLogs,
    addLog,
  } = useContext(MachineContext);

  const [showConnectedOpts, setShowConnectedOpts] = useState(false);
  const logContainerRef = useRef(null);
  const [serverStatus, setServerStatus] = useState({ running: false, port: 0 });
  const [localIp, setLocalIp] = useState('');

  useEffect(() => {
    window.electronAPI?.getServerStatus?.().then(s => setServerStatus(s || { running: false, port: 0 }));
    window.electronAPI?.getLocalIp?.().then(res => setLocalIp(res?.ip || ''));
  }, []);

  const otherMachines = useMemo(
    () => machines.filter(m => m.id !== activeMachineId),
    [machines, activeMachineId]
  );

  useEffect(() => {
    if (showLogs && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, showLogs]);

  if (sidebarCollapsed) return null;

  const handleClickMachine = (machine) => {
    const isConfigured = machine.host && machine.host.trim() !== '';
    if (!isConfigured) {
      if (addLog) addLog('Sidebar: machine not configured (no host)', 'warn');
      return;
    }
    if (addLog) addLog(`Sidebar: connecting to ${machine.host}:${machine.port}`);
    connectMachine(machine);
  };

  const handleReconnect = () => {
    if (addLog) addLog('Sidebar: reconnecting');
    triggerReconnect();
  };

  const handleDisconnect = () => {
    if (addLog) addLog('Sidebar: disconnecting');
    setShowConnectedOpts(false);
    disconnectMachine();
  };

  const handleRemove = (id, name) => {
    if (addLog) addLog(`Sidebar: removing ${name}`);
    removeMachine(id);
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
          title="Collapse sidebar"
        >
          ◀
        </button>
      </div>

      {/* Minha Maquina (Agent) Section */}
      <div style={{ padding: '12px', borderBottom: '1px solid #334155' }}>
        <div style={{ fontSize: '11px', fontWeight: 500, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
          Minha Maquina
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: serverStatus.running ? '#22c55e' : '#ef4444', display: 'inline-block' }} />
          <span style={{ fontSize: '12px', color: serverStatus.running ? '#22c55e' : '#f87171' }}>
            Servidor: {serverStatus.running ? 'ATIVO' : 'INATIVO'}
          </span>
          {serverStatus.running && <span style={{ fontSize: '11px', color: '#64748b' }}>:{serverStatus.port}</span>}
        </div>
        {localIp && (
          <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>
            {localIp}
          </div>
        )}
      </div>

      {/* Connected PC Section */}
      {activeMachine && (
        <>
          <div
            style={{ padding: '12px', borderBottom: '1px solid #334155', cursor: 'pointer' }}
            onClick={() => setShowConnectedOpts(!showConnectedOpts)}
          >
            <div style={{ fontSize: '11px', fontWeight: 500, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
              Conectado
            </div>
            <div style={{
              padding: '10px 12px',
              borderRadius: '8px',
              background: '#1e3a5f',
              border: '1px solid #2563eb',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '14px', fontWeight: 500, color: '#e2e8f0' }}>
                  {activeMachine.name}
                </div>
                <span style={{ fontSize: '10px', color: '#64748b' }}>{showConnectedOpts ? '▲' : '▼'}</span>
              </div>
              {activeMachine.host && (
                <div style={{ fontSize: '12px', color: '#94a3b8', fontFamily: 'monospace', marginTop: '2px' }}>
                  {activeMachine.host}:{activeMachine.port}
                </div>
              )}
              <div style={{ marginTop: '4px' }}>
                <StatusBadge state={statuses[activeMachine.id] || 'connecting'} />
              </div>
            </div>
          </div>

          {/* Connected PC Options (expandable) */}
          {showConnectedOpts && (
            <div style={{ padding: '0 12px 12px', borderBottom: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <button
                onClick={handleReconnect}
                style={{
                  width: '100%', padding: '8px', fontSize: '13px', borderRadius: '6px',
                  border: 'none', cursor: 'pointer', background: '#2563eb', color: '#fff',
                }}
              >
                🔄 Reconnect
              </button>
              <button
                onClick={handleDisconnect}
                style={{
                  width: '100%', padding: '8px', fontSize: '13px', borderRadius: '6px',
                  border: '1px solid #475569', cursor: 'pointer', background: 'transparent', color: '#f87171',
                }}
              >
                ⏹ Disconnect
              </button>
            </div>
          )}
        </>
      )}

      {/* Machines List */}
      <nav style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
        <p style={{ fontSize: '11px', fontWeight: 500, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 8px', marginBottom: '8px' }}>
          Machines ({otherMachines.length}/{maxMachines})
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
                      <div style={{ fontSize: '12px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                        {machine.host}:{machine.port}
                      </div>
                    )}
                  </div>
                  <StatusBadge state={'disconnected'} />
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
                title="Remove machine"
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
            + Add PC
          </button>
        )}
      </nav>

      {/* Logs section */}
      <div style={{ borderTop: '1px solid #334155' }}>
        <button
          onClick={() => setShowLogs(!showLogs)}
          style={{
            width: '100%',
            padding: '8px 12px',
            fontSize: '12px',
            border: 'none',
            cursor: 'pointer',
            background: showLogs ? '#1e3a5f' : 'transparent',
            color: showLogs ? '#93c5fd' : '#64748b',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>📋 Logs ({logs.length})</span>
          <span style={{ fontSize: '10px' }}>{showLogs ? '▼' : '▲'}</span>
        </button>

        {showLogs && (
          <div style={{ background: '#0f172a', borderBottom: '1px solid #334155' }}>
            <div style={{ padding: '4px 8px', display: 'flex', gap: '4px', borderBottom: '1px solid #1e293b' }}>
              <button
                onClick={() => setLogs([])}
                style={{ fontSize: '10px', background: '#1e293b', border: 'none', color: '#64748b', cursor: 'pointer', padding: '2px 6px', borderRadius: '3px' }}
              >
                Clear
              </button>
            </div>
            <div
              ref={logContainerRef}
              style={{
                maxHeight: '150px',
                overflowY: 'auto',
                padding: '4px 8px',
                fontFamily: 'monospace',
                fontSize: '10px',
                lineHeight: '1.5',
              }}
            >
              {logs.length === 0 ? (
                <div style={{ color: '#475569', padding: '8px', textAlign: 'center' }}>No logs yet</div>
              ) : (
                logs.map((log) => (
                  <div
                    key={log.id}
                    style={{
                      color: log.type === 'error' ? '#f87171' : log.type === 'warn' ? '#fbbf24' : '#94a3b8',
                      wordBreak: 'break-all',
                    }}
                  >
                    <span style={{ color: '#475569' }}>[{log.time}]</span> {log.msg}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Files button */}
      <div style={{ padding: '0 12px', borderTop: '1px solid #334155' }}>
        <button
          onClick={() => { setShowFiles(!showFiles); if (showConfig) setShowConfig(false); }}
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
          📁 Files
        </button>
      </div>

      {/* Settings at bottom */}
      <div style={{ padding: '12px', borderTop: '1px solid #334155' }}>
        <button
          onClick={() => { setShowConfig(!showConfig); if (showFiles) setShowFiles(false); }}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: '8px',
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            background: showConfig ? '#475569' : 'transparent',
            color: showConfig ? '#ffffff' : '#94a3b8',
          }}
        >
          ⚙️ Settings
        </button>
      </div>
    </aside>
  );
}
