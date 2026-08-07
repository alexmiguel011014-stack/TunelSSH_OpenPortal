import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import { MachineContext } from '../../App';

// Explorador de arquivos dual-pane (PC local ↔ PC remoto via túnel), com
// aparência de Windows 11 Explorer independente do tema escuro/claro do
// resto do app — é uma janela "de sistema" dentro do app.

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatElapsed(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

const EXT_ICONS = {
  jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', webp: '🖼️', svg: '🖼️', ico: '🖼️',
  mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', wmv: '🎬', webm: '🎬',
  mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', m4a: '🎵',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
  pdf: '📕',
  doc: '📘', docx: '📘',
  xls: '📗', xlsx: '📗', csv: '📗',
  ppt: '📙', pptx: '📙',
  exe: '⚙️', msi: '⚙️',
  js: '📄', jsx: '📄', ts: '📄', tsx: '📄', json: '📄', html: '📄', css: '📄', md: '📄', py: '📄', java: '📄', c: '📄', cpp: '📄', cs: '📄', go: '📄', rs: '📄', sh: '📄', ps1: '📄',
};

function iconFor(entry) {
  if (entry.dir) return '📁';
  const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
  return EXT_ICONS[ext] || '📄';
}

function joinVirtual(base, name) {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

function guessSep(nativePath) {
  return nativePath && nativePath.includes('\\') ? '\\' : '/';
}

function joinNative(base, name) {
  const sep = guessSep(base);
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
}

// ---------------------------------------------------------------------------
// Adapters — mesma interface para o painel local (fs direto) e remoto (túnel)
// ---------------------------------------------------------------------------

const localAdapter = {
  side: 'local',
  join: joinNative,
  async listRoots() {
    return window.electronAPI.fsListRoots();
  },
  async listDir(dirPath) {
    const r = await window.electronAPI.fsListDir(dirPath);
    return r.entries;
  },
  async parent(dirPath) {
    const r = await window.electronAPI.fsParent(dirPath);
    return r.parent;
  },
  async mkdir(dirPath) {
    const r = await window.electronAPI.fsMkdir(dirPath);
    if (!r.success) throw new Error(r.message || 'Falha ao criar pasta');
  },
  async remove(itemPath) {
    const r = await window.electronAPI.fsDelete(itemPath);
    if (!r.success) throw new Error(r.message || 'Falha ao excluir');
  },
  async rename(oldPath, newPath) {
    const r = await window.electronAPI.fsRename(oldPath, newPath);
    if (!r.success) throw new Error(r.message || 'Falha ao renomear');
  },
};

function makeRemoteAdapter(sessionId) {
  return {
    side: 'remote',
    join: joinVirtual,
    async listRoots() {
      // Só existe uma raiz no agente ('/'), então basta o atalho de Início —
      // repetir em "Este computador" seria redundante.
      return { roots: [], quickAccess: [{ name: 'Início', path: '/' }] };
    },
    async listDir(virtualPath) {
      const r = await window.electronAPI.ftList(sessionId, virtualPath);
      return r.entries.map((e) => ({ ...e, path: joinVirtual(virtualPath, e.name) }));
    },
    async parent(virtualPath) {
      if (!virtualPath || virtualPath === '/') return null;
      const parts = virtualPath.split('/').filter(Boolean);
      parts.pop();
      return parts.length ? `/${parts.join('/')}` : '/';
    },
    async mkdir(virtualPath) {
      await window.electronAPI.ftMkdir(sessionId, virtualPath);
    },
    async remove(virtualPath) {
      await window.electronAPI.ftDelete(sessionId, virtualPath);
    },
    async rename(oldPath, newPath) {
      await window.electronAPI.ftRename(sessionId, oldPath, newPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Estado de um painel (local ou remoto)
// ---------------------------------------------------------------------------

function usePane(adapter, initialPath) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [view, setView] = useState('list');
  const [query, setQuery] = useState('');
  const [roots, setRoots] = useState([]);
  const [quickAccess, setQuickAccess] = useState([]);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [renamingName, setRenamingName] = useState(null);

  const historyRef = useRef([]);
  const historyIdxRef = useRef(-1);
  const reqIdRef = useRef(0);

  const updateHistoryFlags = () => {
    setCanBack(historyIdxRef.current > 0);
    setCanForward(historyIdxRef.current < historyRef.current.length - 1);
  };

  const load = useCallback(async (targetPath, { pushHistory = true } = {}) => {
    if (!adapter || !targetPath) return;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError('');
    try {
      const nextEntries = await adapter.listDir(targetPath);
      if (myReq !== reqIdRef.current) return;
      setEntries(nextEntries);
      setPath(targetPath);
      setSelected(new Set());
      if (pushHistory) {
        const trimmed = historyRef.current.slice(0, historyIdxRef.current + 1);
        trimmed.push(targetPath);
        historyRef.current = trimmed;
        historyIdxRef.current = trimmed.length - 1;
        updateHistoryFlags();
      }
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      setError(err.message || String(err));
      setEntries([]);
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [adapter]);

  useEffect(() => {
    if (!adapter) {
      setEntries([]);
      setPath(initialPath);
      setRoots([]);
      setQuickAccess([]);
      historyRef.current = [];
      historyIdxRef.current = -1;
      return;
    }
    let cancelled = false;
    historyRef.current = [];
    historyIdxRef.current = -1;
    (async () => {
      try {
        const r = await adapter.listRoots();
        if (cancelled) return;
        setRoots(r.roots || []);
        setQuickAccess(r.quickAccess || []);
        const start = initialPath || (r.quickAccess && r.quickAccess[0] && r.quickAccess[0].path) || (r.roots && r.roots[0] && r.roots[0].path);
        if (start) load(start, { pushHistory: true });
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  const goBack = () => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    updateHistoryFlags();
    load(historyRef.current[historyIdxRef.current], { pushHistory: false });
  };

  const goForward = () => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    updateHistoryFlags();
    load(historyRef.current[historyIdxRef.current], { pushHistory: false });
  };

  const goUp = async () => {
    if (!adapter) return;
    const parent = await adapter.parent(path);
    if (parent) load(parent);
  };

  const goHome = () => {
    const home = (quickAccess[0] && quickAccess[0].path) || (roots[0] && roots[0].path);
    if (home) load(home);
  };

  const refresh = () => load(path, { pushHistory: false });

  return {
    adapter, path, entries, loading, error,
    selected, setSelected,
    sortBy, setSortBy, sortDir, setSortDir,
    view, setView, query, setQuery,
    roots, quickAccess, canBack, canForward,
    load, goBack, goForward, goUp, goHome, refresh,
    renamingName, setRenamingName,
  };
}

function sortAndFilter(entries, { query, sortBy, sortDir }) {
  const q = query.trim().toLowerCase();
  let list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice();
  const dir = sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (sortBy === 'size') return (a.size - b.size) * dir;
    if (sortBy === 'date') return ((a.mtime || 0) - (b.mtime || 0)) * dir;
    return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) * dir;
  });
  return list;
}

// ---------------------------------------------------------------------------
// Componentes de apoio
// ---------------------------------------------------------------------------

function ToolbarButton({ onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center justify-center w-8 h-8 rounded text-[15px] text-[#1b1b1b] hover:bg-[#e8e8e8] active:bg-[#dcdcdc] disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default transition-colors"
    >
      {children}
    </button>
  );
}

function CommandButton({ onClick, disabled, children, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1.5 px-2.5 h-7 rounded text-[13px] text-[#1b1b1b] hover:bg-[#e8e8e8] active:bg-[#dcdcdc] disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default transition-colors"
    >
      {children}
    </button>
  );
}

function Breadcrumb({ path, adapter, onNavigate }) {
  if (!path) return <div className="flex-1" />;
  const sep = adapter?.side === 'remote' ? '/' : guessSep(path);
  const isWinDrive = adapter?.side === 'local' && /^[A-Za-z]:\\?$/.test(path.split(sep)[0] + sep);
  const rawParts = path.split(sep).filter(Boolean);

  const crumbs = [];
  let acc = '';
  if (adapter?.side === 'remote') {
    crumbs.push({ label: 'Raiz', path: '/' });
    for (const part of rawParts) {
      acc = joinVirtual(acc || '/', part);
      crumbs.push({ label: part, path: acc });
    }
  } else if (isWinDrive) {
    const drive = rawParts[0] + sep;
    crumbs.push({ label: drive, path: drive });
    acc = drive;
    for (const part of rawParts.slice(1)) {
      acc = joinNative(acc, part);
      crumbs.push({ label: part, path: acc });
    }
  } else {
    acc = sep;
    crumbs.push({ label: sep, path: sep });
    for (const part of rawParts) {
      acc = joinNative(acc, part);
      crumbs.push({ label: part, path: acc });
    }
  }

  return (
    <div className="flex-1 min-w-0 flex items-center gap-0.5 h-7 px-2 rounded border border-[#e0e0e0] bg-white overflow-x-auto whitespace-nowrap">
      {crumbs.map((c, i) => (
        <span key={c.path} className="flex items-center gap-0.5 shrink-0">
          {i > 0 && <span className="text-[#a19f9d] text-[11px]">›</span>}
          <button
            onClick={() => onNavigate(c.path)}
            className="text-[13px] px-1 rounded hover:bg-[#e8e8e8] text-[#1b1b1b] max-w-[160px] truncate"
            title={c.path}
          >
            {c.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function NavSidebar({ pane, onNavigate }) {
  return (
    <div className="w-44 shrink-0 border-r border-[#e5e5e5] bg-[#f9f9f9] overflow-y-auto py-2 text-[13px]">
      {pane.quickAccess.length > 0 && (
        <div className="mb-2">
          <div className="px-3 py-1 text-[11px] font-semibold text-[#605e5c] uppercase tracking-wide">Acesso rápido</div>
          {pane.quickAccess.map((q) => (
            <button
              key={q.path}
              onClick={() => onNavigate(q.path)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#e8e8e8] ${pane.path === q.path ? 'bg-[#e5f3fb] text-[#0067c0]' : 'text-[#1b1b1b]'}`}
              title={q.path}
            >
              <span>📌</span>
              <span className="truncate">{q.name}</span>
            </button>
          ))}
        </div>
      )}
      {pane.roots.length > 0 && (
        <div>
          <div className="px-3 py-1 text-[11px] font-semibold text-[#605e5c] uppercase tracking-wide">Este computador</div>
          {pane.roots.map((r) => (
            <button
              key={r.path}
              onClick={() => onNavigate(r.path)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#e8e8e8] ${pane.path === r.path ? 'bg-[#e5f3fb] text-[#0067c0]' : 'text-[#1b1b1b]'}`}
              title={r.path}
            >
              <span>💾</span>
              <span className="truncate">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function InlineNameInput({ initialValue, onCommit, onCancel }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const trimmed = value.trim();
          if (trimmed && trimmed !== initialValue) onCommit(trimmed);
          else onCancel();
        } else if (e.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== initialValue) onCommit(trimmed);
        else onCancel();
      }}
      className="text-[13px] px-1 py-0.5 border border-[#0067c0] rounded outline-none w-full bg-white text-[#1b1b1b]"
    />
  );
}

function EntryList({ pane, visibleEntries, onOpen, onSelect, onRenameCommit, dnd }) {
  const listRef = useRef(null);
  const [dragOverName, setDragOverName] = useState(null);

  const headerBtn = (col, label) => (
    <button
      onClick={() => {
        if (pane.sortBy === col) pane.setSortDir(pane.sortDir === 'asc' ? 'desc' : 'asc');
        else { pane.setSortBy(col); pane.setSortDir('asc'); }
      }}
      className="flex items-center gap-1 hover:text-[#0067c0]"
    >
      {label}
      {pane.sortBy === col && <span className="text-[10px]">{pane.sortDir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );

  const rowDragProps = (entry) => ({
    draggable: pane.renamingName !== entry.name,
    onDragStart: (e) => dnd.onEntryDragStart(e, entry),
    onDragOver: (e) => {
      if (!entry.dir) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = dnd.effectFor(e);
      setDragOverName(entry.name);
    },
    onDragLeave: () => setDragOverName((prev) => (prev === entry.name ? null : prev)),
    onDrop: (e) => {
      if (!entry.dir) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOverName(null);
      dnd.onDropOnFolder(e, entry);
    },
  });

  if (pane.view === 'icons') {
    return (
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto p-3 grid gap-1 content-start"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}
        onClick={() => pane.setSelected(new Set())}
      >
        {visibleEntries.map((entry, index) => (
          <div
            key={entry.name}
            onClick={(e) => { e.stopPropagation(); onSelect(entry, index, e); }}
            onDoubleClick={(e) => { e.stopPropagation(); onOpen(entry); }}
            className={`flex flex-col items-center gap-1 p-2 rounded cursor-default select-none ${pane.selected.has(entry.name) ? 'bg-[#cce8ff]' : dragOverName === entry.name ? 'bg-[#d5ecff] ring-1 ring-[#0067c0]' : 'hover:bg-[#f0f0f0]'}`}
            title={entry.name}
            {...rowDragProps(entry)}
          >
            <span className="text-[36px] leading-none">{iconFor(entry)}</span>
            {pane.renamingName === entry.name ? (
              <InlineNameInput
                initialValue={entry.name}
                onCommit={(v) => onRenameCommit(entry, v)}
                onCancel={() => pane.setRenamingName(null)}
              />
            ) : (
              <span className="text-[12px] text-center break-all line-clamp-2">{entry.name}</span>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto" onClick={() => pane.setSelected(new Set())}>
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 h-8 bg-[#f3f3f3] border-b border-[#e5e5e5] text-[12px] text-[#605e5c]">
        <div className="flex-1 min-w-0">{headerBtn('name', 'Nome')}</div>
        <div className="w-32 shrink-0">{headerBtn('date', 'Modificado em')}</div>
        <div className="w-20 shrink-0 text-right">{headerBtn('size', 'Tamanho')}</div>
      </div>
      {visibleEntries.map((entry, index) => (
        <div
          key={entry.name}
          onClick={(e) => { e.stopPropagation(); onSelect(entry, index, e); }}
          onDoubleClick={(e) => { e.stopPropagation(); onOpen(entry); }}
          className={`file-row flex items-center gap-2 px-3 h-8 text-[13px] cursor-default select-none ${pane.selected.has(entry.name) ? 'bg-[#cce8ff]' : dragOverName === entry.name ? 'bg-[#d5ecff] ring-1 ring-inset ring-[#0067c0]' : ''}`}
          {...rowDragProps(entry)}
        >
          <span className="text-[16px] w-5 shrink-0 text-center">{iconFor(entry)}</span>
          {pane.renamingName === entry.name ? (
            <div className="flex-1 min-w-0">
              <InlineNameInput
                initialValue={entry.name}
                onCommit={(v) => onRenameCommit(entry, v)}
                onCancel={() => pane.setRenamingName(null)}
              />
            </div>
          ) : (
            <span className="flex-1 min-w-0 truncate text-[#1b1b1b]">{entry.name}</span>
          )}
          <span className="w-32 shrink-0 text-[12px] text-[#605e5c]">{formatDate(entry.mtime)}</span>
          <span className="w-20 shrink-0 text-[12px] text-[#605e5c] text-right">{entry.dir ? '' : formatBytes(entry.size)}</span>
        </div>
      ))}
      {visibleEntries.length === 0 && (
        <div className="flex items-center justify-center h-24 text-[13px] text-[#a19f9d]">Pasta vazia</div>
      )}
    </div>
  );
}

function PaneView({ label, pane, connectionBadge, onDisconnect, leftmost, dnd }) {
  const lastIndexRef = useRef(-1);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [paneDragOver, setPaneDragOver] = useState(false);

  const visibleEntries = useMemo(
    () => sortAndFilter(pane.entries, { query: pane.query, sortBy: pane.sortBy, sortDir: pane.sortDir }),
    [pane.entries, pane.query, pane.sortBy, pane.sortDir]
  );

  const onSelect = (entry, index, e) => {
    pane.setSelected((prev) => {
      if (e.shiftKey && lastIndexRef.current >= 0) {
        const [from, to] = [lastIndexRef.current, index].sort((a, b) => a - b);
        return new Set(visibleEntries.slice(from, to + 1).map((x) => x.name));
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(entry.name)) next.delete(entry.name);
        else next.add(entry.name);
        return next;
      }
      return new Set([entry.name]);
    });
    if (!e.shiftKey) lastIndexRef.current = index;
  };

  const onOpen = (entry) => {
    if (entry.dir) pane.load(entry.path);
  };

  const handleNewFolder = async () => {
    // mkdir(..., {recursive:true}) no backend não falha se a pasta já
    // existir — por isso a checagem de colisão é feita aqui contra os
    // nomes já listados, e não tentando criar e reagindo ao erro.
    const existingNames = new Set(pane.entries.map((e) => e.name));
    const base = 'Nova pasta';
    let name = base;
    for (let i = 2; existingNames.has(name); i++) name = `${base} (${i})`;

    try {
      await pane.adapter.mkdir(pane.adapter.join(pane.path, name));
    } catch (err) {
      window.alert(`Falha ao criar pasta: ${err.message}`);
      return;
    }
    await pane.refresh();
    pane.setSelected(new Set([name]));
    pane.setRenamingName(name);
  };

  const handleDelete = async () => {
    if (pane.selected.size === 0) return;
    if (!window.confirm(`Excluir ${pane.selected.size} item(ns) selecionado(s)? Essa ação não pode ser desfeita.`)) return;
    for (const name of pane.selected) {
      const entry = pane.entries.find((e) => e.name === name);
      if (!entry) continue;
      try {
        await pane.adapter.remove(entry.path);
      } catch (err) {
        window.alert(`Falha ao excluir "${name}": ${err.message}`);
      }
    }
    await pane.refresh();
  };

  const handleRenameStart = () => {
    if (pane.selected.size !== 1) return;
    pane.setRenamingName([...pane.selected][0]);
  };

  const handleRenameCommit = async (entry, newName) => {
    pane.setRenamingName(null);
    try {
      await pane.adapter.rename(entry.path, pane.adapter.join(pane.path, newName));
      await pane.refresh();
    } catch (err) {
      window.alert(`Falha ao renomear: ${err.message}`);
    }
  };

  const selectedCount = pane.selected.size;

  return (
    <div className="flex flex-col h-full min-w-0 bg-white">
      {/* Cabeçalho da janela — paddingLeft extra no painel da esquerda pra não
          ficar embaixo do hambúrguer fixo (barra lateral recolhida). */}
      <div
        className="flex items-center justify-between h-8 px-3 bg-[#f3f3f3] border-b border-[#e5e5e5] text-[12px] font-medium text-[#1b1b1b]"
        style={leftmost ? { paddingLeft: '44px' } : undefined}
      >
        <span className="truncate">{label}</span>
        {connectionBadge && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="flex items-center gap-1 text-[11px] text-[#107c10]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#107c10]" /> Conectado
            </span>
            <button onClick={onDisconnect} className="text-[11px] text-[#a80000] hover:underline">Desconectar</button>
          </div>
        )}
      </div>

      {/* Barra de navegação */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#e5e5e5]">
        <ToolbarButton onClick={pane.goBack} disabled={!pane.canBack} title="Voltar">←</ToolbarButton>
        <ToolbarButton onClick={pane.goForward} disabled={!pane.canForward} title="Avançar">→</ToolbarButton>
        <ToolbarButton onClick={pane.refresh} title="Atualizar">↻</ToolbarButton>
        <ToolbarButton onClick={pane.goHome} title="Início">🏠</ToolbarButton>
        <Breadcrumb path={pane.path} adapter={pane.adapter} onNavigate={pane.load} />
        <input
          value={pane.query}
          onChange={(e) => pane.setQuery(e.target.value)}
          placeholder="Pesquisar"
          className="w-36 h-7 px-2 text-[13px] border border-[#e0e0e0] rounded bg-white text-[#1b1b1b] outline-none focus:border-[#0067c0]"
        />
      </div>

      {/* Barra de comandos */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-[#e5e5e5]">
        <CommandButton onClick={handleNewFolder} title="Nova pasta">📁 Novo</CommandButton>
        <span className="w-px h-4 bg-[#e0e0e0] mx-1" />
        <CommandButton disabled title="Recortar (em breve)">✂️ Recortar</CommandButton>
        <CommandButton disabled title="Copiar (em breve)">📋 Copiar</CommandButton>
        <CommandButton disabled title="Colar (em breve)">📥 Colar</CommandButton>
        <span className="w-px h-4 bg-[#e0e0e0] mx-1" />
        <CommandButton onClick={handleRenameStart} disabled={selectedCount !== 1} title="Renomear">✏️ Renomear</CommandButton>
        <CommandButton onClick={handleDelete} disabled={selectedCount === 0} title="Excluir">🗑️ Excluir</CommandButton>
        <div className="flex-1" />
        <ToolbarButton onClick={() => pane.setView(pane.view === 'list' ? 'icons' : 'list')} title={pane.view === 'list' ? 'Ícones grandes' : 'Lista'}>
          {pane.view === 'list' ? '▦' : '☰'}
        </ToolbarButton>
      </div>

      <div className="flex flex-1 min-h-0">
        <NavSidebar pane={pane} onNavigate={pane.load} />
        <div
          className={`flex-1 min-w-0 flex flex-col relative ${paneDragOver ? 'after:absolute after:inset-0 after:pointer-events-none after:ring-2 after:ring-inset after:ring-[#0067c0] after:bg-[#0067c0]/5' : ''}`}
          onDragOver={(e) => {
            if (!dnd) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = dnd.effectFor(e);
            setPaneDragOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return;
            setPaneDragOver(false);
          }}
          onDrop={(e) => {
            if (!dnd) return;
            e.preventDefault();
            setPaneDragOver(false);
            dnd.onDropOnCurrentDir(e);
          }}
        >
          {pane.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-[13px] text-[#605e5c] z-20">Carregando…</div>
          )}
          {pane.error ? (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="text-center max-w-xs">
                <div className="text-[13px] text-[#a80000] mb-2">{pane.error}</div>
                <button onClick={pane.refresh} className="text-[12px] px-2 py-1 rounded border border-[#e0e0e0] hover:bg-[#f0f0f0]">Tentar novamente</button>
              </div>
            </div>
          ) : (
            <EntryList pane={pane} visibleEntries={visibleEntries} onOpen={onOpen} onSelect={onSelect} onRenameCommit={handleRenameCommit} dnd={dnd} />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between h-6 px-3 bg-[#f3f3f3] border-t border-[#e5e5e5] text-[11px] text-[#605e5c]">
        <span>{visibleEntries.length} iten(s)</span>
        {selectedCount > 0 && <span>{selectedCount} selecionado(s)</span>}
      </div>
    </div>
  );
}

function RemotePlaceholder({ activeMachine }) {
  return (
    <div className="flex flex-col h-full min-w-0 bg-white items-center justify-center gap-3 p-6">
      <div className="text-[15px] font-medium text-[#1b1b1b] text-center">
        {activeMachine ? `Preparando acesso a ${activeMachine.name}…` : 'Nenhum PC conectado'}
      </div>
      <div className="text-[12px] text-[#605e5c] text-center max-w-xs">
        {activeMachine
          ? 'A sessão de arquivos acompanha a conexão atual.'
          : 'Conecte-se a um PC pela barra lateral ou na tela inicial — os arquivos ficam disponíveis automaticamente.'}
      </div>
    </div>
  );
}

function TransferRail({ onSend, onReceive, sendDisabled, receiveDisabled, sendCount, receiveCount }) {
  return (
    <div className="w-16 shrink-0 flex flex-col items-center justify-center gap-3 bg-[#f3f3f3] border-x border-[#e5e5e5]">
      <button
        onClick={onSend}
        disabled={sendDisabled}
        title="Enviar para o PC remoto"
        className="flex flex-col items-center gap-1 px-1.5 py-2 rounded hover:bg-[#e8e8e8] disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <span className="text-[18px]">➜</span>
        <span className="text-[10px] text-[#1b1b1b] text-center leading-tight">Enviar{sendCount ? ` (${sendCount})` : ''}</span>
      </button>
      <button
        onClick={onReceive}
        disabled={receiveDisabled}
        title="Receber do PC remoto"
        className="flex flex-col items-center gap-1 px-1.5 py-2 rounded hover:bg-[#e8e8e8] disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <span className="text-[18px]">⟸</span>
        <span className="text-[10px] text-[#1b1b1b] text-center leading-tight">Receber{receiveCount ? ` (${receiveCount})` : ''}</span>
      </button>
    </div>
  );
}

function StatusBar({ batch }) {
  if (!batch) return null;
  const pct = batch.batchTotal > 0 ? Math.min(100, Math.round((batch.batchSent / batch.batchTotal) * 100)) : (batch.done ? 100 : 0);
  const filePct = batch.fileSize > 0 ? Math.min(100, Math.round((batch.fileSent / batch.fileSize) * 100)) : 0;
  const phaseLabel = batch.phase === 'upload' ? 'Enviando' : 'Recebendo';

  return (
    <div className="border-t border-[#e5e5e5] bg-[#f9f9f9] px-4 py-2 text-[12px] text-[#1b1b1b]">
      <div className="flex items-center justify-between mb-1">
        <span className={`truncate ${batch.error && !batch.ok ? 'text-[#a80000]' : ''}`}>
          {batch.done
            ? batch.error && !batch.ok
              ? `${phaseLabel} falhou: ${batch.error}`
              : `${phaseLabel} concluído — ${batch.ok || 0} ok${batch.failed ? `, ${batch.failed} falha(s)` : ''}`
            : `${phaseLabel}: ${batch.fileName || ''} (${filePct}%)`}
        </span>
        <span className="shrink-0 text-[#605e5c]">
          {formatBytes(batch.speedBps)}/s · {formatElapsed(batch.elapsedMs)}
        </span>
      </div>
      <div className="h-1.5 rounded bg-[#e0e0e0] overflow-hidden">
        <div className="h-full bg-[#0067c0] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between mt-0.5 text-[11px] text-[#605e5c]">
        <span>{formatBytes(batch.batchSent)} / {formatBytes(batch.batchTotal)}</span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export default function FileExplorer() {
  const local = usePane(localAdapter, null);

  // A aprovação e o túnel de arquivos já foram estabelecidos no momento em
  // que o usuário conectou ao PC (ver connectMachine em App.jsx) — aqui só
  // lemos o sessionId pronto. Nenhum IP, nenhum "aguardando aprovação".
  const machineCtx = useContext(MachineContext);
  const activeMachine = machineCtx?.activeMachine || null;
  const sessionId = machineCtx?.ftSessionId || null;

  const remoteAdapter = useMemo(() => (sessionId ? makeRemoteAdapter(sessionId) : null), [sessionId]);
  const remote = usePane(remoteAdapter, '/');

  const [batch, setBatch] = useState(null);
  const batchIdRef = useRef(0);
  const [transferring, setTransferring] = useState(false);

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
    setBatch({ batchId, phase: kind === 'upload' ? 'upload' : 'download', batchSent: 0, batchTotal: 0, elapsedMs: 0, speedBps: 0 });
    try {
      if (kind === 'upload') {
        const localPaths = override?.paths || [...local.selected].map((name) => local.entries.find((e) => e.name === name)?.path).filter(Boolean);
        if (localPaths.length === 0) return;
        await window.electronAPI.ftUploadBatch(sessionId, { localPaths, destDir: override?.destDir || remote.path, batchId });
        await remote.refresh();
      } else {
        const remotePaths = override?.paths || [...remote.selected].map((name) => remote.entries.find((e) => e.name === name)?.path).filter(Boolean);
        if (remotePaths.length === 0) return;
        await window.electronAPI.ftDownloadBatch(sessionId, { remotePaths, destDir: override?.destDir || local.path, batchId });
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
    effectFor: (e) => (e.dataTransfer.types.includes('Files') || dragPayloadRef.current ? 'copy' : 'none'),

    onEntryDragStart: (e, entry) => {
      const pane = side === 'local' ? local : remote;
      const names = pane.selected.has(entry.name) ? [...pane.selected] : [entry.name];
      const paths = names.map((n) => pane.entries.find((x) => x.name === n)?.path).filter(Boolean);
      dragPayloadRef.current = { side, paths };
      e.dataTransfer.effectAllowed = 'copy';
      try { e.dataTransfer.setData('text/plain', names.join(', ')); } catch {}
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
        if (!res.success) window.alert(`Falha ao copiar ${res.failed} item(ns):\n${res.errors.join('\n')}`);
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
    <div className="flex flex-col h-full bg-[#f3f3f3] text-[#1b1b1b]" style={{ fontFamily: '"Segoe UI", system-ui, sans-serif' }}>
      <div className="flex-1 flex min-h-0">
        <PaneView label="Este Computador" pane={local} leftmost dnd={makeDnd('local')} />
        <TransferRail
          onSend={() => runBatch('upload')}
          onReceive={() => runBatch('download')}
          sendDisabled={!sessionId || local.selected.size === 0 || transferring}
          receiveDisabled={!sessionId || remote.selected.size === 0 || transferring}
          sendCount={local.selected.size}
          receiveCount={remote.selected.size}
        />
        {remoteAdapter ? (
          <PaneView label="PC Remoto" pane={remote} connectionBadge onDisconnect={handleDisconnect} dnd={makeDnd('remote')} />
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
