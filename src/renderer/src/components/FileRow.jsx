import { getFileIcon } from '../lib/fileIcons';

const formatSize = (bytes) => {
  if (!bytes || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
};

const formatDate = (iso) => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
  } catch {
    return '';
  }
};

function FileRow({ entry, index, isSelected, selectable, onToggleSelect, onClick, onOpen }) {
  const fileIcon = getFileIcon(entry.n, entry.d);

  return (
    <div
      className="file-row"
      style={{
        display: 'flex', alignItems: 'center', padding: '7px 12px', gap: '10px',
        cursor: 'pointer', borderBottom: '1px solid #1e293b',
        background: isSelected ? 'rgba(59,130,246,0.18)' : 'transparent',
        color: entry.d ? '#e2e8f0' : '#cbd5e1',
        borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
        userSelect: 'none',
        transition: 'background 0.1s',
      }}
      onClick={(e) => {
        if (!selectable) {
          if (onClick) onClick(e);
          return;
        }
        onToggleSelect(index, e);
      }}
      onDoubleClick={() => {
        if (entry.d && onOpen) onOpen(entry);
      }}
    >
      {selectable && (
        <span style={{ width: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <input
            type="checkbox"
            checked={!!isSelected}
            onChange={() => {}}
            style={{ cursor: 'pointer', accentColor: '#3b82f6', margin: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(index, { ctrlKey: false, metaKey: false, onlyToggle: true });
            }}
          />
        </span>
      )}
      <span style={{ width: '22px', textAlign: 'center', fontSize: '18px', lineHeight: 1 }}>
        {fileIcon.icon}
      </span>
      <span
        style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px',
          fontWeight: entry.d ? 600 : 400,
        }}
        title={entry.n}
      >
        {entry.n}
      </span>
      <span style={{ width: '80px', textAlign: 'right', color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap' }}>
        {entry.d ? '' : formatSize(entry.s)}
      </span>
      <span style={{ width: '140px', textAlign: 'right', color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap' }}>
        {formatDate(entry.m)}
      </span>
    </div>
  );
}

export default FileRow;