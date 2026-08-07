import { useState, useEffect, createContext, useCallback, useRef } from 'react';
import Sidebar from './shared/Sidebar';
import RemoteViewer from './modules/connection/RemoteViewer';
import ConfigPanel from './modules/config/ConfigPanel';
import FileExplorer from './modules/file-transfer/FileExplorer';
import Dashboard from './modules/dashboard/Dashboard';

export const MachineContext = createContext(null);

// Máscara cosmética estilo AnyDesk (ex: "482 917 356"): esconde o IP:porta
// real na UI. A conexão por trás continua usando o host/porta salvos —
// isso é só uma etiqueta, não um identificador funcional/roteável.
function genMask() {
  const group = () => String(Math.floor(100 + Math.random() * 900));
  return `${group()} ${group()} ${group()}`;
}

const DEFAULT_MACHINES = [
  { id: 'pc-1', name: 'PC Remoto 1', host: '', port: 5900, mask: genMask() },
  { id: 'pc-2', name: 'PC Remoto 2', host: '', port: 5900, mask: genMask() },
  { id: 'pc-3', name: 'PC 3', host: '', port: 5900, mask: genMask() },
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
  const [ftSessionId, setFtSessionId] = useState(null);
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
        let changed = false;
        const withMasks = config.machines.map((m) => {
          if (m.mask) return m;
          changed = true;
          return { ...m, mask: genMask() };
        });
        setMachines(withMasks);
        if (changed) window.electronAPI?.saveConfig?.({ machines: withMasks });
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

  const disconnectMachine = useCallback(async () => {
    addLog('Disconnected');
    window.electronAPI?.disconnectVnc();
    if (ftSessionId) {
      window.electronAPI?.ftDisconnect(ftSessionId).catch(() => {});
    }
    if (activeMachine) {
      recordConn({ name: activeMachine.name, host: activeMachine.host, state: 'disconnect', message: 'Desconectado' });
    }
    setActiveMachineId(null);
    setFtSessionId(null);
    setStatuses({});
  }, [addLog, activeMachine, recordConn, ftSessionId]);

  // Ponto único de conexão: cobre PCs cadastrados (Sidebar/Dashboard) e IP
  // avulso. Nunca reaproveita aprovação anterior — pede permissão ao PC
  // remoto sempre, e essa MESMA aprovação já libera o túnel de arquivos
  // (ver tunnel-manager.js no main), então a tela de Arquivos nunca precisa
  // pedir IP nem permissão de novo.
  const connectMachine = useCallback(async (machine) => {
    if (!machine || !machine.host) return;
    if (activeMachine) {
      await disconnectMachine();
    }
    setShowConfig(false);
    setShowFiles(false);
    addLog(`Solicitando conexão a ${machine.name} (${machine.host})...`);
    recordConn({ name: machine.name, host: machine.host, state: 'connecting', message: `Aguardando aprovação de ${machine.host}` });

    let fromIp = '';
    try {
      const res = await window.electronAPI.getLocalIp();
      fromIp = (res && res.ip) || '';
    } catch {}

    try {
      const res = await window.electronAPI.ftConnect(machine.host, { fromIp });
      if (!res || !res.success) {
        const message = (res && res.message) || 'Conexão recusada ou sem resposta';
        addLog(`Conexão recusada: ${message}`, 'error');
        recordConn({ name: machine.name, host: machine.host, state: 'error', message });
        window.electronAPI?.notify?.({ title: 'Conexão recusada', body: `${machine.name} não aceitou a conexão. O app precisa estar aberto no PC remoto.` });
        return;
      }
      setFtSessionId(res.sessionId);
      const identity = machines.some((m) => m.id === machine.id) ? machine.id : machine;
      setActiveMachineId(identity);
      window.electronAPI?.connectVnc(machine).catch(() => {});
      addLog(`Conexão aprovada por ${machine.name}.`);
    } catch (err) {
      addLog(`Erro ao conectar: ${err.message}`, 'error');
      recordConn({ name: machine.name, host: machine.host, state: 'error', message: err.message });
    }
  }, [activeMachine, disconnectMachine, machines, addLog, recordConn]);

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
    const newMachine = { id: genId(), name: `PC ${machines.length + 1}`, host: '', port: 5900, mask: genMask() };
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
    ftSessionId,
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
            <FileExplorer />
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
