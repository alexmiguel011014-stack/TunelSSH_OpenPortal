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

export default function RemoteViewer({ machine, reconnectFlag }) {
  const iframeRef = useRef(null);
  const containerRef = useRef(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [remoteRes, setRemoteRes] = useState(null);
  const [quality, setQuality] = useState(3);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { addLog, setStatuses, disconnectMachine } = useContext(MachineContext);

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
        setStatuses((prev) => ({
          ...prev,
          [machine.id]: event.data.state,
        }));
      }
      if (event.data?.type === 'vnc-resolution') {
        setRemoteRes({ w: event.data.width, h: event.data.height });
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [machine.id, setStatuses]);

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
      style={{ flex: 1, position: 'relative', background: '#000', overflow: 'hidden' }}
    >
      <iframe
        key={iframeKey}
        ref={iframeRef}
        src={viewerUrl}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        title={`VNC - ${machine.name}`}
      />

      {/* Toolbar */}
      <div
        style={{
          position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 20, display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap',
          background: '#0f172a', border: '1px solid #334155', borderRadius: '8px',
          padding: '6px', boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
          maxWidth: '96%',
        }}
      >
        {remoteRes && <span style={ctrlLabel}>{remoteRes.w}×{remoteRes.h}</span>}
        <button style={ctrlBtn} onClick={handleReconnect} title="Reconectar">🔄 Reconectar</button>
        <button style={ctrlBtn} onClick={toggleFullscreen} title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
          {isFullscreen ? '⛶ Sair' : '⛶ Tela cheia'}
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
      </div>
    </div>
  );
}
