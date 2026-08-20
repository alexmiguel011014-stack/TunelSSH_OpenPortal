import { useEffect, useRef, useState, useContext, useCallback } from 'react';
import { RefreshCw, Maximize2, Minimize2, PowerOff } from 'lucide-react';
import { MachineContext } from '../../App';

const QUALITY_LEVELS = [
  { label: 'Baixa', level: 0 },
  { label: 'Média', level: 3 },
  { label: 'Alta', level: 6 },
  { label: 'Máxima', level: 9 },
];

const MAX_VNC_RETRIES = 5;
const VNC_RETRY_DELAYS = [3000, 5000, 10000, 15000, 20000];

export default function RemoteViewer({ machine, reconnectFlag, wasRejected }) {
  const iframeRef = useRef(null);
  const containerRef = useRef(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [remoteRes, setRemoteRes] = useState(null);
  const [quality, setQuality] = useState(3);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pingMs, setPingMs] = useState(null);
  const { addLog, setStatuses, disconnectMachine, statuses } = useContext(MachineContext);

  const vncState = statuses[machine.id] || 'connecting';
  const healthMap = {
    connected: { color: 'bg-success', label: 'Conectado' },
    connecting: { color: 'bg-warning', label: 'Conectando...' },
    error: { color: 'bg-danger', label: 'Erro' },
    disconnected: { color: 'bg-text-muted', label: 'Desconectado' },
  };
  const health = healthMap[vncState] || healthMap.disconnected;

  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);

  const scheduleReconnect = useCallback(
    (why) => {
      if (!mountedRef.current) return;
      if (retryCountRef.current >= MAX_VNC_RETRIES) {
        if (addLog)
          addLog(
            `Conexão perdida e não reconectou após ${MAX_VNC_RETRIES} tentativas. Use "Reconectar".`,
            'warn',
          );
        return;
      }
      retryCountRef.current++;
      const delay =
        VNC_RETRY_DELAYS[Math.min(retryCountRef.current - 1, VNC_RETRY_DELAYS.length - 1)];
      if (addLog)
        addLog(
          `Conexão perdida (${why}). Reconectando em ${delay / 1000}s (tentativa ${retryCountRef.current}).`,
          'warn',
        );
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setIframeKey((k) => k + 1);
      }, delay);
    },
    [addLog],
  );

  // A aprovação remota (dialogo Aceitar/Rejeitar) já é a trava de acesso.
  // Se rejeitada, VNC pede senha. Se aprovada, conecta direto.
  const proxyUrl = `ws://127.0.0.1:18900`;
  const passwordParam = machine.password ? `&password=${encodeURIComponent(machine.password)}` : '';
  const rejectedParam = wasRejected ? '&rejected=true' : '';
  const viewerUrl = `./noVNC/vnc.html?host=${machine.host}&port=${machine.port}&proxy=${encodeURIComponent(proxyUrl)}${passwordParam}${rejectedParam}`;

  const sendResize = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'resize-viewport' }, '*');
    } catch {}
  }, []);

  const sendQuality = useCallback((level) => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'set-quality', level }, '*');
    } catch {}
  }, []);

  const handleReconnect = useCallback(() => {
    setIframeKey((k) => k + 1);
    if (addLog) addLog(`Reconectando a ${machine.host}:${machine.port}...`);
  }, [machine.host, machine.port, addLog]);

  const handleDisconnect = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'vnc-disconnect' }, '*');
    } catch {}
    if (disconnectMachine) disconnectMachine();
  }, [disconnectMachine]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const isFs = document.fullscreenElement === el;
    try {
      if (isFs) {
        if (document.exitFullscreen) document.exitFullscreen();
        setIsFullscreen(false);
      } else if (el.requestFullscreen) {
        el.requestFullscreen()
          .then(() => setIsFullscreen(true))
          .catch(() => {});
      }
    } catch {}
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      setTimeout(sendResize, 120);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [sendResize]);

  useEffect(() => {
    setIframeKey((k) => k + 1);
  }, [machine.id, machine.host, machine.port]);

  useEffect(() => {
    if (reconnectFlag > 0) {
      setIframeKey((k) => k + 1);
    }
  }, [reconnectFlag]);

  useEffect(() => {
    if (!iframeRef.current) return;
    const iframe = iframeRef.current;
    const onLoad = () => {
      sendResize();
      sendQuality(quality);
      setTimeout(sendResize, 200);
      setTimeout(sendResize, 500);
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [iframeKey, sendResize, sendQuality, quality]);

  useEffect(() => {
    function handleMessage(event) {
      if (event.data?.type === 'vnc-status') {
        const st = event.data.state;
        setStatuses((prev) => ({
          ...prev,
          [machine.id]: st,
        }));
        if (st === 'connected' || st === 'connecting') {
          retryCountRef.current = 0;
        } else if (st === 'disconnected' || st === 'error') {
          scheduleReconnect(st);
        }
      }
      if (event.data?.type === 'vnc-resolution') {
        setRemoteRes({ w: event.data.width, h: event.data.height });
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [machine.id, setStatuses, scheduleReconnect]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  // Latência até o PC remoto, só enquanto a sessão está conectada —
  // reaproveita o mesmo teste de conexão TCP usado em Configurações.
  useEffect(() => {
    if (vncState !== 'connected') {
      setPingMs(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await window.electronAPI?.testConnection?.(machine.host, machine.port);
        if (!cancelled && res?.ok) setPingMs(res.ms);
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [vncState, machine.host, machine.port]);

  useEffect(() => {
    window.addEventListener('resize', sendResize);
    return () => window.removeEventListener('resize', sendResize);
  }, [sendResize]);

  useEffect(() => {
    if (!containerRef.current || !window.ResizeObserver) return;
    let rafPending = false;
    const ro = new ResizeObserver(() => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        sendResize();
      });
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
    };
  }, [sendResize]);

  const ctrlBtnClass =
    'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-line bg-surface text-text-secondary hover:bg-surface-2 transition-colors whitespace-nowrap';
  const ctrlLabelClass = 'text-[11px] text-text-muted';

  return (
    <div ref={containerRef} className="flex-1 flex flex-col bg-black overflow-hidden">
      {/* Control bar (top) */}
      <div className="flex gap-1.5 items-center flex-wrap bg-canvas border-b border-line pl-11 pr-2.5 py-1.5">
        {remoteRes && (
          <span className={`${ctrlLabelClass} bg-surface border border-line rounded px-2 py-1`}>
            Dimensão: {remoteRes.w}×{remoteRes.h}
          </span>
        )}
        <button className={ctrlBtnClass} onClick={handleReconnect} title="Reconectar">
          <RefreshCw size={13} /> Reconectar
        </button>
        <button
          className={ctrlBtnClass}
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
        >
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          {isFullscreen ? 'Sair da tela' : 'Tela cheia'}
        </button>
        <select
          title="Qualidade"
          value={quality}
          onChange={(e) => {
            const lv = parseInt(e.target.value, 10);
            setQuality(lv);
            sendQuality(lv);
          }}
          className={`${ctrlBtnClass} py-1.5`}
        >
          {QUALITY_LEVELS.map((q) => (
            <option key={q.level} value={q.level}>
              Qualidade: {q.label}
            </option>
          ))}
        </select>
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
          {pingMs !== null && <span>· {pingMs}ms</span>}
        </span>
        <span className={ctrlLabelClass}>
          {machine.name} · {machine.mask || `${machine.host}:${machine.port}`}
        </span>
      </div>

      {/* Canvas viewport */}
      <div className="flex-1 relative">
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={viewerUrl}
          className="w-full h-full border-none block"
          title={`VNC - ${machine.name}`}
        />
      </div>
    </div>
  );
}
