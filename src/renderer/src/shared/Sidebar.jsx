import { useContext } from 'react';
import {
  Home,
  Settings,
  FolderOpen,
  Activity,
  GraduationCap,
  Download,
  Sun,
  Moon,
  PanelLeftClose,
  PowerOff,
  X,
  KeyRound,
  LogOut,
  User,
  UserCheck,
} from 'lucide-react';
import { MachineContext } from '../App';
import { useAuth } from '../modules/auth/AuthContext';
import { canSee, roleLabel } from './lib/accounts';
import StatusBadge from './StatusBadge';
import { isPrivateNetworkHost } from './lib/net';
import { listQuickSessions } from './lib/connectionState';

function NavButton({ active, onClick, icon, children, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-surface-2 text-text-primary'
          : 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// Quem está usando o app (GOALS 20): nome, papel e Sair/Entrar. Sem contas neste build não aparece.
function AccountBlock({ account, onSignOut }) {
  if (account.kind === 'legacy') return null;
  const guest = account.kind === 'guest';
  const pending = account.kind === 'pending';
  return (
    <div className="px-3 py-2 mb-1 flex items-center gap-2">
      <User size={16} className="text-text-faint shrink-0" />
      <div className="min-w-0 flex-1">
        <div
          className="text-sm font-medium text-text-secondary truncate"
          title={guest ? undefined : account.profile.email}
        >
          {guest ? 'Sem conta' : account.profile.fullName}
        </div>
        <div
          className={`text-[11px] leading-tight ${pending ? 'text-warning' : 'text-text-faint'}`}
        >
          {guest ? 'Só este PC' : roleLabel(account)}
        </div>
      </div>
      {guest ? (
        <button
          onClick={onSignOut}
          className="text-xs text-accent hover:underline bg-transparent border-none cursor-pointer shrink-0"
        >
          Entrar
        </button>
      ) : (
        <button
          onClick={onSignOut}
          title="Sair da conta"
          aria-label="Sair da conta"
          className="bg-transparent border-none text-text-faint hover:text-text-secondary cursor-pointer p-1 transition-colors shrink-0"
        >
          <LogOut size={14} />
        </button>
      )}
    </div>
  );
}

export default function Sidebar() {
  const {
    machines,
    connectedMachines,
    focusedMachineId,
    setFocusedMachineId,
    connectMachine,
    disconnectMachine,
    addMachine,
    removeMachine,
    showConfig,
    setShowConfig,
    showFiles,
    setShowFiles,
    showActivity,
    setShowActivity,
    showLab,
    setShowLab,
    showApprovals,
    setShowApprovals,
    showAccess,
    setShowAccess,
    labMode,
    sidebarCollapsed,
    toggleSidebar,
    maxMachines,
    addLog,
    statuses,
    theme,
    toggleTheme,
  } = useContext(MachineContext);
  const { account, signOut, requests } = useAuth();

  if (sidebarCollapsed) return null;

  const handleClickMachine = (machine) => {
    const isConfigured = machine.host && machine.host.trim() !== '';
    if (!isConfigured) {
      if (addLog) addLog('Sidebar: machine not configured (no host)', 'warn');
      return;
    }
    if (!isPrivateNetworkHost(machine.host)) {
      if (addLog)
        addLog(
          `Aviso: ${machine.host} não parece ser da rede Tailscale. A conexão pode falhar.`,
          'warn',
        );
    }
    if (addLog) addLog(`Sidebar: connecting to ${machine.host}:${machine.port}`);
    connectMachine(machine);
  };

  const handleRemove = (id, name) => {
    if (addLog) addLog(`Sidebar: removing ${name}`);
    removeMachine(id);
  };

  const handleDisconnect = (id, name) => {
    if (addLog) addLog(`Sidebar: disconnecting ${name}`);
    disconnectMachine(id);
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

  // "Início" só tira o foco (Dashboard) — não desconecta nada. As conexões
  // em segundo plano continuam vivas, igual trocar de aba.
  const goHome = () => {
    setFocusedMachineId(null);
    setShowConfig(false);
    setShowFiles(false);
    setShowActivity(false);
    setShowLab(false);
    setShowApprovals(false);
    setShowAccess(false);
  };

  // Abre uma das telas da barra de baixo e fecha as outras; clicar na que já está aberta a fecha.
  const togglePanel = (name) => {
    const open = {
      activity: showActivity,
      lab: showLab,
      approvals: showApprovals,
      access: showAccess,
      config: showConfig,
      files: showFiles,
    };
    setShowActivity(name === 'activity' && !open.activity);
    setShowLab(name === 'lab' && !open.lab);
    setShowApprovals(name === 'approvals' && !open.approvals);
    setShowAccess(name === 'access' && !open.access);
    setShowConfig(name === 'config' && !open.config);
    setShowFiles(name === 'files' && !open.files);
  };

  const isHome =
    !focusedMachineId &&
    !showConfig &&
    !showFiles &&
    !showActivity &&
    !showLab &&
    !showApprovals &&
    !showAccess;
  const pendingCount = requests.list.length;

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

      {canSee(account, 'connect') ? (
        <nav className="flex-1 p-3 overflow-y-auto">
          <p className="text-[11px] font-medium text-text-faint uppercase tracking-wide px-2 mb-2">
            PCs ({machines.length}/{maxMachines})
          </p>
          {machines.length === 0 && (
            <div className="px-2 py-3 text-xs text-text-faint text-center">
              Nenhum PC cadastrado
            </div>
          )}
          {machines.map((machine) => {
            const isConfigured = machine.host && machine.host.trim() !== '';
            const isActive = machine.id === focusedMachineId;
            const isConnected = !!connectedMachines[machine.id];
            return (
              <div key={machine.id} className="relative mb-0.5 group">
                <button
                  onClick={() => handleClickMachine(machine)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border-none ${
                    isActive
                      ? 'bg-surface-2 text-text-primary'
                      : isConfigured
                        ? 'cursor-pointer text-text-secondary hover:bg-surface-2'
                        : 'cursor-not-allowed text-text-faint'
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
                {isConnected && (
                  <button
                    onClick={() => handleDisconnect(machine.id, machine.name)}
                    className="hidden group-hover:block absolute top-1 right-6 bg-transparent border-none text-text-faint hover:text-warning cursor-pointer p-1 rounded transition-colors"
                    title="Desconectar (mantém o PC na lista)"
                  >
                    <PowerOff size={12} />
                  </button>
                )}
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

          {listQuickSessions(machines, connectedMachines).length > 0 && (
            <p className="text-[11px] font-medium text-text-faint uppercase tracking-wide px-2 mt-3 mb-2">
              Conexões diretas
            </p>
          )}
          {listQuickSessions(machines, connectedMachines).map((session) => (
            <div key={session.id} className="relative mb-0.5 group">
              <button
                onClick={() => {
                  setShowConfig(false);
                  setShowFiles(false);
                  setShowActivity(false);
                  setShowLab(false);
                  setShowApprovals(false);
                  setShowAccess(false);
                  setFocusedMachineId(session.id);
                }}
                className={`w-full text-left px-3 py-2.5 rounded-lg border-none cursor-pointer ${
                  session.id === focusedMachineId
                    ? 'bg-surface-2 text-text-primary'
                    : 'text-text-secondary hover:bg-surface-2'
                } bg-transparent transition-colors`}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{session.name}</div>
                    <div className="text-xs opacity-70 truncate mt-0.5 font-mono">
                      {session.host}
                    </div>
                  </div>
                  <StatusBadge state={statuses[session.id] || 'disconnected'} />
                </div>
              </button>
              <button
                onClick={() => handleDisconnect(session.id, session.name)}
                className="hidden group-hover:block absolute top-1 right-1 bg-transparent border-none text-text-faint hover:text-warning cursor-pointer p-1 rounded transition-colors"
                title="Desconectar"
              >
                <PowerOff size={12} />
              </button>
            </div>
          ))}

          {machines.length < maxMachines && (
            <button
              onClick={addMachine}
              className="w-full px-3 py-2 mt-2 rounded-lg text-sm border border-dashed border-line text-text-muted hover:border-text-faint hover:text-text-secondary bg-transparent cursor-pointer transition-colors"
            >
              + Adicionar PC
            </button>
          )}
        </nav>
      ) : (
        <div className="flex-1" />
      )}

      <nav className="flex flex-col gap-0.5 p-2 border-t border-line-subtle">
        <AccountBlock account={account} onSignOut={signOut} />
        <NavButton active={isHome} onClick={goHome} icon={<Home size={16} />}>
          Início
        </NavButton>
        {canSee(account, 'access') && (
          <NavButton
            active={showAccess}
            onClick={() => togglePanel('access')}
            icon={<KeyRound size={16} />}
          >
            Meu acesso
          </NavButton>
        )}
        {canSee(account, 'activity') && (
          <NavButton
            active={showActivity}
            onClick={() => togglePanel('activity')}
            icon={<Activity size={16} />}
          >
            Atividade
          </NavButton>
        )}
        {labMode && canSee(account, 'lab') && (
          <NavButton
            active={showLab}
            onClick={() => togglePanel('lab')}
            icon={<GraduationCap size={16} />}
          >
            Laboratório
          </NavButton>
        )}
        {canSee(account, 'approvals') && (
          <NavButton
            active={showApprovals}
            onClick={() => togglePanel('approvals')}
            icon={<UserCheck size={16} />}
          >
            Aprovações
            {pendingCount > 0 && (
              <span
                className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                aria-label={`${pendingCount} pedidos pendentes`}
              >
                {pendingCount}
              </span>
            )}
          </NavButton>
        )}
        <NavButton
          active={showConfig}
          onClick={() => togglePanel('config')}
          icon={<Settings size={16} />}
        >
          Configurações
        </NavButton>
        {canSee(account, 'files') && (
          <NavButton
            active={showFiles}
            onClick={() => togglePanel('files')}
            icon={<FolderOpen size={16} />}
          >
            Arquivos
          </NavButton>
        )}
        <NavButton
          onClick={handleCheckUpdate}
          icon={<Download size={16} />}
          title="Verificar atualizações"
        >
          Atualizações
        </NavButton>
        <NavButton
          onClick={toggleTheme}
          icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          title="Alternar tema claro/escuro"
        >
          {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
        </NavButton>
      </nav>
    </aside>
  );
}
