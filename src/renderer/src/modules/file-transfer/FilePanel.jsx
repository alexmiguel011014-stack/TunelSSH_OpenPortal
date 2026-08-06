import { useMemo, useState } from 'react';
import BreadcrumbBar from './BreadcrumbBar';
import FileToolbar from './FileToolbar';
import FileRow from './FileRow';
import { getFileIcon } from './lib/fileIcons';

const chip = {
  padding: '2px 8px', borderRadius: '4px', border: '1px solid #475569',
  background: '#1e293b', color: '#cbd5e1', cursor: 'pointer', fontSize: '11px',
  whiteSpace: 'nowrap', lineHeight: 1.6,
};

// Um lado do explorador (Local ou Remoto).
//
// O componente é "burro" quanto a caminho: recebe `crumbs`, `root` e `parent`
// já resolvidos por quem sabe a plataforma (main process, no local; helpers de
// caminho virtual, no remoto) e devolve apenas intenções de navegação.
function FilePanel({
  title,
  subtitle,
  accent,
  state,
  shortcuts,
  roots,
  selection,
  onSelectionChange,
  onNavigate,
  onRefresh,
  busy,
  statusSlot,
  emptyHint,
}) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [view, setView] = useState('list');

  const { path, crumbs, root, parent, entries, loading, error } = state;
  const disabled = !!loading || !!error;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? entries.filter(e => (e.n || '').toLowerCase().includes(q)) : [...entries];
    list.sort((a, b) => {
      // Pastas sempre antes de arquivos, como no Explorador de Arquivos.
      if (a.d !== b.d) return a.d ? -1 : 1;
      let r;
      if (sortKey === 'size') r = (a.s || 0) - (b.s || 0);
      else if (sortKey === 'date') r = new Date(a.m || 0).getTime() - new Date(b.m || 0).getTime();
      else r = (a.n || '').toLowerCase().localeCompare((b.n || '').toLowerCase());
      return sortDir === 'asc' ? r : -r;
    });
    return list;
  }, [entries, query, sortKey, sortDir]);

  const activeRootPath = useMemo(() => {
    if (!path || !roots || !roots.length) return null;
    const lower = path.toLowerCase();
    let best = null;
    for (const r of roots) {
      if (!lower.startsWith(r.path.toLowerCase())) continue;
      if (!best || r.path.length > best.length) best = r.path;
    }
    return best;
  }, [path, roots]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const sortMark = (key) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  const selected = selection || new Set();
  const allSelected = visible.length > 0 && visible.every(e => selected.has(e.n));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) visible.forEach(e => next.delete(e.n));
    else visible.forEach(e => next.add(e.n));
    onSelectionChange(next);
  };

  const toggleOne = (entry, opts) => {
    const next = new Set(selected);
    if (opts && opts.additive) {
      if (next.has(entry.n)) next.delete(entry.n);
      else next.add(entry.n);
    } else if (next.has(entry.n) && next.size === 1) {
      next.clear();
    } else {
      next.clear();
      next.add(entry.n);
    }
    onSelectionChange(next);
  };

  const open = (entry) => {
    // O painel local recebe `p` (caminho absoluto pronto do main). O remoto
    // navega pelo nome, resolvido pelo container com caminhos virtuais.
    onNavigate(entry.p || entry.n, entry);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      {/* Cabeçalho */}
      <div style={{
        padding: '6px 10px', background: '#1e293b', borderBottom: '1px solid #334155',
        display: 'flex', alignItems: 'center', gap: '8px',
      }}>
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
          background: accent || '#64748b',
        }} />
        <span style={{
          fontSize: '11px', fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.5px', color: '#e2e8f0',
        }}>{title}</span>
        {subtitle && (
          <span style={{
            fontSize: '11px', color: '#64748b', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>{subtitle}</span>
        )}
        <span style={{ flex: 1 }} />
        {statusSlot}
      </div>

      {/* Raízes / volumes */}
      {roots && roots.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', padding: '4px 10px', background: '#0f172a', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
          {roots.map(r => {
            // A raiz ativa é a de prefixo mais longo: em "/media/user/USB" o
            // volume ganha de "/", que casaria com qualquer caminho.
            const active = r.path === activeRootPath;
            return (
              <button
                key={r.path}
                type="button"
                onClick={() => onNavigate(r.path)}
                title={r.path}
                style={{
                  ...chip,
                  background: active ? '#2563eb' : '#1e293b',
                  borderColor: active ? '#3b82f6' : '#475569',
                  color: active ? '#fff' : '#cbd5e1',
                }}
              >{r.label}</button>
            );
          })}
        </div>
      )}

      {/* Acesso rápido */}
      {shortcuts && shortcuts.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', padding: '4px 10px', background: '#0f172a', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
          {shortcuts.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => onNavigate(s.path)}
              title={s.path}
              style={chip}
            >{s.label}</button>
          ))}
        </div>
      )}

      <BreadcrumbBar root={root} crumbs={crumbs} onNavigate={onNavigate} disabled={busy} />

      <FileToolbar
        query={query}
        onQueryChange={setQuery}
        onRefresh={onRefresh}
        onUp={() => parent && onNavigate(parent)}
        canGoUp={!!parent}
        view={view}
        onViewChange={setView}
        disabled={disabled}
      />

      {/* Conteúdo */}
      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {error ? (
          <div style={{ padding: '28px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: '26px', marginBottom: '10px' }}>⚠️</div>
            <div style={{ color: '#f87171', fontSize: '13px', lineHeight: 1.5, maxWidth: '420px', margin: '0 auto' }}>
              {error}
            </div>
            {emptyHint && (
              <div style={{ color: '#64748b', fontSize: '11px', marginTop: '10px' }}>{emptyHint}</div>
            )}
          </div>
        ) : loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
            Carregando...
          </div>
        ) : view === 'list' ? (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', padding: '5px 10px', gap: '10px',
              borderBottom: '1px solid #1e293b', fontSize: '11px', color: '#64748b', fontWeight: 600,
              position: 'sticky', top: 0, background: '#0f172a', zIndex: 1,
            }}>
              <span style={{ width: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  ref={(el) => { if (el) el.indeterminate = !allSelected && visible.some(e => selected.has(e.n)); }}
                  style={{ cursor: 'pointer', accentColor: '#3b82f6', margin: 0 }}
                  title="Selecionar tudo"
                />
              </span>
              <span style={{ width: '22px' }} />
              <span style={{ flex: 1, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('name')}>
                Nome{sortMark('name')}
              </span>
              <span style={{ width: '78px', textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('size')}>
                Tamanho{sortMark('size')}
              </span>
              <span style={{ width: '130px', textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('date')}>
                Modificado{sortMark('date')}
              </span>
            </div>

            {visible.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
                {query ? `Nenhum item para "${query}"` : 'Pasta vazia'}
              </div>
            ) : visible.map(entry => (
              <FileRow
                key={entry.n}
                entry={entry}
                selected={selected.has(entry.n)}
                onToggle={toggleOne}
                onOpen={open}
              />
            ))}
          </>
        ) : (
          visible.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
              {query ? `Nenhum item para "${query}"` : 'Pasta vazia'}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '6px', padding: '10px' }}>
              {visible.map(entry => {
                const isSel = selected.has(entry.n);
                return (
                  <div
                    key={entry.n}
                    onClick={(e) => toggleOne(entry, { additive: e.ctrlKey || e.metaKey })}
                    onDoubleClick={() => { if (entry.d) open(entry); }}
                    title={entry.n}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
                      padding: '10px 6px', borderRadius: '8px', cursor: 'pointer',
                      background: isSel ? 'rgba(59,130,246,0.2)' : 'transparent',
                      border: isSel ? '1px solid #3b82f6' : '1px solid transparent',
                      textAlign: 'center',
                    }}
                  >
                    <span style={{ fontSize: '36px', lineHeight: 1 }}>{getFileIcon(entry.n, entry.d).icon}</span>
                    <span style={{
                      fontSize: '11px', color: entry.d ? '#e2e8f0' : '#cbd5e1',
                      overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical', wordBreak: 'break-word', maxWidth: '100%',
                      fontWeight: entry.d ? 600 : 400,
                    }}>{entry.n}</span>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* Rodapé do painel */}
      <div style={{
        padding: '3px 10px', background: '#0f172a', borderTop: '1px solid #1e293b',
        fontSize: '10px', color: '#64748b', display: 'flex', gap: '10px',
      }}>
        <span>{visible.length} {visible.length === 1 ? 'item' : 'itens'}</span>
        {selected.size > 0 && <span style={{ color: '#60a5fa' }}>{selected.size} selecionado(s)</span>}
      </div>
    </div>
  );
}

export default FilePanel;
