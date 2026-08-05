import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { MachineContext } from '../App';

const btn = {
  padding: '5px 12px', borderRadius: '4px', border: '1px solid #475569',
  background: '#1e293b', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px'
};

const formatSize = (bytes) => {
  if (!bytes || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
};

const formatDate = (iso) => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
  } catch {
    return '';
  }
};

function FilePanel({ title, path, entries, selected, onSelect, onNavigate, loading, drives, onDriveChange, isLocal, specialDirs, onSpecialDir, error, isConnecting, selectable }) {
  const pathParts = path ? path.split('\\').filter(Boolean) : [];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: isLocal ? '1px solid #334155' : 'none', minWidth: 0 }}>
      {/* Title */}
      <div style={{ padding: '6px 10px', background: '#1e293b', borderBottom: '1px solid #334155', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#94a3b8' }}>
        {title}
      </div>

      {/* Drives (local only) */}
      {drives && isLocal && (
        <div style={{ display: 'flex', gap: '4px', padding: '4px 10px', background: '#0f172a', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
          {drives.map(d => (
            <button key={d} onClick={() => onDriveChange(d)} style={{
              ...btn, padding: '2px 8px', fontSize: '11px',
              background: path?.startsWith(d) ? '#3b82f6' : '#1e293b',
              border: path?.startsWith(d) ? '1px solid #3b82f6' : '1px solid #475569'
            }}>{d}</button>
          ))}
        </div>
      )}

      {/* Shortcut buttons (local only) */}
      {isLocal && specialDirs && (
        <div style={{ display: 'flex', gap: '4px', padding: '3px 10px', background: '#0f172a', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
          <button onClick={() => onSpecialDir(specialDirs.desktop)} style={{ ...btn, padding: '2px 8px', fontSize: '11px' }}>Area de Trabalho</button>
          <button onClick={() => onSpecialDir(specialDirs.downloads)} style={{ ...btn, padding: '2px 8px', fontSize: '11px' }}>Downloads</button>
          <button onClick={() => onSpecialDir(specialDirs.documents)} style={{ ...btn, padding: '2px 8px', fontSize: '11px' }}>Documentos</button>
        </div>
      )}

      {/* Breadcrumbs */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '2px', padding: '4px 10px', background: '#0f172a',
        borderBottom: '1px solid #1e293b', fontFamily: 'monospace', fontSize: '11px', color: '#94a3b8',
        flexWrap: 'wrap', minHeight: '26px'
      }}>
        {isLocal ? (
          pathParts.length === 0 ? (
            <span style={{ color: '#64748b', fontSize: '11px' }}>{path}</span>
          ) : (
            <>
              <span style={{ color: '#3b82f6', cursor: 'pointer' }} onClick={() => onNavigate(path.slice(0, path.indexOf(pathParts[0])))}>
                {path.slice(0, 3)}
              </span>
              {pathParts.map((part, i) => (
                <span key={i} style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                  <span style={{ color: '#475569' }}>\</span>
                  <span style={{ cursor: 'pointer', color: '#e2e8f0' }} onClick={() => onNavigate(path.slice(0, path.indexOf(part)) + part + '\\')}>
                    {part}
                  </span>
                </span>
              ))}
            </>
          )
        ) : (
          <>
            <span style={{ color: '#3b82f6', cursor: 'pointer' }} onClick={() => onNavigate('\\')}>Raiz</span>
            {pathParts.map((part, i) => (
              <span key={i} style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                <span style={{ color: '#475569' }}>\</span>
                <span style={{ cursor: 'pointer', color: '#e2e8f0' }} onClick={() => onNavigate('\\' + pathParts.slice(0, i + 1).join('\\'))}>
                  {part}
                </span>
              </span>
            ))}
          </>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {isConnecting && (
          <div style={{ padding: '30px 20px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
            <div style={{ fontSize: '14px', marginBottom: '6px' }}>Aguardando resposta do remote-file-server...</div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>Porta 18901 (proxy) → 5001 (file server)</div>
          </div>
        )}

        {error && !isConnecting && (
          <div style={{ padding: '30px 20px', textAlign: 'center', color: '#f87171', fontSize: '13px' }}>
            <div style={{ marginBottom: '8px' }}>{error}</div>
          </div>
        )}

        {loading && !isConnecting && (
          <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>Carregando...</div>
        )}

        {!loading && !error && !isConnecting && entries.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>Pasta vazia</div>
        )}

        {/* Header row */}
        {!loading && !error && !isConnecting && entries.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', padding: '4px 10px', gap: '8px',
            borderBottom: '1px solid #1e293b', fontSize: '11px', color: '#64748b', fontWeight: 600
          }}>
            {selectable && <span style={{ width: '22px' }}></span>}
            <span style={{ flex: 1 }}>Nome</span>
            <span style={{ width: '80px', textAlign: 'right' }}>Tamanho</span>
            <span style={{ width: '140px', textAlign: 'right' }}>Modificado</span>
          </div>
        )}

        {/* ".." parent entry */}
        {!loading && !error && !isConnecting && path && (isLocal ? pathParts.length > 0 : pathParts.length > 0) && (
          <div style={{
            display: 'flex', alignItems: 'center', padding: '4px 10px', cursor: 'pointer',
            borderBottom: '1px solid #1e293b', gap: '8px', color: '#94a3b8', fontSize: '13px'
          }} onClick={() => {
            if (isLocal) {
              const parent = path.replace(/\\$/, '').split('\\').slice(0, -1).join('\\') + '\\';
              onNavigate(parent.match(/^[A-Z]:\\$/i) ? parent : parent.replace(/\\\\/g, '\\') || 'C:\\');
            } else {
              const pp = path.split('\\').filter(Boolean);
              pp.pop();
              onNavigate(pp.length === 0 ? '\\' : '\\' + pp.join('\\'));
            }
          }}>
            {isLocal && <span style={{ width: '22px' }}></span>}
            <span style={{ width: '18px', textAlign: 'center', fontSize: '14px', opacity: 0.6 }}>..</span>
            <span style={{ flex: 1 }}>Voltar</span>
            <span style={{ width: '80px' }}></span>
            <span style={{ width: '140px' }}></span>
          </div>
        )}

        {/* File entries */}
        {!loading && !error && !isConnecting && entries.map((entry, i) => {
          const isSelected = selectable ? selected?.has(i) : false;
          return (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', padding: '4px 10px', gap: '8px',
                cursor: 'pointer', borderBottom: '1px solid #1e293b',
                background: isSelected ? '#1e3a5f' : 'transparent',
                color: entry.d ? '#e2e8f0' : '#cbd5e1'
              }}
              onClick={(e) => {
                if (!selectable) return;
                const sel = new Set(selected || []);
                if (e.ctrlKey || e.metaKey) {
                  if (sel.has(i)) sel.delete(i); else sel.add(i);
                } else {
                  sel.clear(); sel.add(i);
                }
                onSelect(sel);
              }}
              onDoubleClick={() => {
                if (entry.d) {
                  onNavigate(isLocal ? path.replace(/\\$/, '') + '\\' + entry.n : (path.endsWith('\\') ? path : path + '\\') + entry.n);
                  if (selectable) onSelect(new Set());
                }
              }}
            >
              {/* Checkbox (selectable) */}
              {selectable && (
                <span style={{ width: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {}}
                    style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                    onClick={(e) => { e.stopPropagation(); const sel = new Set(selected || []); if (sel.has(i)) sel.delete(i); else sel.add(i); onSelect(sel); }}
                  />
                </span>
              )}
              {/* Icon */}
              <span style={{ width: '18px', textAlign: 'center', fontSize: '14px', opacity: 0.7 }}>
                {entry.d ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}
              </span>
              {/* Name */}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }}>
                {entry.n}
              </span>
              {/* Size */}
              <span style={{ width: '80px', textAlign: 'right', color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap' }}>
                {entry.d ? '' : formatSize(entry.s)}
              </span>
              {/* Date */}
              <span style={{ width: '140px', textAlign: 'right', color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap' }}>
                {formatDate(entry.m)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function FileTransfer() {
  const { activeMachine, addLog } = useContext(MachineContext);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const [drives, setDrives] = useState([]);
  const [specialDirs, setSpecialDirs] = useState(null);

  // Local panel
  const [localPath, setLocalPath] = useState('');
  const [localEntries, setLocalEntries] = useState([]);
  const [localSelected, setLocalSelected] = useState(new Set());
  const [localLoading, setLocalLoading] = useState(false);

  // Remote panel
  const [remotePath, setRemotePath] = useState('\\');
  const [remoteEntries, setRemoteEntries] = useState([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState(null);
  const [remoteSelected, setRemoteSelected] = useState(new Set());

  const loadLocalDir = useCallback(async (dirPath) => {
    if (!dirPath) return;
    setLocalLoading(true);
    try {
      const items = await window.electronAPI.listLocalDir(dirPath);
      setLocalEntries(items || []);
      setLocalSelected(new Set());
      setLocalPath(dirPath);
    } catch (err) {
      addLog(`Erro ao listar local: ${err.message}`, 'error');
    }
    setLocalLoading(false);
  }, [addLog]);

  const loadRemoteDir = useCallback(async (dirPath) => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const res = await window.electronAPI.ftList(dirPath);
      if (res.s === 'ok') {
        setRemoteEntries(res.e || []);
        setRemotePath(dirPath);
        setRemoteSelected(new Set());
      } else {
        setRemoteError(res.m || 'Falha ao listar diretorio remoto');
        addLog(`Erro ao listar remoto: ${res.m}`, 'error');
      }
    } catch (err) {
      setRemoteError(err.message);
      addLog(`Erro ao listar remoto: ${err.message}`, 'error');
    }
    setRemoteLoading(false);
  }, [addLog]);

  // Contador de sequência para descartar respostas de conexões antigas
  // (protege contra race conditions do React Strict Mode e trocas de máquina)
  const connectSeq = useRef(0);

  const formatConnectError = (msg, host) => {
    const detail = (msg || '').toLowerCase();
    const isReachability = /timeout|timed ?out|econnrefused|refused|network.*unreachable|connect.*fail|closed|unable|can't connect/i.test(detail);
    const base = `Não foi possível alcançar a porta 5001 em ${host}. Verifique se o app está aberto no PC remoto e se o Firewall liberou a porta.`;
    return isReachability ? `${base} Detalhe: ${msg}` : (msg || base);
  };

  const connect = useCallback(async () => {
    const host = activeMachine && activeMachine.host;
    if (!host) return;
    const seq = ++connectSeq.current;
    setError(null);
    setConnecting(true);
    addLog(`Conectando ao servidor de arquivos remoto (${host}:5001)...`);
    try {
      const res = await window.electronAPI.ftConnect(host, 5001);
      if (seq !== connectSeq.current) return;
      if (res.success) {
        setConnected(true);
        addLog(`Conectado: ${host}`);
        setRemotePath('\\');
        setRemoteEntries([]);
        setRemoteError(null);
        loadRemoteDir('\\');
      } else {
        const msg = formatConnectError(res.error || 'Falha na conexao', host);
        setError(msg);
        setConnected(false);
        addLog(`Erro: ${msg}`, 'error');
      }
    } catch (err) {
      if (seq !== connectSeq.current) return;
      const msg = formatConnectError(err.message, host);
      setError(msg);
      setConnected(false);
      addLog(`Erro: ${msg}`, 'error');
    } finally {
      if (seq === connectSeq.current) setConnecting(false);
    }
  }, [activeMachine, addLog, loadRemoteDir]);

  // Carrega dados locais uma única vez (montagem do componente)
  useEffect(() => {
    window.electronAPI.getHomeDir().then(dir => {
      const normalized = dir.endsWith('\\') ? dir : dir + '\\';
      setLocalPath(normalized);
      loadLocalDir(normalized);
    });
    window.electronAPI.getDrives().then(setDrives);
    window.electronAPI.getSpecialDirs().then(setSpecialDirs);
  }, []);

  // Conecta à máquina ativa; limpa o estado anterior ao trocar de máquina e
  // descarta chamadas duplicadas/simultâneas de conexão (React Strict Mode)
  useEffect(() => {
    connectSeq.current++;
    setConnected(false);
    setConnecting(false);
    setError(null);
    setRemotePath('\\');
    setRemoteEntries([]);
    setRemoteError(null);
    window.electronAPI.ftDisconnect();
    if (activeMachine && activeMachine.host) {
      connect(activeMachine.host);
    }
    return () => {
      connectSeq.current++;
      window.electronAPI.ftDisconnect();
    };
  }, [activeMachine && activeMachine.host]);

  useEffect(() => {
    const unsub = window.electronAPI?.onFtProgress((data) => {
      setTransfer(data);
      if (data.done) {
        setTimeout(() => {
          setTransfer(null);
          if (data.type !== 'download' || data.error) {
            loadRemoteDir(remotePath);
          }
        }, 1500);
      }
    });
    return unsub;
  }, [remotePath, loadRemoteDir]);

  useEffect(() => {
    const unsub = window.electronAPI?.onFtStatus((status) => {
      if (!status) return;
      if (status.state === 'disconnected' || status.state === 'error') {
        setConnected(false);
        const detail = status.message ? `: ${status.message}` : '';
        addLog(`Desconectado do servidor de arquivos${detail}`, status.state === 'error' ? 'error' : 'info');
        setRemoteEntries([]);
        setRemoteSelected(new Set());
        if (status.state === 'error') {
          setError(status.message || 'Conexao perdida');
        }
      }
    });
    return unsub;
  }, [addLog]);

  const joinLocalPath = (base, name) => {
    const b = (base || '').replace(/\\+$/, '');
    return b + '\\' + name;
  };

  const handleDownloadSelected = async () => {
    if (!remoteSelected || remoteSelected.size === 0) return;
    const items = [...remoteSelected].map(i => remoteEntries[i]).filter(Boolean);
    if (items.length === 0) return;

    const fileItems = items.filter(it => !it.d);
    if (fileItems.length === 0) {
      addLog('Selecione apenas arquivos para baixar (pastas em breve)', 'warn');
      return;
    }

    let downloaded = 0;
    let failed = 0;
    const fallbackBase = localPath ? localPath.replace(/\\+$/, '') + '\\' : '';

    for (const sel of fileItems) {
      const sep = remotePath.endsWith('\\') ? '' : '\\';
      const remoteFull = remotePath + sep + sel.n;

      const defaultPath = fallbackBase ? joinLocalPath(localPath, sel.n) : sel.n;
      const dlg = await window.electronAPI.showSaveDialog({
        title: 'Salvar como',
        defaultPath,
        filters: []
      });
      if (!dlg || dlg.canceled || !dlg.filePath) {
        addLog(`Download cancelado: ${sel.n}`);
        return;
      }

      addLog(`Baixando: ${sel.n}...`);
      try {
        const res = await window.electronAPI.ftDownload(remoteFull, { savePath: dlg.filePath });
        if (res && res.s === 'ok') {
          addLog(`Arquivo baixado: ${sel.n} (${formatSize(res.size || sel.s)}) -> ${dlg.filePath}`);
          downloaded++;
        } else {
          addLog(`Falha ao baixar ${sel.n}: ${(res && res.m) || 'erro'}`, 'error');
          failed++;
        }
      } catch (err) {
        addLog(`Erro ao baixar ${sel.n}: ${err.message}`, 'error');
        failed++;
      }
    }

    if (downloaded > 0 && localPath) {
      loadLocalDir(localPath);
    }
    setRemoteSelected(new Set());
  };

  const handleUploadSelected = async () => {
    if (!localSelected || localSelected.size === 0) return;

    const items = [...localSelected].map(i => localEntries[i]).filter(Boolean);
    if (items.length === 0) return;

    const sep = remotePath.endsWith('\\') ? '' : '\\';
    let uploaded = 0;
    let failed = 0;

    for (const sel of items) {
      const localFull = localPath.replace(/\\$/, '') + '\\' + sel.n;
      const remoteDest = remotePath + sep + sel.n;

      try {
        if (sel.d) {
          addLog(`Enviando pasta: ${sel.n}...`);
          const res = await window.electronAPI.ftUploadFolder(localFull, remoteDest);
          if (res.s === 'ok') {
            addLog(`Pasta enviada: ${sel.n} (${res.totalFiles || 0} arquivos)`);
            uploaded++;
          } else {
            addLog(`Falha ao enviar pasta ${sel.n}: ${res.m || 'erro'}`, 'error');
            failed++;
          }
        } else {
          addLog(`Enviando arquivo: ${sel.n}...`);
          const res = await window.electronAPI.ftUpload(remoteDest, { filePath: localFull });
          if (res.s === 'ok' || res.s === 'ready') {
            addLog(`Arquivo enviado: ${sel.n} (${formatSize(sel.s)})`);
            uploaded++;
          } else {
            addLog(`Falha ao enviar ${sel.n}: ${res.m || 'erro'}`, 'error');
            failed++;
          }
        }
      } catch (err) {
        addLog(`Erro ao enviar ${sel.n}: ${err.message}`, 'error');
        failed++;
      }
    }

    if (uploaded > 0) loadRemoteDir(remotePath);
    setLocalSelected(new Set());
  };

  if (!activeMachine || !activeMachine.host) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', color: '#64748b', fontSize: '14px' }}>
        Selecione um PC na sidebar
      </div>
    );
  }

  const canSend = connected && localSelected && localSelected.size > 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#0f172a', color: '#e2e8f0', fontSize: '13px', overflow: 'hidden' }}>
      {/* Progress bar */}
      {transfer && transfer.type && (
        <div style={{ borderBottom: '1px solid #1e293b' }}>
          <div style={{ padding: '3px 12px', fontSize: '11px', color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
            <span>{transfer.fileName || transfer.path?.split('\\').pop() || ''}</span>
            <span>{transfer.percent || 0}%</span>
          </div>
          <div style={{ height: '3px', background: '#1e293b', margin: '0 12px 4px', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ height: '100%', background: '#3b82f6', width: `${transfer.percent || 0}%`, borderRadius: '2px', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      {/* Connection error banner */}
      {error && (
        <div style={{ padding: '6px 12px', background: '#450a0a', color: '#f87171', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button style={btn} onClick={connect}>Tentar novamente</button>
        </div>
      )}

      {/* Two-panel layout */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <FilePanel
          title="Este Computador (Local)"
          path={localPath}
          entries={localEntries}
          selected={localSelected}
          onSelect={setLocalSelected}
          onNavigate={loadLocalDir}
          loading={localLoading}
          drives={drives}
          onDriveChange={(d) => loadLocalDir(d)}
          isLocal
          specialDirs={specialDirs}
          onSpecialDir={loadLocalDir}
        />

        {/* Center action bar */}
        <div style={{
          width: '80px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: '#1e293b', gap: '12px', borderLeft: '1px solid #334155', borderRight: '1px solid #334155'
        }}>
          <button
            onClick={handleUploadSelected}
            disabled={!canSend}
            title="Enviar selecionados para o remoto"
            style={{
              ...btn, padding: '10px 12px', fontSize: '14px', fontWeight: 600,
              background: canSend ? '#2563eb' : '#1e293b',
              borderColor: canSend ? '#3b82f6' : '#475569', color: canSend ? '#fff' : '#64748b',
              cursor: canSend ? 'pointer' : 'default', opacity: canSend ? 1 : 0.4,
              writingMode: 'vertical-lr', textOrientation: 'mixed', letterSpacing: '2px'
            }}
          >Enviar para Remoto</button>
          {localSelected?.size > 0 && (
            <span style={{ fontSize: '10px', color: '#94a3b8', textAlign: 'center' }}>
              {localSelected.size} item(ns)
            </span>
          )}
          <button
            onClick={handleDownloadSelected}
            disabled={!connected || !remoteSelected || remoteSelected.size === 0}
            title="Baixar arquivos selecionados do remoto"
            style={{
              ...btn, padding: '10px 12px', fontSize: '14px', fontWeight: 600,
              background: (connected && remoteSelected && remoteSelected.size > 0) ? '#10b981' : '#1e293b',
              borderColor: (connected && remoteSelected && remoteSelected.size > 0) ? '#10b981' : '#475569',
              color: (connected && remoteSelected && remoteSelected.size > 0) ? '#fff' : '#64748b',
              cursor: (connected && remoteSelected && remoteSelected.size > 0) ? 'pointer' : 'default',
              opacity: (connected && remoteSelected && remoteSelected.size > 0) ? 1 : 0.4,
              writingMode: 'vertical-lr', textOrientation: 'mixed', letterSpacing: '2px'
            }}
          >Baixar do Remoto</button>
          {remoteSelected?.size > 0 && (
            <span style={{ fontSize: '10px', color: '#94a3b8', textAlign: 'center' }}>
              {remoteSelected.size} item(ns)
            </span>
          )}
        </div>

        <FilePanel
          title="Computador Remoto"
          path={remotePath}
          entries={remoteEntries}
          selected={remoteSelected}
          onSelect={setRemoteSelected}
          onNavigate={loadRemoteDir}
          loading={remoteLoading}
          isLocal={false}
          error={remoteError}
          isConnecting={connecting}
          selectable
        />
      </div>

      {/* Status bar */}
      <div style={{ padding: '3px 10px', background: '#1e293b', borderTop: '1px solid #334155', fontSize: '11px', color: '#64748b', display: 'flex', gap: '16px' }}>
        <span style={{ color: connected ? '#22c55e' : '#f87171' }}>{connected ? 'Conectado' : 'Desconectado'}</span>
        {localSelected?.size > 0 && <span>{localSelected.size} selecionado(s)</span>}
        {remoteSelected?.size > 0 && <span>{remoteSelected.size} remoto(s)</span>}
        {transfer?.percent != null && (
          <span>{transfer.type === 'download' ? `Baixando... ${transfer.percent}%` : `Enviando... ${transfer.percent}%`}</span>
        )}
      </div>
    </div>
  );
}
