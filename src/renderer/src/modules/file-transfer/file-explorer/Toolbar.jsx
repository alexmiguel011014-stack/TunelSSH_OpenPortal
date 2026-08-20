import { guessSep, joinNative, joinVirtual } from './utils';

// ---------------------------------------------------------------------------
// Botões, navegação e barra lateral de atalhos
// ---------------------------------------------------------------------------

export function ToolbarButton({ onClick, disabled, title, children }) {
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

export function CommandButton({ onClick, disabled, children, title }) {
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

export function Breadcrumb({ path, adapter, onNavigate }) {
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

export function NavSidebar({ pane, onNavigate }) {
  return (
    <div className="w-44 shrink-0 border-r border-[#e5e5e5] bg-[#f9f9f9] overflow-y-auto py-2 text-[13px]">
      {pane.quickAccess.length > 0 && (
        <div className="mb-2">
          <div className="px-3 py-1 text-[11px] font-semibold text-[#605e5c] uppercase tracking-wide">
            Acesso rápido
          </div>
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
          <div className="px-3 py-1 text-[11px] font-semibold text-[#605e5c] uppercase tracking-wide">
            Este computador
          </div>
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
