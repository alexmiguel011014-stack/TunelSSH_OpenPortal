import { useEffect, useRef, useState, useContext, useCallback } from 'react';
import { MachineContext } from '../App';

const VNC_PASSWORDS = {
  '100.66.218.65': '011014',
  '100.81.199.56': 'Alex.777',
};

const QUALITY_LEVELS = [
  { label: 'Baixa', level: 0 },
  { label: 'Média', level: 3 },
  { label: 'Alta', level: 6 },
  { label: 'Máxima', level: 9 },
];

const MAX_VNC_RETRIES = 5;
const VNC_RETRY_DELAYS = [3000, 5000, 10000, 15000, 20000];

export default function RemoteViewer({ machine, reconnectFlag }) {
  const iframeRef = useRef(null);
  const containerRef = useRef(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [remoteRes, setRemoteRes] = useState(null);
  const [quality, setQuality] = useState(3);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { addLog, setStatuses, disconnectMachine, statuses } = useContext(MachineContext);

  const vncState = statuses[machine.id] || 'connecting';
  const healthMap = {
    connected: { color: '#22c55e', label: 'Conectado' },
    connecting: { color: '#f59e0b', label: 'Conectando...' },
    error: { color: '#ef4444', label: 'Erro' },
    disconnected: { color: '#94a3b8', label: 'Desconectado' },
  };
  const health = healthMap[vncState] || healthMap.disconnected;

  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);

  const scheduleReconnect = useCallback((why) => {
    if (!mountedRef.current) return;
    if (retryCountRef.current >= MAX_VNC_RETRIES) {
      if (addLog) addLog(`Conexão perdida e não reconectou após ${MAX_VNC_RETRIES} tentativas. Use "Reconectar".`, 'warn');
      return;
    }
    retryCountRef.current++;
    const delay = VNC_RETRY_DELAYS[Math.min(retryCountRef.current - 1, VNC_RETRY_DELAYS.length - 1)];
    if (addLog) addLog(`Conexão perdida (${why}). Reconectando em ${delay / 1000}s (tentativa ${retryCountRef.current}).`, 'warn');
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setIframeKey((k) => k + 1);
    }, delay);
  }, [addLog]);

  const proxyUrl = `ws://127.0.0.1:18900`;
  const password = VNC_PASSWORDS[machine.host] || '';
  const viewerUrl = `./noVNC/vnc.html?host=${machine.host}&port=${machine.port}&proxy=${encodeURIComponent(proxyUrl)}&password=${encodeURIComponent(password)}`;

  const sendResize = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'resize-viewport' }, '*');
    } catch (e) {}
  }, []);

  const sendQuality = useCallback((level) => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'set-quality', level }, '*');
    } catch (e) {}
  }, []);

  const handleReconnect = useCallback(() => {
    setIframeKey((k) => k + 1);
    if (addLog) addLog(`Reconectando a ${machine.host}:${machine.port}...`);
  }, [machine.host, machine.port, addLog]);

  const handleDisconnect = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'vnc-disconnect' }, '*');
    } catch (e) {}
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
        el.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
      }
    } catch (e) {}
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
    setIframeKey(k => k + 1);
  }, [machine.id, machine.host, machine.port]);

  useEffect(() => {
    if (reconnectFlag > 0) {
      setIframeKey(k => k + 1);
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
    return () => { ro.disconnect(); };
  }, [sendResize]);

  const ctrlBtn = {
    display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px',
    padding: '5px 10px', borderRadius: '6px', border: '1px solid #334155',
    background: '#1e293b', color: '#cbd5e1', cursor: 'pointer', whiteSpace: 'nowrap',
  };
  const ctrlLabel = { fontSize: '11px', color: '#94a3b8' };

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#000', overflow: 'hidden' }}
    >
      {/* Control bar (top) */}
      <div
        style={{
          display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap',
          background: '#0f172a', borderBottom: '1px solid #334155', padding: '6px 10px',
        }}
      >
        {remoteRes && (
          <span style={{ ...ctrlLabel, background: '#1e293b', border: '1px solid #334155', borderRadius: '4px', padding: '4px 8px' }}>
            Dimensão: {remoteRes.w}×{remoteRes.h}
          </span>
        )}
        <button style={ctrlBtn} onClick={handleReconnect} title="Reconectar">🔄 Reconectar</button>
        <button style={ctrlBtn} onClick={toggleFullscreen} title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
          {isFullscreen ? '⛶ Sair da tela' : '⛶ Tela cheia'}
        </button>
        <select
          title="Qualidade"
          value={quality}
          onChange={(e) => { const lv = parseInt(e.target.value, 10); setQuality(lv); sendQuality(lv); }}
          style={{ ...ctrlBtn, padding: '5px 8px' }}
        >
          {QUALITY_LEVELS.map((q) => (
            <option key={q.level} value={q.level}>Qualidade: {q.label}</option>
          ))}
        </select>
        <button style={{ ...ctrlBtn, color: '#f87171', borderColor: '#7f1d1d' }} onClick={handleDisconnect} title="Desconectar">⏹ Desconectar</button>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', ...ctrlLabel }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: health.color, display: 'inline-block' }} />
          {health.label}
        </span>
        <span style={ctrlLabel}>{machine.name} · {machine.host}:{machine.port}</span>
      </div>

      {/* Canvas viewport */}
      <div style={{ flex: 1, position: 'relative' }}>
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={viewerUrl}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          title={`VNC - ${machine.name}`}
        />
      </div>
    </div>
  );
}
