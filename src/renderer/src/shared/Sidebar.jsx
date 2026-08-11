import { useContext, useMemo } from 'react';
import { Home, Settings, FolderOpen, Download, Sun, Moon, PanelLeftClose, X } from 'lucide-react';
import { MachineContext } from '../App';
import StatusBadge from './StatusBadge';
import { isPrivateNetworkHost } from './lib/net';

function NavButton({ active, onClick, icon, children, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
        active ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

export default function Sidebar() {
  const {
    machines,
    activeMachineId,
    connectMachine,
    disconnectMachine,
    addMachine,
    removeMachine,
    showConfig,
    setShowConfig,
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

  const goHome = () => {
    if (activeMachineId) disconnectMachine();
    setShowConfig(false);
    setShowFiles(false);
  };

  const isHome = !activeMachineId && !showConfig && !showFiles;

  return (
    <aside className="w-64 min-w-64 bg-surface border-r border-line flex flex-col">
      <div className="px-4 py-4 border-b border-line-subtle flex items-center justify-between">
        <button
          onClick={goHome}
          title="Voltar para a tela inicial"
          className="bg-transparent border-none p-0 text-left cursor-pointer"
        >
          <h1 className="text-lg font-semibold text-text-primary">OpenPortal</h1>
          <p className="text-xs text-text-muted mt-1">Remote Desktop Gateway</p>
        </button>
        <button
          onClick={toggleSidebar}
          className="bg-transparent border-none text-text-faint hover:text-text-secondary cursor-pointer p-1 transition-colors"
          title="Recolher barra lateral"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>

      <nav className="flex-1 p-3 overflow-y-auto">
        <p className="text-[11px] font-medium text-text-faint uppercase tracking-wide px-2 mb-2">
          PCs ({otherMachines.length}/{maxMachines})
        </p>
        {otherMachines.length === 0 && (
          <div className="px-2 py-3 text-xs text-text-faint text-center">
            Nenhum PC cadastrado
          </div>
        )}
        {otherMachines.map((machine) => {
          const isConfigured = machine.host && machine.host.trim() !== '';
          return (
            <div key={machine.id} className="relative mb-0.5 group">
              <button
                onClick={() => handleClickMachine(machine)}
                className={`w-full text-left px-3 py-2.5 rounded-lg border-none ${
                  isConfigured ? 'cursor-pointer text-text-secondary hover:bg-surface-2' : 'cursor-not-allowed text-text-faint'
                } bg-transparent transition-colors`}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{machine.name}</div>
                    {isConfigured && (
                      <div className="text-xs opacity-70 truncate mt-0.5 font-mono">
                        {machine.mask || `${machine.host}:${machine.port}`}
                      </div>
                    )}
                  </div>
                  <StatusBadge state={statuses[machine.id] || 'disconnected'} />
                </div>
              </button>
              <button
                onClick={() => handleRemove(machine.id, machine.name)}
                className="hidden group-hover:block absolute top-1 right-1 bg-transparent border-none text-text-faint hover:text-danger cursor-pointer p-1 rounded transition-colors"
                title="Remover PC"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        {machines.length < maxMachines && (
          <button
            onClick={addMachine}
            className="w-full px-3 py-2 mt-2 rounded-lg text-sm border border-dashed border-line text-text-muted hover:border-text-faint hover:text-text-secondary bg-transparent cursor-pointer transition-colors"
          >
            + Adicionar PC
          </button>
        )}
      </nav>

      <nav className="flex flex-col gap-0.5 p-2 border-t border-line-subtle">
        <NavButton active={isHome} onClick={goHome} icon={<Home size={16} />}>Início</NavButton>
        <NavButton active={showConfig} onClick={() => { setShowFiles(false); setShowConfig(!showConfig); }} icon={<Settings size={16} />}>
          Configurações
        </NavButton>
        <NavButton active={showFiles} onClick={() => { setShowConfig(false); setShowFiles(!showFiles); }} icon={<FolderOpen size={16} />}>
          Arquivos
        </NavButton>
        <NavButton onClick={handleCheckUpdate} icon={<Download size={16} />} title="Verificar atualizações">
          Atualizações
        </NavButton>
        <NavButton onClick={toggleTheme} icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />} title="Alternar tema claro/escuro">
          {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
        </NavButton>
      </nav>
    </aside>
  );
}
