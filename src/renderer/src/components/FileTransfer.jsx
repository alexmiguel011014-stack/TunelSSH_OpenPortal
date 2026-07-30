import { useState, useEffect, useCallback, useContext } from 'react';
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

function FilePanel({ title, path, entries, selected, onSelect, onNavigate, loading, drives, onDriveChange, isLocal, specialDirs, onSpecialDir, error, isConnecting }) {
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
            {isLocal && <span style={{ width: '22px' }}></span>}
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
          const isSelected = isLocal ? selected?.has(i) : false;
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
                if (isLocal) {
                  const sel = new Set(selected || []);
                  if (e.ctrlKey || e.metaKey) {
                    if (sel.has(i)) sel.delete(i); else sel.add(i);
                  } else {
                    sel.clear(); sel.add(i);
                  }
                  onSelect(sel);
                }
              }}
              onDoubleClick={() => {
                if (entry.d) {
                  onNavigate(isLocal ? path.replace(/\\$/, '') + '\\' + entry.n : (path.endsWith('\\') ? path : path + '\\') + entry.n);
                  if (isLocal) onSelect(new Set());
                }
              }}
            >
              {/* Checkbox (local only) */}
              {isLocal && (
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

  const connect = useCallback(async () => {
    if (!activeMachine || !activeMachine.host) return;
    setError(null);
    setConnecting(true);
    addLog('Conectando ao servidor de arquivos remoto...');
    try {
      const res = await window.electronAPI.ftConnect(activeMachine.host, 5001);
      if (res.success) {
        setConnected(true);
        addLog(`Conectado: ${activeMachine.host}`);
        loadRemoteDir('\\');
      } else {
        const msg = res.error || 'Falha na conexao';
        setError(msg);
        addLog(`Erro: ${msg}`, 'error');
      }
    } catch (err) {
      setError(err.message);
      addLog(`Erro: ${err.message}`, 'error');
    }
    setConnecting(false);
  }, [activeMachine, addLog, loadRemoteDir]);

  useEffect(() => {
    window.electronAPI.getHomeDir().then(dir => {
      const normalized = dir.endsWith('\\') ? dir : dir + '\\';
      setLocalPath(normalized);
      loadLocalDir(normalized);
    });
    window.electronAPI.getDrives().then(setDrives);
    window.electronAPI.getSpecialDirs().then(setSpecialDirs);
    connect();
    return () => { window.electronAPI.ftDisconnect(); };
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI?.onFtProgress((data) => {
      setTransfer(data);
      if (data.done) {
        setTimeout(() => {
          setTransfer(null);
          loadRemoteDir(remotePath);
        }, 1500);
      }
    });
    return unsub;
  }, [remotePath, loadRemoteDir]);

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
        </div>

        <FilePanel
          title="Computador Remoto"
          path={remotePath}
          entries={remoteEntries}
          onNavigate={loadRemoteDir}
          loading={remoteLoading}
          isLocal={false}
          error={remoteError}
          isConnecting={connecting}
        />
      </div>

      {/* Status bar */}
      <div style={{ padding: '3px 10px', background: '#1e293b', borderTop: '1px solid #334155', fontSize: '11px', color: '#64748b', display: 'flex', gap: '16px' }}>
        <span style={{ color: connected ? '#22c55e' : '#f87171' }}>{connected ? 'Conectado' : 'Desconectado'}</span>
        {localSelected?.size > 0 && <span>{localSelected.size} selecionado(s)</span>}
        {transfer?.percent != null && <span>Enviando... {transfer.percent}%</span>}
      </div>
    </div>
  );
}
