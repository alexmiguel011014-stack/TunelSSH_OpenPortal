import { useEffect, useRef, useState } from 'react';

export default function Terminal({ logs, onClear }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('all');
  const logContainerRef = useRef(null);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll, isMinimized]);

  const copyLogsToClipboard = () => {
    const text = logs
      .map((l) => `[${l.time}] [${l.type.toUpperCase()}] ${l.msg}`)
      .join('\n');
    navigator.clipboard.writeText(text);
  };

  const filteredLogs = logs.filter((l) => {
    if (filter === 'error') return l.type === 'error' || l.type === 'warn';
    if (filter === 'info') return l.type === 'info' || l.type === 'success';
    return true;
  });

  return (
    <div
      style={{
        height: isMinimized ? '36px' : '220px',
        transition: 'height 0.2s ease-in-out',
        background: '#090d16',
        borderTop: '1px solid #1e293b',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Fira Code', Consolas, Monaco, 'Courier New', monospace",
        zIndex: 10,
        boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.4)',
      }}
    >
      {/* Terminal Header */}
      <div
        style={{
          height: '36px',
          background: '#0f172a',
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: isMinimized ? 'none' : '1px solid #1e293b',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '13px' }}>
            &gt;_ TERMINAL DE LOGS
          </span>
          <span
            style={{
              display: 'inline-block',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: '#22c55e',
              boxShadow: '0 0 8px #22c55e',
            }}
            title="Live Stream Active"
          />
          <span style={{ fontSize: '11px', color: '#64748b' }}>
            ({logs.length} evento{logs.length !== 1 ? 's' : ''})
          </span>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {!isMinimized && (
            <>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{
                  background: '#1e293b',
                  color: '#94a3b8',
                  border: '1px solid #334155',
                  borderRadius: '4px',
                  padding: '2px 6px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  outline: 'none',
                }}
              >
                <option value="all">Todos os Logs</option>
                <option value="error">Apenas Erros/Avisos</option>
                <option value="info">Apenas Infos</option>
              </select>

              <button
                onClick={copyLogsToClipboard}
                title="Copiar logs para área de transferência"
                style={{
                  background: '#1e293b',
                  color: '#94a3b8',
                  border: '1px solid #334155',
                  borderRadius: '4px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                📋 Copiar
              </button>

              <button
                onClick={onClear}
                title="Limpar terminal"
                style={{
                  background: '#1e293b',
                  color: '#f87171',
                  border: '1px solid #334155',
                  borderRadius: '4px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                🧹 Limpar
              </button>
            </>
          )}

          <button
            onClick={() => setIsMinimized(!isMinimized)}
            style={{
              background: '#1e293b',
              color: '#cbd5e1',
              border: '1px solid #334155',
              borderRadius: '4px',
              width: '24px',
              height: '24px',
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isMinimized ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* Terminal Content Stream */}
      {!isMinimized && (
        <div
          ref={logContainerRef}
          onScroll={(e) => {
            const { scrollTop, scrollHeight, clientHeight } = e.target;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
            setAutoScroll(isAtBottom);
          }}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 12px',
            fontSize: '12px',
            lineHeight: '1.6',
            color: '#e2e8f0',
          }}
        >
          {filteredLogs.length === 0 ? (
            <div style={{ color: '#475569', fontStyle: 'italic' }}>
              &gt; Nenhum log registrado até o momento. Aguardando eventos...
            </div>
          ) : (
            filteredLogs.map((log) => {
              let color = '#94a3b8';
              let badge = 'INFO';
              let badgeBg = '#1e293b';
              let badgeColor = '#38bdf8';

              if (log.type === 'error') {
                color = '#f87171';
                badge = 'ERR!';
                badgeBg = '#450a0a';
                badgeColor = '#ef4444';
              } else if (log.type === 'warn') {
                color = '#fbbf24';
                badge = 'WARN';
                badgeBg = '#451a03';
                badgeColor = '#f59e0b';
              } else if (log.type === 'success') {
                color = '#4ade80';
                badge = 'OK';
                badgeBg = '#052e16';
                badgeColor = '#22c55e';
              }

              return (
                <div
                  key={log.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    wordBreak: 'break-all',
                    margin: '2px 0',
                  }}
                >
                  <span style={{ color: '#475569', flexShrink: 0 }}>[{log.time}]</span>
                  <span
                    style={{
                      background: badgeBg,
                      color: badgeColor,
                      padding: '1px 5px',
                      borderRadius: '3px',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      letterSpacing: '0.5px',
                      flexShrink: 0,
                    }}
                  >
                    {badge}
                  </span>
                  <span style={{ color: '#64748b', flexShrink: 0 }}>&gt;</span>
                  <span style={{ color: color, flex: 1 }}>{log.msg}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
