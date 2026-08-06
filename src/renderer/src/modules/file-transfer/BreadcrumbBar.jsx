// Barra de caminho clicável. Recebe as migalhas já prontas (do main process,
// no painel local; de `virtualCrumbs`, no remoto) e nunca interpreta separador
// — é o que mantém a barra idêntica em Windows, Linux e macOS.
function BreadcrumbBar({ root, crumbs, onNavigate, disabled }) {
  const items = crumbs || [];

  const chip = (label, target, isRoot) => (
    <button
      key={target + '|' + label}
      type="button"
      disabled={disabled}
      onClick={() => !disabled && onNavigate(target)}
      title={target}
      style={{
        background: 'none',
        border: 'none',
        padding: '1px 4px',
        borderRadius: '3px',
        cursor: disabled ? 'default' : 'pointer',
        color: isRoot ? '#60a5fa' : '#e2e8f0',
        fontFamily: 'inherit',
        fontSize: '11px',
        fontWeight: isRoot ? 600 : 400,
        maxWidth: '180px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '1px', padding: '4px 10px',
      background: '#0f172a', borderBottom: '1px solid #1e293b',
      fontFamily: 'monospace', fontSize: '11px', color: '#94a3b8',
      minHeight: '26px', overflowX: 'auto', whiteSpace: 'nowrap',
    }}>
      {root && chip(root.name, root.path, true)}
      {items.map((crumb) => (
        <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
          <span style={{ color: '#475569' }}>›</span>
          {chip(crumb.name, crumb.path, false)}
        </span>
      ))}
    </div>
  );
}

export default BreadcrumbBar;
