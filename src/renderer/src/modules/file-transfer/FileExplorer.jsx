import { useState, useEffect, useRef, useMemo, useContext } from 'react';
import { MachineContext } from '../../App';
import { localAdapter, makeRemoteAdapter } from './file-explorer/adapters';
import { usePane } from './file-explorer/usePane';
import { PaneView, RemotePlaceholder } from './file-explorer/PaneView';
import { Splitter, TransferRail, StatusBar } from './file-explorer/TransferControls';

// Explorador de arquivos dual-pane (PC local ↔ PC remoto via túnel), com
// aparência de Windows 11 Explorer independente do tema escuro/claro do
// resto do app — é uma janela "de sistema" dentro do app.
//
// Dividido em src/renderer/src/modules/file-transfer/file-explorer/:
//   utils.js             formatação e path helpers puros
//   adapters.js           interface comum fs local vs túnel remoto
//   usePane.js             estado/navegação de um painel (local ou remoto)
//   Toolbar.jsx             botões, breadcrumb, sidebar de atalhos
//   EntryList.jsx           lista/grade de arquivos + renomear inline
//   PaneView.jsx            um painel completo (toolbar + lista + comandos)
//   TransferControls.jsx    splitter, rail de enviar/receber, barra de progresso
// Este arquivo só orquestra: os dois painéis, drag & drop entre eles, e o
// batch de transferência — nada de UI de baixo nível mora aqui.

export default function FileExplorer() {
  const local = usePane(localAdapter, null);

  // A aprovação e a sessão de arquivos já foram estabelecidas no momento em
  // que o usuário conectou ao PC (ver connectMachine em App.jsx) — aqui só
  // lemos o sessionId pronto. Nenhum IP, nenhum "aguardando aprovação".
  const machineCtx = useContext(MachineContext);
  const activeMachine = machineCtx?.activeMachine || null;
  const sessionId = machineCtx?.ftSessionId || null;

  const remoteAdapter = useMemo(
    () => (sessionId ? makeRemoteAdapter(sessionId) : null),
    [sessionId],
  );
  const remote = usePane(remoteAdapter, '/');

  const [batch, setBatch] = useState(null);
  const batchIdRef = useRef(0);
  const [transferring, setTransferring] = useState(false);
  const [leftWidthPct, setLeftWidthPct] = useState(50);
  const splitContainerRef = useRef(null);

  useEffect(() => {
    const unsub = window.electronAPI?.onFtProgress?.((p) => {
      if (p.batchId === batchIdRef.current) setBatch(p);
    });
    return unsub;
  }, []);

  const handleDisconnect = () => machineCtx?.disconnectMachine?.();

  // kind: 'upload' (local→remoto) ou 'download' (remoto→local). Aceita
  // caminhos/destino explícitos (usado pelo drag&drop soltando numa
  // subpasta) ou cai na seleção atual + pasta aberta (botões da rail).
  const runBatch = async (kind, override) => {
    if (!sessionId || transferring) return;
    const batchId = ++batchIdRef.current;
    setTransferring(true);
    setBatch({
      batchId,
      phase: kind === 'upload' ? 'upload' : 'download',
      batchSent: 0,
      batchTotal: 0,
      elapsedMs: 0,
      speedBps: 0,
    });
    try {
      if (kind === 'upload') {
        const localPaths =
          override?.paths ||
          [...local.selected]
            .map((name) => local.entries.find((e) => e.name === name)?.path)
            .filter(Boolean);
        if (localPaths.length === 0) return;
        await window.electronAPI.ftUploadBatch(sessionId, {
          localPaths,
          destDir: override?.destDir || remote.path,
          batchId,
        });
        await remote.refresh();
      } else {
        const remotePaths =
          override?.paths ||
          [...remote.selected]
            .map((name) => remote.entries.find((e) => e.name === name)?.path)
            .filter(Boolean);
        if (remotePaths.length === 0) return;
        await window.electronAPI.ftDownloadBatch(sessionId, {
          remotePaths,
          destDir: override?.destDir || local.path,
          batchId,
        });
        await local.refresh();
      }
    } finally {
      setTransferring(false);
    }
  };

  // ---- Drag & drop ---------------------------------------------------
  // dragPayloadRef guarda a origem de um arraste iniciado DENTRO do app
  // (linha/ícone de um dos painéis). dataTransfer não é usado para o
  // payload em si (evita serializar/desserializar), só como sinalizador
  // de que existe um drag em andamento.
  const dragPayloadRef = useRef(null);

  const makeDnd = (side) => ({
    effectFor: (e) =>
      e.dataTransfer.types.includes('Files') || dragPayloadRef.current ? 'copy' : 'none',

    onEntryDragStart: (e, entry) => {
      const pane = side === 'local' ? local : remote;
      const names = pane.selected.has(entry.name) ? [...pane.selected] : [entry.name];
      const paths = names.map((n) => pane.entries.find((x) => x.name === n)?.path).filter(Boolean);
      dragPayloadRef.current = { side, paths };
      e.dataTransfer.effectAllowed = 'copy';
      try {
        e.dataTransfer.setData('text/plain', names.join(', '));
      } catch {}
    },

    onDropOnFolder: (e, folderEntry) => handleDrop(e, side, folderEntry.path),
    onDropOnCurrentDir: (e) => handleDrop(e, side, side === 'local' ? local.path : remote.path),
  });

  const handleDrop = async (e, targetSide, destDir) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      // Arquivos vindos de fora do app (Explorer do Windows).
      const srcPaths = [...files].map((f) => window.electronAPI.getPathForFile(f)).filter(Boolean);
      if (srcPaths.length === 0) return;
      if (targetSide === 'local') {
        const res = await window.electronAPI.fsCopyExternal(srcPaths, destDir);
        if (!res.success)
          window.alert(`Falha ao copiar ${res.failed} item(ns):\n${res.errors.join('\n')}`);
        await local.refresh();
      } else {
        await runBatch('upload', { paths: srcPaths, destDir });
      }
      return;
    }

    // Arraste interno entre os painéis do próprio app.
    const payload = dragPayloadRef.current;
    dragPayloadRef.current = null;
    if (!payload || payload.paths.length === 0) return;
    if (payload.side === targetSide) return; // soltar no mesmo painel: sem ação (sem mover local ainda)
    if (payload.side === 'local' && targetSide === 'remote') {
      await runBatch('upload', { paths: payload.paths, destDir });
    } else if (payload.side === 'remote' && targetSide === 'local') {
      await runBatch('download', { paths: payload.paths, destDir });
    }
  };

  return (
    <div
      className="flex flex-col h-full bg-[#f3f3f3] text-[#1b1b1b]"
      style={{ fontFamily: '"Segoe UI", system-ui, sans-serif' }}
    >
      <div ref={splitContainerRef} className="flex-1 flex min-h-0">
        <div style={{ width: `${leftWidthPct}%` }} className="flex min-w-0 shrink-0">
          <PaneView label="Este Computador" pane={local} leftmost dnd={makeDnd('local')} />
        </div>
        <Splitter containerRef={splitContainerRef} setWidthPct={setLeftWidthPct} />
        <TransferRail
          onSend={() => runBatch('upload')}
          onReceive={() => runBatch('download')}
          sendDisabled={!sessionId || local.selected.size === 0 || transferring}
          receiveDisabled={!sessionId || remote.selected.size === 0 || transferring}
          sendCount={local.selected.size}
          receiveCount={remote.selected.size}
        />
        {remoteAdapter ? (
          <PaneView
            label="PC Remoto"
            pane={remote}
            connectionBadge
            onDisconnect={handleDisconnect}
            dnd={makeDnd('remote')}
          />
        ) : (
          <div className="flex-1 min-w-0 border-l border-[#e5e5e5]">
            <RemotePlaceholder activeMachine={activeMachine} />
          </div>
        )}
      </div>
      <StatusBar batch={batch} />
    </div>
  );
}
