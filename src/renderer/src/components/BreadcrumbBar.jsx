function BreadcrumbBar({ path, isLocal, onNavigate }) {
  const pathParts = path ? path.split('\\').filter(Boolean) : [];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '2px', padding: '5px 12px', background: '#0f172a',
      borderBottom: '1px solid #1e293b', fontFamily: 'monospace', fontSize: '11px', color: '#94a3b8',
      flexWrap: 'wrap', minHeight: '26px',
    }}>
      {isLocal ? (
        pathParts.length === 0 ? (
          <span style={{ color: '#64748b', fontSize: '11px' }}>{path}</span>
        ) : (
          <>
            <span style={{ color: '#3b82f6', cursor: 'pointer' }} onClick={() => onNavigate(pathParts[0] + '\\')}>
              {pathParts[0]}
            </span>
            {pathParts.slice(1).map((part, i) => (
              <span key={i} style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                <span style={{ color: '#475569' }}>\</span>
                <span style={{ cursor: 'pointer', color: '#e2e8f0' }} onClick={() => onNavigate(pathParts.slice(0, i + 2).join('\\') + '\\')}>
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
  );
}

export default BreadcrumbBar;