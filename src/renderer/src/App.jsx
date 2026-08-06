import { useState, useEffect, createContext, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import RemoteViewer from './components/RemoteViewer';
import ConfigPanel from './components/ConfigPanel';
import FileTransfer from './components/FileTransfer';
import Dashboard from './components/Dashboard';

export const MachineContext = createContext(null);

const DEFAULT_MACHINES = [
  { id: 'pc-1', name: 'PC Remoto 1', host: '', port: 5900 },
  { id: 'pc-2', name: 'PC Remoto 2', host: '', port: 5900 },
  { id: 'pc-3', name: 'PC 3', host: '', port: 5900 },
];

const MAX_MACHINES = 20;
let nextId = 4;

function genId() {
  return 'pc-' + (nextId++);
}

export default function App() {
  const [machines, setMachines] = useState(DEFAULT_MACHINES);
  const [activeMachineId, setActiveMachineId] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [showConfig, setShowConfig] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [reconnectFlag, setReconnectFlag] = useState(0);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [connHistory, setConnHistory] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('openportal-theme') || 'dark');
  const logIdRef = useRef(0);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('openportal-theme', next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const addLog = useCallback((msg, type = 'info') => {
    const id = logIdRef.current++;
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-50), { id, time, msg, type }]);
    console.log(`[app][${type}] ${msg}`);
  }, []);

  const recordConn = useCallback((info) => {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(16).slice(2, 6),
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      name: info.name || 'Conexão Direta',
      host: info.host || '',
      state: info.state || 'info',
      message: info.message || '',
    };
    setConnHistory((prev) => [...prev.slice(-49), entry]);
  }, []);

  useEffect(() => {
    window.electronAPI?.getConfig?.().then((config) => {
      if (config?.machines) {
        setMachines(config.machines);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI?.onVncStatus((status) => {
      addLog(`VNC status: ${status.state} (machine: ${status.machineId || 'none'})`);
      setStatuses((prev) => ({
        ...prev,
        [status.machineId || 'global']: status.state,
      }));
      const m = machines.find((x) => x.id === status.machineId);
      const stateLabel = status.state === 'connected' ? 'connect' : status.state;
      if (m && (status.state === 'connected' || status.state === 'error' || status.state === 'disconnected')) {
        recordConn({ name: m.name, host: m.host, state: stateLabel, message: status.state });
      }
      if (status.state === 'connected' && m) {
        window.electronAPI?.notify({ title: 'Conexão estabelecida', body: `${m.name} (${m.host}) conectado.` });
      } else if (status.state === 'error' && m) {
        window.electronAPI?.notify({ title: 'Falha na conexão', body: `Não foi possível conectar a ${m.name} (${m.host}).` });
      }
    });
    return unsub;
  }, [machines, recordConn]);

  const activeMachine = typeof activeMachineId === 'string'
    ? machines.find((m) => m.id === activeMachineId)
    : activeMachineId;

  const connectMachine = useCallback((machine) => {
    addLog(`Connecting to: ${machine.name} (${machine.host}:${machine.port})`);
    recordConn({ name: machine.name, host: machine.host, state: 'connecting', message: `Conectando a ${machine.host}` });
    setActiveMachineId(machine.id);
    setShowConfig(false);
    setShowFiles(false);
  }, [addLog, recordConn]);

  const disconnectMachine = useCallback(async () => {
    addLog('Disconnected');
    window.electronAPI?.disconnectVnc();
    if (activeMachine) {
      recordConn({ name: activeMachine.name, host: activeMachine.host, state: 'disconnect', message: 'Desconectado' });
    }
    setActiveMachineId(null);
    setStatuses({});
  }, [addLog, activeMachine, recordConn]);

  const saveMachines = useCallback((newMachines) => {
    setMachines(newMachines);
    window.electronAPI?.saveConfig({ machines: newMachines });
    addLog('Config saved');
  }, [addLog]);

  const addMachine = useCallback(() => {
    if (machines.length >= MAX_MACHINES) {
      addLog(`Max ${MAX_MACHINES} machines reached`, 'warn');
      return;
    }
    const newMachine = { id: genId(), name: `PC ${machines.length + 1}`, host: '', port: 5900 };
    const updated = [...machines, newMachine];
    setMachines(updated);
    window.electronAPI?.saveConfig({ machines: updated });
    addLog(`Added machine: ${newMachine.name}`);
  }, [machines, addLog]);

  const removeMachine = useCallback((id) => {
    if (machines.length <= 1) {
      addLog('Cannot remove last machine', 'warn');
      return;
    }
    const updated = machines.filter(m => m.id !== id);
    setMachines(updated);
    if (activeMachineId === id) {
      disconnectMachine();
    }
    window.electronAPI?.saveConfig({ machines: updated });
    addLog(`Removed machine ${id}`);
  }, [machines, activeMachineId, disconnectMachine, addLog]);

  const triggerReconnect = useCallback(() => {
    setReconnectFlag(f => f + 1);
    addLog('Reconnect triggered');
  }, [addLog]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(c => !c);
  }, []);

  const contextValue = {
    machines,
    activeMachineId,
    setActiveMachineId,
    setActiveMachine: setActiveMachineId,
    activeMachine,
    statuses,
    setStatuses,
    connectMachine,
    disconnectMachine,
    saveMachines,
    addMachine,
    removeMachine,
    triggerReconnect,
    showConfig,
    setShowConfig,
    showFiles,
    setShowFiles,
    sidebarCollapsed,
    toggleSidebar,
    maxMachines: MAX_MACHINES,
    logs,
    setLogs,
    showLogs,
    setShowLogs,
    addLog,
    connHistory,
    setConnHistory,
    recordConn,
    theme,
    setTheme,
    toggleTheme,
  };

  return (
    <MachineContext.Provider value={contextValue}>
      <div style={{ display: 'flex', height: '100vh', width: '100vw', position: 'relative' }}>
        <Sidebar />
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {showConfig ? (
            <ConfigPanel />
          ) : showFiles ? (
            <FileTransfer />
          ) : activeMachine ? (
            <RemoteViewer machine={activeMachine} reconnectFlag={reconnectFlag} />
          ) : (
            <Dashboard />
          )}
        </main>

        {/* Hamburger when sidebar collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            style={{
              position: 'fixed',
              top: 8,
              left: 8,
              zIndex: 99999,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px',
              opacity: 0.2,
              transition: 'opacity 0.2s',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
            }}
            onMouseEnter={(e) => e.currentTarget.style.opacity = '0.6'}
            onMouseLeave={(e) => e.currentTarget.style.opacity = '0.2'}
          >
            <div style={{ width: '18px', height: '2px', background: '#94a3b8', borderRadius: '1px' }} />
            <div style={{ width: '18px', height: '2px', background: '#94a3b8', borderRadius: '1px' }} />
            <div style={{ width: '18px', height: '2px', background: '#94a3b8', borderRadius: '1px' }} />
          </button>
        )}
      </div>
    </MachineContext.Provider>
  );
}
