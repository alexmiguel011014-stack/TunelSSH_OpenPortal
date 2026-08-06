import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { MachineContext } from '../../App';
import FilePanel from './FilePanel';
import { joinVirtual, parentOf, virtualCrumbs, isRoot, formatSize } from './lib/paths';

const FILE_PORT = 5001;
const REMOTE_ROOT = { name: 'Raiz', path: '/' };

const btn = {
  padding: '5px 12px', borderRadius: '5px', border: '1px solid #475569',
  background: '#1e293b', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px',
};

const emptyPane = (path) => ({
  path,
  crumbs: [],
  root: null,
  parent: null,
  entries: [],
  loading: false,
  error: null,
});

// Mensagem de falha de conexão. Erros de alcance (timeout, recusa, rota) viram
// a orientação de firewall/agente; erros de protocolo aparecem como vieram.
function describeConnectError(message, host, port) {
  const detail = String(message || '').trim();
  const base = `Agente remoto inacessível em ${host}:${port}. `
    + `Verifique se o OpenPortal está aberto no PC remoto e se o firewall liberou a porta ${port}.`;
  const unreachable = !detail
    || /timeout|timed ?out|econnrefused|refused|ehostunreach|enetunreach|unreachable|closed|not connected|sem conex|connect/i.test(detail);
  if (!unreachable) return detail;
  return detail ? `${base}\n\nDetalhe técnico: ${detail}` : base;
}

export default function FileTransfer() {
  const { activeMachine, addLog } = useContext(MachineContext);
  const host = (activeMachine && activeMachine.host) || '';

  const [session, setSession] = useState(null);
  const [connState, setConnState] = useState('idle'); // idle | connecting | connected | error
  const [connError, setConnError] = useState(null);

  const [local, setLocal] = useState(() => emptyPane(''));
  const [remote, setRemote] = useState(() => emptyPane('/'));
  const [localSel, setLocalSel] = useState(() => new Set());
  const [remoteSel, setRemoteSel] = useState(() => new Set());

  const [roots, setRoots] = useState([]);
  const [quick, setQuick] = useState([]);
  const [remoteQuick, setRemoteQuick] = useState([]);

  const [transfer, setTransfer] = useState(null);
  const [busy, setBusy] = useState(false);

  // Refs evitam reinscrever listeners de IPC a cada navegação.
  const sessionRef = useRef(null);
  const connectSeq = useRef(0);
  const localPathRef = useRef('');
  const remotePathRef = useRef('/');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // --- Painel local ---------------------------------------------------------

  const loadLocal = useCallback(async (dirPath) => {
    setLocal(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.electronAPI.listLocalDir(dirPath);
      if (!mounted.current) return;
      const crumbs = res.crumbs || [];
      const next = {
        path: res.path || dirPath,
        root: crumbs[0] || null,
        crumbs: crumbs.slice(1),
        parent: res.parent || null,
        entries: res.entries || [],
        loading: false,
        error: res.ok ? null : (res.error || 'Não foi possível abrir esta pasta'),
      };
      localPathRef.current = next.path;
      setLocal(next);
      setLocalSel(new Set());
      if (!res.ok) addLog(`Local: ${next.error} (${dirPath})`, 'error');
    } catch (err) {
      if (!mounted.current) return;
      setLocal(prev => ({ ...prev, loading: false, error: err.message }));
      addLog(`Erro ao listar pasta local: ${err.message}`, 'error');
    }
  }, [addLog]);

  useEffect(() => {
    // Raiz inicial vem de os.homedir() no main — nada de "C:\" fixo.
    window.electronAPI.getHomeDir().then((home) => {
      if (mounted.current) loadLocal(home);
    });
    window.electronAPI.getRoots().then((r) => { if (mounted.current) setRoots(r || []); });
    window.electronAPI.getQuickAccess().then((q) => { if (mounted.current) setQuick(q || []); });
  }, [loadLocal]);

  // --- Painel remoto --------------------------------------------------------

  const loadRemote = useCallback(async (virtualPath) => {
    const target = virtualPath || '/';
    setRemote(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.electronAPI.ftList(target);
      if (!mounted.current) return;
      if (res.s === 'ok') {
        remotePathRef.current = target;
        setRemote({
          path: target,
          root: REMOTE_ROOT,
          crumbs: virtualCrumbs(target),
          parent: isRoot(target) ? null : parentOf(target),
          entries: res.e || [],
          loading: false,
          error: null,
        });
        setRemoteSel(new Set());
      } else {
        setRemote(prev => ({ ...prev, loading: false, error: res.m || 'Falha ao listar a pasta remota' }));
        addLog(`Remoto: ${res.m}`, 'error');
      }
    } catch (err) {
      if (!mounted.current) return;
      setRemote(prev => ({ ...prev, loading: false, error: err.message }));
      addLog(`Erro ao listar pasta remota: ${err.message}`, 'error');
    }
  }, [addLog]);

  // --- Conexão --------------------------------------------------------------
  //
  // A dupla montagem do React StrictMode dispara este efeito duas vezes. Isso é
  // inofensivo aqui por dois motivos:
  //   1. `ft:connect` é idempotente no main: o segundo pedido para o mesmo
  //      host:porta reaproveita a MESMA sessão em vez de derrubar o socket;
  //   2. `connectSeq` descarta a resposta da montagem cancelada.
  // O efeito também nunca desconecta na saída — a sessão de arquivos é
  // independente do VNC e sobrevive a alternar entre as abas.
  const connect = useCallback(async (opts) => {
    if (!host) return;
    const seq = ++connectSeq.current;
    setConnState('connecting');
    setConnError(null);
    addLog(`Conectando ao agente de arquivos (${host}:${FILE_PORT})...`);
    try {
      const res = await window.electronAPI.ftConnect(host, FILE_PORT, opts);
      if (!mounted.current || seq !== connectSeq.current) return;
      if (res && res.success) {
        sessionRef.current = { id: res.sessionId, host };
        setSession({ id: res.sessionId, host, info: res.info || null });
        setConnState('connected');
        setConnError(null);

        const info = res.info || {};
        const quickDirs = info.quick || {};
        const labels = { desktop: 'Área de Trabalho', downloads: 'Downloads', documents: 'Documentos' };
        setRemoteQuick([
          { id: 'root', label: 'Início', path: '/' },
          ...Object.keys(labels)
            .filter(k => quickDirs[k])
            .map(k => ({ id: k, label: labels[k], path: quickDirs[k] })),
        ]);

        addLog(`Conectado ao agente de arquivos em ${host} (${info.platform || 'plataforma desconhecida'})`);
        loadRemote('/');
      } else {
        const msg = describeConnectError(res && res.error, host, FILE_PORT);
        sessionRef.current = null;
        setSession(null);
        setConnState('error');
        setConnError(msg);
        setRemote(emptyPane('/'));
        addLog(`Falha ao conectar ao agente de arquivos: ${(res && res.error) || 'erro desconhecido'}`, 'error');
      }
    } catch (err) {
      if (!mounted.current || seq !== connectSeq.current) return;
      const msg = describeConnectError(err.message, host, FILE_PORT);
      sessionRef.current = null;
      setSession(null);
      setConnState('error');
      setConnError(msg);
      addLog(`Falha ao conectar ao agente de arquivos: ${err.message}`, 'error');
    }
  }, [host, addLog, loadRemote]);

  useEffect(() => {
    if (!host) {
      connectSeq.current++;
      sessionRef.current = null;
      setSession(null);
      setConnState('idle');
      setConnError(null);
      setRemote(emptyPane('/'));
      setRemoteQuick([]);
      return;
    }
    connect();
  }, [host, connect]);

  // Status vindo do main. Só reage a eventos da NOSSA sessão: um aviso atrasado
  // de uma conexão antiga (troca de máquina, remonte do StrictMode) não pode
  // marcar a UI como desconectada.
  useEffect(() => {
    const unsub = window.electronAPI.onFtStatus((status) => {
      if (!status || !mounted.current) return;
      const mine = sessionRef.current;
      if (!mine || !status.sessionId || status.sessionId !== mine.id) return;
      if (status.state === 'connected') return;
      if (status.state === 'disconnected' || status.state === 'error') {
        sessionRef.current = null;
        setSession(null);
        setConnState('error');
        setConnError(describeConnectError(status.message, mine.host, FILE_PORT));
        setRemote(emptyPane('/'));
        setRemoteSel(new Set());
        addLog(`Conexão com o agente de arquivos encerrada${status.message ? `: ${status.message}` : ''}`,
          status.state === 'error' ? 'error' : 'info');
      }
    });
    return unsub;
  }, [addLog]);

  // Progresso das transferências (eventos de streaming já existentes).
  useEffect(() => {
    const unsub = window.electronAPI.onFtProgress((data) => {
      if (!data || !mounted.current) return;
      setTransfer(prev => ({ ...(prev || {}), ...data }));
    });
    return unsub;
  }, []);

  // --- Transferências -------------------------------------------------------

  const runTransfer = useCallback(async (label, direction, fn) => {
    setBusy(true);
    setTransfer({ label, type: direction, percent: 0 });
    try {
      await fn();
    } catch (err) {
      addLog(`Erro na transferência: ${err.message}`, 'error');
    } finally {
      if (mounted.current) {
        setBusy(false);
        setTransfer(null);
      }
    }
  }, [addLog]);

  const selectedLocal = local.entries.filter(e => localSel.has(e.n));
  const selectedRemote = remote.entries.filter(e => remoteSel.has(e.n));

  const uploadItems = useCallback(async (items) => {
    const dest = remotePathRef.current;
    let ok = 0;
    let fail = 0;
    for (const item of items) {
      const target = joinVirtual(dest, item.n);
      setTransfer(prev => ({ ...(prev || {}), fileName: item.n }));
      try {
        const res = item.d
          ? await window.electronAPI.ftUploadFolder(item.p, target)
          : await window.electronAPI.ftUpload(target, { filePath: item.p });
        if (res.s === 'ok' || res.s === 'partial') {
          ok++;
          const extra = item.d ? ` (${res.totalFiles || 0} arquivo(s))` : ` (${formatSize(item.s)})`;
          addLog(`Enviado: ${item.n}${extra}${res.s === 'partial' ? ' — com falhas' : ''}`);
        } else {
          fail++;
          addLog(`Falha ao enviar ${item.n}: ${res.m || 'erro'}`, 'error');
        }
      } catch (err) {
        fail++;
        addLog(`Erro ao enviar ${item.n}: ${err.message}`, 'error');
      }
    }
    if (ok > 0) await loadRemote(dest);
    if (mounted.current) setLocalSel(new Set());
    addLog(`Envio concluído: ${ok} item(ns) enviado(s)${fail ? `, ${fail} com falha` : ''}`, fail ? 'warn' : 'info');
  }, [addLog, loadRemote]);

  const handleUpload = () => {
    if (!selectedLocal.length) return;
    const items = selectedLocal;
    runTransfer(`Enviando ${items.length} item(ns)`, 'upload', () => uploadItems(items));
  };

  // Fluxo alternativo: escolher arquivos/pastas em qualquer lugar do sistema
  // pelo seletor nativo, com destino na pasta remota aberta.
  const handleBrowseUpload = async () => {
    const dlg = await window.electronAPI.showOpenDialog({
      title: 'Selecionar arquivos ou pastas para enviar',
      properties: ['openFile', 'openDirectory', 'multiSelections', 'dontAddToRecent'],
    });
    if (!dlg || dlg.canceled || !dlg.filePaths || !dlg.filePaths.length) return;

    const items = [];
    for (const filePath of dlg.filePaths) {
      // O nome vem do main (path.basename): nada de fatiar caminho na UI.
      const stat = await window.electronAPI.statLocal(filePath);
      if (!stat || !stat.ok) {
        addLog(`Ignorado (não foi possível ler): ${filePath}`, 'warn');
        continue;
      }
      items.push({ n: stat.n, p: stat.p, d: !!stat.d, s: stat.s || 0 });
    }
    if (!items.length) return;
    runTransfer(`Enviando ${items.length} item(ns)`, 'upload', () => uploadItems(items));
  };

  const downloadItems = useCallback(async (items, destDir) => {
    // Pasta de origem fixada no início do lote: navegar no painel remoto
    // durante a transferência não pode redirecionar os itens restantes.
    const base = remotePathRef.current;
    let ok = 0;
    let fail = 0;
    for (const item of items) {
      const source = joinVirtual(base, item.n);
      setTransfer(prev => ({ ...(prev || {}), fileName: item.n }));
      try {
        const res = item.d
          ? await window.electronAPI.ftDownloadFolder(source, destDir, { folderName: item.n })
          // saveDir + saveName: a junção do caminho acontece no main process.
          : await window.electronAPI.ftDownload(source, { saveDir: destDir, saveName: item.n, resume: true });
        if (res.s === 'ok' || res.s === 'partial') {
          ok++;
          const extra = item.d ? ` (${res.totalFiles || 0} arquivo(s))` : ` (${formatSize(res.size || item.s)})`;
          addLog(`Recebido: ${item.n}${extra}${res.s === 'partial' ? ' — com falhas' : ''}`);
        } else {
          fail++;
          addLog(`Falha ao receber ${item.n}: ${res.m || 'erro'}`, 'error');
        }
      } catch (err) {
        fail++;
        addLog(`Erro ao receber ${item.n}: ${err.message}`, 'error');
      }
    }
    if (ok > 0 && destDir === localPathRef.current) await loadLocal(destDir);
    if (mounted.current) setRemoteSel(new Set());
    addLog(`Recebimento concluído: ${ok} item(ns) em ${destDir}${fail ? `, ${fail} com falha` : ''}`, fail ? 'warn' : 'info');
  }, [addLog, loadLocal]);

  const handleDownload = () => {
    if (!selectedRemote.length || !local.path) return;
    const items = selectedRemote;
    const dest = local.path;
    runTransfer(`Recebendo ${items.length} item(ns)`, 'download', () => downloadItems(items, dest));
  };

  const handleBrowseDownload = async () => {
    if (!selectedRemote.length) return;
    const dlg = await window.electronAPI.showOpenDialog({
      title: 'Escolher a pasta de destino no seu computador',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: local.path || undefined,
    });
    if (!dlg || dlg.canceled || !dlg.filePaths || !dlg.filePaths.length) return;
    const items = selectedRemote;
    const dest = dlg.filePaths[0];
    runTransfer(`Recebendo ${items.length} item(ns)`, 'download', () => downloadItems(items, dest));
  };

  // --- Render ---------------------------------------------------------------

  if (!host) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', color: '#64748b', fontSize: '14px' }}>
        Selecione um PC na barra lateral para transferir arquivos
      </div>
    );
  }

  const connected = connState === 'connected';
  const canUpload = connected && !busy && selectedLocal.length > 0 && !remote.error;
  const canDownload = connected && !busy && selectedRemote.length > 0 && !!local.path;

  const remotePaneState = connState === 'connecting'
    ? { ...remote, loading: true, error: null }
    : connState === 'connected'
      ? remote
      : { ...emptyPane('/'), error: connError || 'Sem conexão com o agente remoto' };

  const actionBtn = (enabled, background) => ({
    ...btn,
    width: '100%',
    padding: '9px 10px',
    fontSize: '13px',
    fontWeight: 600,
    background: enabled ? background : '#1e293b',
    borderColor: enabled ? background : '#475569',
    color: enabled ? '#fff' : '#64748b',
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.45,
  });

  const linkBtn = (enabled) => ({
    background: 'none',
    border: 'none',
    color: enabled ? '#60a5fa' : '#475569',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '10px',
    padding: '2px',
    textDecoration: 'underline',
  });

  const percent = Math.max(0, Math.min(100, transfer?.percent || 0));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#0f172a', color: '#e2e8f0', fontSize: '13px', overflow: 'hidden' }}>
      {/* Erro de conexão */}
      {connState === 'error' && connError && (
        <div style={{ padding: '8px 12px', background: '#450a0a', borderBottom: '1px solid #7f1d1d', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
          <span style={{ fontSize: '14px', lineHeight: 1.4 }}>⚠️</span>
          <span style={{ flex: 1, color: '#fca5a5', fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-line' }}>{connError}</span>
          <button type="button" style={{ ...btn, flexShrink: 0 }} onClick={() => connect({ force: true })}>
            Tentar novamente
          </button>
        </div>
      )}

      {/* Progresso */}
      {transfer && (
        <div style={{ padding: '6px 12px', background: '#1e293b', borderBottom: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
            <span style={{ fontWeight: 600, color: transfer.type === 'download' ? '#10b981' : '#3b82f6' }}>
              {transfer.type === 'download' ? '⬇ Recebendo' : '⬆ Enviando'}
              {transfer.fileName ? ` — ${transfer.fileName}` : ''}
            </span>
            <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{percent}%</span>
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
            {transfer.label || ''}
            {typeof transfer.total === 'number' && transfer.total > 0 && (
              <> — {formatSize(transfer.type === 'download' ? transfer.received : transfer.sent)} / {formatSize(transfer.total)}</>
            )}
          </div>
          <div style={{ height: '4px', background: '#0f172a', marginTop: '5px', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: '2px', transition: 'width 0.2s',
              background: transfer.type === 'download' ? '#10b981' : '#3b82f6',
              width: `${percent}%`,
            }} />
          </div>
        </div>
      )}

      {/* Painéis */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <FilePanel
          title="Este Computador"
          subtitle={local.path}
          accent="#38bdf8"
          state={local}
          roots={roots}
          shortcuts={quick}
          selection={localSel}
          onSelectionChange={setLocalSel}
          onNavigate={(target) => loadLocal(target)}
          onRefresh={() => loadLocal(local.path)}
          busy={busy}
        />

        {/* Barra de ações central */}
        <div style={{
          width: '150px', flexShrink: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '18px', padding: '10px',
          background: '#1e293b', borderLeft: '1px solid #334155', borderRight: '1px solid #334155',
        }}>
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
            <button
              type="button"
              onClick={handleUpload}
              disabled={!canUpload}
              style={actionBtn(canUpload, '#2563eb')}
              title={canUpload
                ? `Enviar ${selectedLocal.length} item(ns) para ${remote.path}`
                : 'Selecione itens no painel local e abra a pasta de destino no remoto'}
            >Enviar →</button>
            <span style={{ fontSize: '10px', color: '#64748b', textAlign: 'center', lineHeight: 1.4 }}>
              {selectedLocal.length > 0
                ? `${selectedLocal.length} selecionado(s) → ${remote.path}`
                : 'Selecione no painel esquerdo'}
            </span>
            <button type="button" onClick={handleBrowseUpload} disabled={!connected || busy} style={linkBtn(connected && !busy)}>
              escolher no sistema...
            </button>
          </div>

          <div style={{ width: '100%', height: '1px', background: '#334155' }} />

          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
            <button
              type="button"
              onClick={handleDownload}
              disabled={!canDownload}
              style={actionBtn(canDownload, '#059669')}
              title={canDownload
                ? `Receber ${selectedRemote.length} item(ns) em ${local.path}`
                : 'Selecione itens no painel remoto'}
            >← Receber</button>
            <span style={{ fontSize: '10px', color: '#64748b', textAlign: 'center', lineHeight: 1.4 }}>
              {selectedRemote.length > 0
                ? `${selectedRemote.length} selecionado(s) → esta pasta`
                : 'Selecione no painel direito'}
            </span>
            <button type="button" onClick={handleBrowseDownload} disabled={!canDownload} style={linkBtn(canDownload)}>
              salvar em outra pasta...
            </button>
          </div>
        </div>

        <FilePanel
          title="PC Remoto"
          subtitle={connected ? host : `${host}:${FILE_PORT}`}
          accent={connected ? '#22c55e' : '#ef4444'}
          state={remotePaneState}
          shortcuts={connected ? remoteQuick : []}
          selection={remoteSel}
          onSelectionChange={setRemoteSel}
          onNavigate={(target, entry) => {
            // No remoto o painel devolve o nome da entrada; o caminho virtual é
            // montado aqui, sempre com "/", independente do SO das duas pontas.
            if (entry) loadRemote(joinVirtual(remotePathRef.current, entry.n));
            else loadRemote(target);
          }}
          onRefresh={() => loadRemote(remote.path)}
          busy={busy}
          emptyHint={connState === 'error' ? `Porta ${FILE_PORT} via túnel 18901 (proxy WebSocket → TCP)` : null}
          statusSlot={
            <span style={{
              fontSize: '10px', padding: '1px 7px', borderRadius: '9px', whiteSpace: 'nowrap',
              background: connected ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
              color: connected ? '#4ade80' : '#f87171',
              border: `1px solid ${connected ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`,
            }}>
              {connState === 'connecting' ? 'conectando...' : connected ? 'conectado' : 'offline'}
            </span>
          }
        />
      </div>

      {/* Barra de status */}
      <div style={{
        padding: '3px 12px', background: '#1e293b', borderTop: '1px solid #334155',
        fontSize: '11px', color: '#64748b', display: 'flex', gap: '16px', alignItems: 'center',
      }}>
        <span style={{ color: connected ? '#22c55e' : '#f87171' }}>
          {connected ? `Conectado — ${host}:${FILE_PORT}` : connState === 'connecting' ? 'Conectando...' : 'Desconectado'}
        </span>
        {session?.info?.platform && session.info.platform !== 'unknown' && (
          <span>Agente: {session.info.platform}{session.info.root ? ` (${session.info.root})` : ''}</span>
        )}
        <span style={{ flex: 1 }} />
        {busy && <span style={{ color: '#60a5fa' }}>transferência em andamento...</span>}
      </div>
    </div>
  );
}
