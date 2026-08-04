import { useEffect, useRef, useState, useContext, useCallback } from 'react';
import { MachineContext } from '../App';

const VNC_PASSWORDS = {
  '100.66.218.65': '011014',
  '100.81.199.56': 'Alex.777',
};

export default function RemoteViewer({ machine, reconnectFlag }) {
  const iframeRef = useRef(null);
  const containerRef = useRef(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [remoteRes, setRemoteRes] = useState(null);
  const { addLog, setStatuses } = useContext(MachineContext);

  const proxyUrl = `ws://127.0.0.1:18900`;
  const password = VNC_PASSWORDS[machine.host] || '';
  const viewerUrl = `./noVNC/vnc.html?host=${machine.host}&port=${machine.port}&proxy=${encodeURIComponent(proxyUrl)}&password=${encodeURIComponent(password)}`;

  const sendResize = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ type: 'resize-viewport' }, '*');
    } catch (e) {}
  }, []);

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
      setTimeout(sendResize, 200);
      setTimeout(sendResize, 500);
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [iframeKey, sendResize]);

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
    </div>
  );
}
