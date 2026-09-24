import { useEffect, useRef, useState, useContext, useCallback, useMemo } from 'react';
import { RefreshCw, Maximize2, Minimize2, PowerOff } from 'lucide-react';
import { MachineContext } from '../../App';
import {
  buildVncViewerUrl,
  isRetryableVncState,
  shouldExplainMissingTunnel,
  shouldUseSavedVncCredential,
} from '../../shared/lib/vncSession';

const QUALITY_LEVELS = [
  { label: 'Baixa', level: 0 },
  { label: 'Média', level: 3 },
  { label: 'Alta', level: 6 },
  { label: 'Máxima', level: 9 },
];

const MAX_VNC_RETRIES = 5;
const VNC_RETRY_DELAYS = [3000, 5000, 10000, 15000, 20000];

export default function RemoteViewer({ machine, vncGrant, vncTunnel, reconnectFlag }) {
  const iframeRef = useRef(null);
  const containerRef = useRef(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [remoteRes, setRemoteRes] = useState(null);
  const [quality, setQuality] = useState(3);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pingMs, setPingMs] = useState(null);
  const [credentialDialog, setCredentialDialog] = useState(null);
  const [credentialValue, setCredentialValue] = useState('');
  const [saveCredential, setSaveCredential] = useState(false);
  const { addLog, recordConn, saveVncCredential, setStatuses, disconnectMachine, statuses } =
    useContext(MachineContext);

  const vncState = statuses[machine.id] || 'connecting';
  const healthMap = {
    connected: { color: 'bg-success', label: 'Conectado' },
    'credentials-required': { color: 'bg-warning', label: 'Senha necessária' },
    'authentication-failed': { color: 'bg-danger', label: 'Senha recusada' },
    'server-refused': { color: 'bg-danger', label: 'VNC recusou a conexão' },
    'connection-lost': { color: 'bg-danger', label: 'Conexão perdida' },
    connecting: { color: 'bg-warning', label: 'Conectando...' },
    error: { color: 'bg-danger', label: 'Erro' },
    disconnected: { color: 'bg-text-muted', label: 'Desconectado' },
  };
  const health = healthMap[vncState] || healthMap.disconnected;

  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const savedCredentialTriedRef = useRef(false);
  // Senha do TightVNC que o PC remoto entregou junto com a aprovação: usada
  // sozinha em cada tentativa desta sessão (inclui reconexões), até o
  // TightVNC recusá-la uma vez.
  const grantTriedRef = useRef(false);
  const grantRejectedRef = useRef(false);
  const everConnectedRef = useRef(false);
  const tunnelHintShownRef = useRef(false);
  const pendingCredentialRef = useRef('');
  const activeAttemptRef = useRef('');
  const terminalReportedRef = useRef(false);
  const attemptId = useMemo(() => `vnc-${machine.id}-${iframeKey}`, [iframeKey, machine.id]);

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

  const proxyUrl = `ws://127.0.0.1:18900`;
  const viewerUrl = buildVncViewerUrl({
    host: machine.host,
    port: machine.port,
    proxyUrl,
    attemptId,
  });

  const postToViewer = useCallback(
    (message) => {
      try {
        iframeRef.current?.contentWindow?.postMessage({ ...message, attemptId }, '*');
      } catch {}
    },
    [attemptId],
  );

  const sendResize = useCallback(() => {
    postToViewer({ type: 'resize-viewport' });
  }, [postToViewer]);

  const sendQuality = useCallback(
    (level) => {
      postToViewer({ type: 'set-quality', level });
    },
    [postToViewer],
  );

  const handleReconnect = useCallback(() => {
    setCredentialDialog(null);
    setCredentialValue('');
    pendingCredentialRef.current = '';
    savedCredentialTriedRef.current = false;
    retryCountRef.current = 0;
    setIframeKey((k) => k + 1);
    if (addLog) addLog(`Reconectando a ${machine.host}:${machine.port}...`);
  }, [machine.host, machine.port, addLog]);

  const handleDisconnect = useCallback(() => {
    postToViewer({ type: 'vnc-disconnect' });
    if (disconnectMachine) disconnectMachine(machine.id);
  }, [disconnectMachine, machine.id, postToViewer]);

  const openCredentialDialog = useCallback((error = '', restart = false) => {
    setCredentialValue('');
    setSaveCredential(false);
    setCredentialDialog({ error, restart });
  }, []);

  const submitCredential = useCallback(async () => {
    const password = credentialValue;
    if (!password) {
      setCredentialDialog((current) => ({ ...current, error: 'Digite a senha do servidor VNC.' }));
      return;
    }

    const shouldPersist = saveCredential && !machine.id.startsWith('quick-');
    if (shouldPersist) await saveVncCredential(machine.id, password);

    const shouldRestart = credentialDialog?.restart;
    setCredentialDialog(null);
    setCredentialValue('');
    setSaveCredential(false);
    if (shouldRestart) {
      pendingCredentialRef.current = password;
      savedCredentialTriedRef.current = false;
      setIframeKey((key) => key + 1);
      return;
    }
    postToViewer({ type: 'vnc-credentials', password });
  }, [
    credentialDialog?.restart,
    credentialValue,
    machine.id,
    postToViewer,
    saveCredential,
    saveVncCredential,
  ]);

  const cancelCredential = useCallback(() => {
    setCredentialDialog(null);
    setCredentialValue('');
    setSaveCredential(false);
    postToViewer({ type: 'vnc-cancel-credentials' });
    if (disconnectMachine) disconnectMachine(machine.id);
  }, [disconnectMachine, machine.id, postToViewer]);

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
    activeAttemptRef.current = attemptId;
    terminalReportedRef.current = false;
    grantTriedRef.current = false;
    if (!pendingCredentialRef.current) savedCredentialTriedRef.current = false;
  }, [attemptId]);

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
    const isExpectedIframe = (event) => event.source === iframeRef.current?.contentWindow;
    const recordVncState = (state, message) => {
      if (!recordConn) return;
      recordConn({ name: machine.name, host: machine.host, state, message });
    };

    const requestCredentials = async () => {
      if (pendingCredentialRef.current) {
        const password = pendingCredentialRef.current;
        pendingCredentialRef.current = '';
        postToViewer({ type: 'vnc-credentials', password });
        return;
      }
      if (vncGrant && !grantRejectedRef.current && !grantTriedRef.current) {
        grantTriedRef.current = true;
        postToViewer({ type: 'vnc-credentials', password: vncGrant });
        return;
      }
      if (
        !shouldUseSavedVncCredential({
          hasSavedCredential: machine.hasVncPassword,
          savedCredentialTried: savedCredentialTriedRef.current,
        })
      ) {
        openCredentialDialog();
        return;
      }

      savedCredentialTriedRef.current = true;
      try {
        const password = await window.electronAPI?.getVncCredential?.(machine.id);
        if (activeAttemptRef.current !== attemptId || !iframeRef.current?.contentWindow) return;
        if (password) {
          postToViewer({ type: 'vnc-credentials', password });
        } else {
          openCredentialDialog();
        }
      } catch {
        openCredentialDialog();
      }
    };

    function handleMessage(event) {
      const data = event.data;
      if (!data || !isExpectedIframe(event) || data.attemptId !== attemptId) return;

      if (data.type === 'vnc-resolution') {
        setRemoteRes({ w: data.width, h: data.height });
        return;
      }
      if (data.type === 'vnc-reconnect-request') {
        handleReconnect();
        return;
      }
      if (data.type !== 'vnc-status') return;

      const state = data.state;
      setStatuses((prev) => ({ ...prev, [machine.id]: state }));
      if (state === 'connected') {
        everConnectedRef.current = true;
        retryCountRef.current = 0;
        terminalReportedRef.current = false;
        return;
      }
      if (state === 'credentials-required') {
        recordVncState(state, 'Senha VNC necessária');
        void requestCredentials();
        return;
      }
      if (state === 'authentication-failed') {
        if (!terminalReportedRef.current) {
          terminalReportedRef.current = true;
          recordVncState(state, 'Senha VNC não aceita');
        }
        let failure = savedCredentialTriedRef.current
          ? 'A senha VNC salva não foi aceita. Informe outra senha para tentar de novo.'
          : 'A senha VNC não foi aceita. Confira a senha configurada no TightVNC.';
        if (grantTriedRef.current) {
          grantRejectedRef.current = true;
          failure =
            'O TightVNC do PC remoto não aceitou a senha enviada por ele. Lá, use "Configurar TightVNC" de novo ou informe a senha aqui.';
        }
        openCredentialDialog(failure, true);
        return;
      }
      if (state === 'server-refused') {
        if (!terminalReportedRef.current) {
          terminalReportedRef.current = true;
          recordVncState(state, 'Servidor VNC recusou a conexão');
          if (addLog)
            addLog(
              `O TightVNC de ${machine.name} recusou a conexão antes de pedir a senha (${data.message}). Após várias senhas erradas ele bloqueia este IP por alguns minutos: aguarde e use "Reconectar", ou reinicie o serviço TightVNC no PC remoto.`,
              'error',
            );
        }
        return;
      }
      if (state === 'connection-lost') {
        if (!terminalReportedRef.current) {
          terminalReportedRef.current = true;
          recordVncState(state, 'Conexão VNC perdida');
        }
        if (
          addLog &&
          shouldExplainMissingTunnel({
            everConnected: everConnectedRef.current,
            tunnel: vncTunnel,
            alreadyExplained: tunnelHintShownRef.current,
          })
        ) {
          tunnelHintShownRef.current = true;
          addLog(
            `${machine.name} não ofereceu o túnel VNC (versão antiga do OpenPortal) e a porta 5900 dele não respondeu. Atualize o OpenPortal no outro PC: com a versão nova o TightVNC dele aceita só conexões locais.`,
            'warn',
          );
        }
        if (isRetryableVncState(state)) scheduleReconnect('conexão VNC perdida');
        return;
      }
      if (state === 'disconnected' && !terminalReportedRef.current) {
        terminalReportedRef.current = true;
        recordVncState(state, 'Sessão VNC encerrada');
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    addLog,
    attemptId,
    handleReconnect,
    machine.hasVncPassword,
    machine.host,
    machine.id,
    machine.name,
    openCredentialDialog,
    postToViewer,
    recordConn,
    scheduleReconnect,
    setStatuses,
    vncGrant,
    vncTunnel,
  ]);

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
        {credentialDialog && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-4">
            <form
              className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-2xl"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCredential();
              }}
            >
              <h2 className="text-base font-semibold text-text-primary">
                {credentialDialog.error ? 'Senha VNC não aceita' : 'Senha do VNC necessária'}
              </h2>
              <p className="mt-2 text-sm text-text-secondary">
                {machine.name} ({machine.host}) pediu a senha configurada no TightVNC. Isso é
                diferente da aprovação de acesso.
              </p>
              {credentialDialog.error && (
                <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {credentialDialog.error}
                </p>
              )}
              <label
                className="mt-4 block text-xs text-text-faint"
                htmlFor={`vnc-password-${machine.id}`}
              >
                Senha do servidor VNC
              </label>
              <input
                id={`vnc-password-${machine.id}`}
                autoFocus
                type="password"
                value={credentialValue}
                onChange={(event) => setCredentialValue(event.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-inset px-3 py-2 text-sm text-text-primary font-mono outline-none focus:border-accent"
                placeholder="Digite a senha do TightVNC"
              />
              {!machine.id.startsWith('quick-') && (
                <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={saveCredential}
                    onChange={(event) => setSaveCredential(event.target.checked)}
                  />
                  Salvar com segurança para este PC cadastrado
                </label>
              )}
              {machine.id.startsWith('quick-') && (
                <p className="mt-3 text-xs text-text-faint">
                  Esta conexão por IP não salva a senha nem cria um PC cadastrado.
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelCredential}
                  className="rounded-lg border border-line px-3 py-2 text-sm text-text-secondary hover:bg-surface-2"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-strong"
                >
                  {credentialDialog.restart ? 'Tentar novamente' : 'Conectar'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
