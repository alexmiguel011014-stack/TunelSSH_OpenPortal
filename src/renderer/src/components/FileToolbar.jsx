const btn = {
  padding: '3px 9px', borderRadius: '4px', border: '1px solid #475569',
  background: '#1e293b', color: '#e2e8f0', cursor: 'pointer', fontSize: '11px',
  whiteSpace: 'nowrap', lineHeight: 1.6,
};

const disabledBtn = {
  ...btn, cursor: 'default', opacity: 0.4, color: '#64748b',
};

function FileToolbar({ query, onQueryChange, onRefresh, onUp, canGoUp, view, onViewChange, disabled }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 10px', background: '#0f172a', borderBottom: '1px solid #1e293b' }}>
      <button
        type="button"
        onClick={onUp}
        disabled={!canGoUp || disabled}
        title="Voltar uma pasta"
        style={canGoUp && !disabled ? btn : disabledBtn}
      >↑ Acima</button>

      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Filtrar..."
        disabled={disabled}
        style={{
          flex: 1, minWidth: '60px', background: '#0f172a', border: '1px solid #334155',
          borderRadius: '4px', color: '#e2e8f0', fontSize: '12px', padding: '3px 8px', outline: 'none',
        }}
      />

      <div style={{ display: 'flex', gap: '3px' }}>
        <button
          type="button"
          onClick={() => onViewChange('list')}
          title="Visualização em lista"
          style={{
            ...btn,
            background: view === 'list' ? '#2563eb' : '#1e293b',
            borderColor: view === 'list' ? '#3b82f6' : '#475569',
            color: view === 'list' ? '#fff' : '#cbd5e1',
          }}
        >≡</button>
        <button
          type="button"
          onClick={() => onViewChange('grid')}
          title="Visualização em ícones"
          style={{
            ...btn,
            background: view === 'grid' ? '#2563eb' : '#1e293b',
            borderColor: view === 'grid' ? '#3b82f6' : '#475569',
            color: view === 'grid' ? '#fff' : '#cbd5e1',
          }}
        >▦</button>
      </div>

      <button
        type="button"
        onClick={onRefresh}
        disabled={disabled}
        title="Atualizar listagem"
        style={disabled ? disabledBtn : btn}
      >⟳</button>
    </div>
  );
}

export default FileToolbar;
