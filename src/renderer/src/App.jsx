import { useState, useEffect, createContext, useCallback, useRef } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import Sidebar from './shared/Sidebar';
import RemoteViewer from './modules/connection/RemoteViewer';
import RdpViewer from './modules/connection/RdpViewer';
import ConfigPanel from './modules/config/ConfigPanel';
import FileExplorer from './modules/file-transfer/FileExplorer';
import ActivityPanel from './modules/activity/ActivityPanel';
import Dashboard from './modules/dashboard/Dashboard';
import {
  connectMachineEntry,
  disconnectMachineEntry,
  pickFocusAfterDisconnect,
  resolveTransport,
} from './shared/lib/connectionState';

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

// Deriva o próximo id a partir do maior "pc-N" já existente na lista atual
// (em vez de um contador fixo em módulo) — um contador fixo reiniciava em 4
// a cada abertura do app e colidia com ids maiores já salvos em config.json,
// fazendo o novo PC sobrescrever um existente com o mesmo id.
function genId(existingMachines) {
  let max = 0;
  for (const m of existingMachines) {
    const match = /^pc-(\d+)$/.exec(m.id || '');
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return 'pc-' + (max + 1);
}

export default function App() {
  const [machines, setMachines] = useState(DEFAULT_MACHINES);
  // Mapa de máquinas conectadas (id -> { machine, ftSessionId }). Trocar de
  // foco não mexe aqui — só desconectar remove uma entrada. Ver
  // docs/ARQUITETURA_CONEXAO.md, "Modelo de estado (multi-sessão)".
  const [connectedMachines, setConnectedMachines] = useState({});
  const [focusedMachineId, setFocusedMachineId] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [showConfig, setShowConfig] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [reconnectFlag, setReconnectFlag] = useState(0);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [connHistory, setConnHistory] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('openportal-theme') || 'dark');
  const [wasRejected, setWasRejected] = useState(false);
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
    window.electronAPI?.addHistoryEntry?.(entry).catch(() => {});
  }, []);

  // Hidrata o histórico salvo em disco (sobrevive a reinícios do app) —
  // se falhar, mantém o array vazio do useState e segue normalmente.
  useEffect(() => {
    window.electronAPI
      ?.getHistory?.()
      .then((entries) => {
        if (Array.isArray(entries) && entries.length > 0) {
          setConnHistory(entries.slice(-49));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.electronAPI
      ?.getConfig?.()
      .then((config) => {
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
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleTransportStatus = (status) => {
      addLog(`Status: ${status.state} (machine: ${status.machineId || 'none'})`);
      setStatuses((prev) => ({
        ...prev,
        [status.machineId || 'global']: status.state,
      }));
      // Cobre máquinas cadastradas E conexões avulsas (IP direto), que não
      // aparecem em `machines` mas têm entrada própria em connectedMachines.
      const m =
        connectedMachines[status.machineId]?.machine ||
        machines.find((x) => x.id === status.machineId);
      const stateLabel = status.state === 'connected' ? 'connect' : status.state;
      if (
        m &&
        (status.state === 'connected' ||
          status.state === 'error' ||
          status.state === 'disconnected')
      ) {
        recordConn({
          name: m.name,
          host: m.host,
          state: stateLabel,
          message: status.state,
        });
      }
      if (status.state === 'connected' && m) {
        window.electronAPI?.notify({
          title: 'Conexão estabelecida',
          body: `${m.name} (${m.host}) conectado.`,
        });
      } else if (status.state === 'error' && m) {
        window.electronAPI?.notify({
          title: 'Falha na conexão',
          body: `Não foi possível conectar a ${m.name} (${m.host}).`,
        });
      }
    };
    const unsubVnc = window.electronAPI?.onVncStatus(handleTransportStatus);
    const unsubRdp = window.electronAPI?.onRdpStatus(handleTransportStatus);
    return () => {
      unsubVnc?.();
      unsubRdp?.();
    };
  }, [machines, connectedMachines, recordConn, addLog]);

  const focusedMachine = focusedMachineId
    ? connectedMachines[focusedMachineId]?.machine || null
    : null;
  const ftSessionId = focusedMachineId
    ? connectedMachines[focusedMachineId]?.ftSessionId || null
    : null;

  // Desconecta uma máquina específica sem afetar as outras conectadas — o id
  // é sempre explícito agora que várias podem estar conectadas ao mesmo tempo.
  const disconnectMachine = useCallback(
    (id) => {
      const entry = connectedMachines[id];
      if (!entry) return;
      addLog(`Disconnected: ${entry.machine.name}`);
      if (resolveTransport(entry.machine) === 'rdp') {
        window.electronAPI?.stopRdp(id);
      } else {
        window.electronAPI?.disconnectVnc(id);
      }
      if (entry.ftSessionId) {
        window.electronAPI?.ftDisconnect(entry.ftSessionId).catch(() => {});
      }
      recordConn({
        name: entry.machine.name,
        host: entry.machine.host,
        state: 'disconnect',
        message: 'Desconectado',
      });
      setConnectedMachines((prev) => disconnectMachineEntry(prev, id));
      setStatuses((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setFocusedMachineId((prev) => pickFocusAfterDisconnect(connectedMachines, prev, id));
    },
    [addLog, connectedMachines, recordConn],
  );

  // Ponto único de conexão: cobre PCs cadastrados (Sidebar/Dashboard) e IP
  // avulso. Se a máquina já está conectada, só troca o foco — nunca
  // desconecta as outras. Nunca reaproveita aprovação anterior num connect
  // novo: pede permissão ao PC remoto sempre, e essa MESMA aprovação já
  // libera a sessão de arquivos (ver file-transfer-session.js no main),
  // então a tela de Arquivos nunca precisa pedir IP nem permissão de novo.
  const connectMachine = useCallback(
    async (machine) => {
      if (!machine || !machine.host) return;
      if (connectedMachines[machine.id]) {
        setShowConfig(false);
        setShowFiles(false);
        setFocusedMachineId(machine.id);
        return;
      }
      setShowConfig(false);
      setShowFiles(false);
      addLog(`Solicitando conexão a ${machine.name} (${machine.host})...`);
      recordConn({
        name: machine.name,
        host: machine.host,
        state: 'connecting',
        message: `Aguardando aprovação de ${machine.host}`,
      });

      let fromIp = '';
      try {
        const res = await window.electronAPI.getLocalIp();
        fromIp = (res && res.ip) || '';
      } catch {}

      try {
        console.log(
          `[app] Connecting to ${machine.name} (${machine.host}:${machine.port}) with fromIp=${fromIp}`,
        );
        const res = await window.electronAPI.ftConnect(machine.host, {
          fromIp,
        });
        if (!res || !res.success) {
          const rejected = res?.rejected === true;
          const message = (res && res.message) || 'Conexão recusada ou sem resposta';
          if (rejected) {
            console.warn(`[app] Connection explicitly rejected by user: ${message}`);
            addLog(`Conexão recusada pelo PC remoto: ${message}`, 'error');
            setWasRejected(true);
            recordConn({
              name: machine.name,
              host: machine.host,
              state: 'error',
              message: 'Conexão recusada pelo usuário',
            });
          } else {
            console.warn(`[app] Connection failed: ${message}`);
            addLog(`Falha na conexão: ${message}`, 'error');
            setWasRejected(false);
            recordConn({
              name: machine.name,
              host: machine.host,
              state: 'error',
              message,
            });
          }
          window.electronAPI?.notify?.({
            title: 'Conexão falhou',
            body: `${machine.name}: ${message}`,
          });
          return;
        }
        setWasRejected(false);
        setConnectedMachines((prev) =>
          connectMachineEntry(prev, machine, { ftSessionId: res.sessionId }),
        );
        setFocusedMachineId(machine.id);
        console.log(
          `[app] Connection approved, file session: ${res.sessionId}, transport=${resolveTransport(machine)}...`,
        );
        // RDP não usa vnc:connect — RdpViewer inicia a sidecar sozinho, uma
        // vez montado, porque só ele conhece o retângulo real do seu <div>.
        if (resolveTransport(machine) !== 'rdp') {
          window.electronAPI
            ?.connectVnc(machine)
            .catch((e) => console.warn('[app] VNC connect error:', e));
        }
        addLog(`Conexão aprovada por ${machine.name}.`);
      } catch (err) {
        console.error(`[app] Connection error:`, err);
        addLog(`Erro ao conectar: ${err.message}`, 'error');
        setWasRejected(false);
        recordConn({
          name: machine.name,
          host: machine.host,
          state: 'error',
          message: err.message,
        });
      }
    },
    [connectedMachines, addLog, recordConn],
  );

  const saveMachines = useCallback(
    (newMachines) => {
      setMachines(newMachines);
      window.electronAPI?.saveConfig({ machines: newMachines });
      addLog('Config saved');
    },
    [addLog],
  );

  const addMachine = useCallback(() => {
    if (machines.length >= MAX_MACHINES) {
      addLog(`Max ${MAX_MACHINES} machines reached`, 'warn');
      return;
    }
    const newMachine = {
      id: genId(machines),
      name: `PC ${machines.length + 1}`,
      host: '',
      port: 5900,
      mask: genMask(),
    };
    const updated = [...machines, newMachine];
    setMachines(updated);
    window.electronAPI?.saveConfig({ machines: updated });
    addLog(`Added machine: ${newMachine.name}`);
  }, [machines, addLog]);

  const removeMachine = useCallback(
    (id) => {
      if (machines.length <= 1) {
        addLog('Cannot remove last machine', 'warn');
        return;
      }
      const updated = machines.filter((m) => m.id !== id);
      setMachines(updated);
      if (connectedMachines[id]) {
        disconnectMachine(id);
      }
      window.electronAPI?.saveConfig({ machines: updated });
      addLog(`Removed machine ${id}`);
    },
    [machines, connectedMachines, disconnectMachine, addLog],
  );

  const triggerReconnect = useCallback(() => {
    setReconnectFlag((f) => f + 1);
    addLog('Reconnect triggered');
  }, [addLog]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => !c);
  }, []);

  const contextValue = {
    machines,
    connectedMachines,
    focusedMachineId,
    setFocusedMachineId,
    focusedMachine,
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
    showActivity,
    setShowActivity,
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
    wasRejected,
  };

  return (
    <MachineContext.Provider value={contextValue}>
      <div className="flex h-screen w-screen relative overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {/* Uma instância de RemoteViewer por máquina conectada, sempre
              montada — só a focada (e só quando não estamos em
              Config/Arquivos/Atividade) fica visível. Isso evita derrubar a
              sessão VNC das outras ao trocar de foco (ver
              docs/ARQUITETURA_CONEXAO.md). */}
          {Object.entries(connectedMachines).map(([id, entry]) => {
            const isFocusedAndVisible =
              !showConfig && !showFiles && !showActivity && id === focusedMachineId;
            return (
              <div
                key={id}
                className="absolute inset-0 flex flex-col overflow-hidden"
                style={{
                  display: isFocusedAndVisible ? 'flex' : 'none',
                }}
              >
                {resolveTransport(entry.machine) === 'rdp' ? (
                  <RdpViewer machine={entry.machine} isVisible={isFocusedAndVisible} />
                ) : (
                  <RemoteViewer
                    machine={entry.machine}
                    reconnectFlag={reconnectFlag}
                    wasRejected={wasRejected}
                  />
                )}
              </div>
            );
          })}

          {showConfig ? (
            <ConfigPanel />
          ) : showFiles ? (
            <FileExplorer />
          ) : showActivity ? (
            <ActivityPanel />
          ) : !focusedMachineId ? (
            <Dashboard />
          ) : null}
        </main>

        {/* Hamburger when sidebar collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            title="Mostrar barra lateral"
            className="fixed top-2 left-2 z-[9999] p-2 rounded-md bg-surface/85 border border-line hover:opacity-100 opacity-85 transition-opacity text-text-secondary"
          >
            <PanelLeftOpen size={18} />
          </button>
        )}
      </div>
    </MachineContext.Provider>
  );
}
