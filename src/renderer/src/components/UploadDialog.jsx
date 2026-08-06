import { useState } from 'react';

const btn = {
  padding: '6px 14px', borderRadius: '6px', border: '1px solid #475569',
  cursor: 'pointer', fontSize: '13px',
};

function UploadDialog({ title, initialPath, onConfirm, onCancel, multiple }) {
  const [path, setPath] = useState(initialPath || '');
  const trimmed = path.trim().replace(/\\+$/, '');
  const hasPath = trimmed.length > 0;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          width: 480, background: '#1e293b', borderRadius: '10px', border: '1px solid #334155',
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '6px 16px', background: '#0f172a', borderBottom: '1px solid #334155', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#94a3b8' }}>
          {title}
        </div>
        <div style={{ padding: '18px 16px' }}>
          <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>
            Caminho de destino no computador remoto
          </div>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
            placeholder={multiple ? 'Ex.: D:\\Documentos\\PastaNova' : 'Ex.: D:\\Documentos\\arquivo.txt'}
            onKeyDown={(e) => { if (e.key === 'Enter' && hasPath) onConfirm(trimmed); }}
            style={{
              width: '100%', padding: '9px 12px', borderRadius: '6px',
              border: '1px solid #475569', background: '#0f172a', color: '#e2e8f0',
              fontSize: '13px', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '8px', lineHeight: 1.5 }}>
            {multiple
              ? 'Os itens selecionados serão colocados nesta pasta do remoto.'
              : 'O arquivo será salvo com este caminho no computador remoto.'}
          </div>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid #334155', background: '#0f172a' }}>
          <button onClick={onCancel} style={{ ...btn, background: '#1e293b', color: '#cbd5e1' }}>Cancelar</button>
          <button
            onClick={() => { if (hasPath) onConfirm(trimmed); }}
            style={{
              ...btn, background: hasPath ? '#2563eb' : '#1e293b',
              borderColor: hasPath ? '#3b82f6' : '#475569',
              color: hasPath ? '#fff' : '#64748b', fontWeight: 600,
            }}
          >Enviar</button>
        </div>
      </div>
    </div>
  );
}

export default UploadDialog;