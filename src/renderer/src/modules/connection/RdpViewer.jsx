import { useEffect, useRef, useCallback, useContext } from 'react';
import { PowerOff, MonitorSmartphone } from 'lucide-react';
import { MachineContext } from '../../App';

// Espelha o formato/ciclo de vida de RemoteViewer.jsx (mesma barra de
// controle, mesmo modelo multi-instância do GOALS 1), mas em vez de um
// <iframe> renderiza um <div> posicionado: quem desenha a tela de verdade é
// a janela nativa da sidecar (C#/MSTSCLib), reparented por cima dessa área
// pelo processo principal (ver docs/ARQUITETURA_CONEXAO.md e GOALS.md,
// seção "GOALS 2"). A sidecar também reporta os eventos de sessão pelo pipe.
export default function RdpViewer({ machine, isVisible }) {
  const containerRef = useRef(null);
  const startedRef = useRef(false);
  const lifecycleIdRef = useRef(null);
  const { statuses, disconnectMachine } = useContext(MachineContext);

  const vncState = statuses[machine.id] || 'connecting';
  const healthMap = {
    connected: { color: 'bg-success', label: 'Conectado' },
    connecting: { color: 'bg-warning', label: 'Conectando...' },
    error: { color: 'bg-danger', label: 'Erro' },
    disconnected: { color: 'bg-text-muted', label: 'Desconectado' },
  };
  const health = healthMap[vncState] || healthMap.disconnected;
  const hostModeLabel =
    machine.rdpHostMode === 'native-window'
      ? 'RDP em janela compatível'
      : machine.rdpHostMode === 'auto-fallback'
        ? 'RDP no app + fallback'
        : 'RDP dentro do app';

  // Pixels físicos: SetWindowPos (Win32) não conhece pixels lógicos do DOM —
  // numa tela com escala 125%/150% os dois divergem.
  const currentRect = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      w: Math.round(r.width * dpr),
      h: Math.round(r.height * dpr),
    };
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    const rect = currentRect();
    if (!rect) return;
    const lifecycleId = window.crypto.randomUUID();
    startedRef.current = true;
    lifecycleIdRef.current = lifecycleId;
    console.info(`[rdp-trace] ${machine.id} ${lifecycleId} renderer start`);
    window.electronAPI
      ?.startRdp(machine, rect, lifecycleId)
      .catch((e) => console.warn('[app] RDP start error:', e));

    return () => {
      startedRef.current = false;
      if (lifecycleIdRef.current === lifecycleId) lifecycleIdRef.current = null;
      console.info(`[rdp-trace] ${machine.id} ${lifecycleId} renderer cleanup`);
      window.electronAPI?.stopRdp(machine.id, lifecycleId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  useEffect(() => {
    window.electronAPI?.setRdpVisible(machine.id, !!isVisible, lifecycleIdRef.current);
  }, [isVisible, machine.id]);

  useEffect(() => {
    const sendResize = () => {
      const rect = currentRect();
      if (rect) window.electronAPI?.resizeRdp(machine.id, rect, lifecycleIdRef.current);
    };
    window.addEventListener('resize', sendResize);
    let ro;
    if (containerRef.current && window.ResizeObserver) {
      let rafPending = false;
      ro = new ResizeObserver(() => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          sendResize();
        });
      });
      ro.observe(containerRef.current);
    }
    return () => {
      window.removeEventListener('resize', sendResize);
      ro?.disconnect();
    };
  }, [currentRect, machine.id]);

  const handleDisconnect = useCallback(() => {
    if (disconnectMachine) disconnectMachine(machine.id);
  }, [disconnectMachine, machine.id]);

  const ctrlBtnClass =
    'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-line bg-surface text-text-secondary hover:bg-surface-2 transition-colors whitespace-nowrap';
  const ctrlLabelClass = 'text-[11px] text-text-muted';

  return (
    <div className="flex-1 flex flex-col bg-black overflow-hidden">
      <div className="flex gap-1.5 items-center flex-wrap bg-canvas border-b border-line pl-11 pr-2.5 py-1.5">
        <span className={`${ctrlLabelClass} bg-surface border border-line rounded px-2 py-1`}>
          {hostModeLabel}
        </span>
        <button
          className={`${ctrlBtnClass} text-danger border-danger/40 border-l ml-1 pl-2.5`}
          onClick={handleDisconnect}
          title="Desconectar"
        >
          <PowerOff size={13} /> Desconectar
        </button>
        <div className="flex-1" />
        <span className={`inline-flex items-center gap-1.5 ${ctrlLabelClass}`}>
          <span className={`w-2 h-2 rounded-full inline-block ${health.color}`} />
          {health.label}
        </span>
        <span className={ctrlLabelClass}>
          {machine.name} · {machine.mask || `${machine.host}:${machine.rdpPort || 3389}`}
        </span>
      </div>

      {/* Área reservada para a janela nativa da sidecar — o que aparece
          aqui embaixo (fundo escuro + ícone) só é visível antes da sidecar
          subir ou se ela falhar ao encaixar; quando tudo funciona, a janela
          nativa cobre esta div inteira por cima. */}
      <div ref={containerRef} className="flex-1 relative flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-text-muted pointer-events-none">
          <MonitorSmartphone size={28} />
          <span className="text-xs">
            {machine.rdpHostMode === 'native-window'
              ? 'A sessão será exibida em uma janela separada'
              : `Sessão RDP nativa — ${machine.name}`}
          </span>
        </div>
      </div>
    </div>
  );
}
