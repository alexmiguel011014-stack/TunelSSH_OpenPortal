const btn = {
  padding: '3px 10px', borderRadius: '4px', border: '1px solid #475569',
  background: '#1e293b', color: '#e2e8f0', cursor: 'pointer', fontSize: '11px'
};

function FileToolbar({ query, onQueryChange, onRefresh, view, onViewChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', background: '#0f172a', borderBottom: '1px solid #1e293b' }}>
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Filtrar..."
        style={{
          flex: 1, minWidth: 0, background: '#0f172a', border: '1px solid #334155',
          borderRadius: '4px', color: '#e2e8f0', fontSize: '12px', padding: '3px 8px', outline: 'none'
        }}
      />
      <div style={{ display: 'flex', gap: '4px' }}>
        <button
          onClick={() => onViewChange('list')}
          title="Visualização em lista"
          style={{
            ...btn,
            background: view === 'list' ? '#2563eb' : '#1e293b',
            borderColor: view === 'list' ? '#3b82f6' : '#475569',
            color: view === 'list' ? '#fff' : '#cbd5e1',
          }}
        >≡ Lista</button>
        <button
          onClick={() => onViewChange('grid')}
          title="Visualização em ícones"
          style={{
            ...btn,
            background: view === 'grid' ? '#2563eb' : '#1e293b',
            borderColor: view === 'grid' ? '#3b82f6' : '#475569',
            color: view === 'grid' ? '#fff' : '#cbd5e1',
          }}
        >▦ Ícones</button>
      </div>
      {onRefresh && (
        <button onClick={onRefresh} style={{ ...btn, whiteSpace: 'nowrap' }}>Atualizar</button>
      )}
    </div>
  );
}

export default FileToolbar;