import { getFileIcon } from './lib/fileIcons';
import { formatSize, formatDate } from './lib/paths';

// Linha da tabela de arquivos. A seleção é identificada pelo NOME da entrada
// (não pelo índice), então ordenar, filtrar ou atualizar a pasta não faz a
// seleção apontar para outro arquivo.
function FileRow({ entry, selected, onToggle, onOpen }) {
  const fileIcon = getFileIcon(entry.n, entry.d);

  return (
    <div
      className="file-row"
      style={{
        display: 'flex', alignItems: 'center', padding: '6px 10px', gap: '10px',
        cursor: 'pointer', borderBottom: '1px solid #1e293b',
        background: selected ? 'rgba(59,130,246,0.18)' : 'transparent',
        color: entry.d ? '#e2e8f0' : '#cbd5e1',
        borderLeft: selected ? '3px solid #3b82f6' : '3px solid transparent',
        userSelect: 'none',
        transition: 'background 0.1s',
      }}
      onClick={(e) => onToggle(entry, { additive: e.ctrlKey || e.metaKey })}
      onDoubleClick={() => { if (entry.d) onOpen(entry); }}
      title={entry.d ? `${entry.n} (duplo clique para abrir)` : entry.n}
    >
      <span style={{ width: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => {}}
          style={{ cursor: 'pointer', accentColor: '#3b82f6', margin: 0 }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(entry, { additive: true });
          }}
        />
      </span>
      <span style={{ width: '22px', textAlign: 'center', fontSize: '17px', lineHeight: 1 }}>
        {fileIcon.icon}
      </span>
      <span
        style={{
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', fontSize: '13px', fontWeight: entry.d ? 600 : 400,
        }}
      >
        {entry.n}
      </span>
      <span style={{ width: '78px', textAlign: 'right', color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap' }}>
        {entry.d ? '—' : formatSize(entry.s)}
      </span>
      <span style={{ width: '130px', textAlign: 'right', color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap' }}>
        {formatDate(entry.m)}
      </span>
    </div>
  );
}

export default FileRow;
