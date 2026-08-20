import { useState, useEffect, useRef } from 'react';
import { formatBytes, formatDate, iconFor } from './utils';

function InlineNameInput({ initialValue, onCommit, onCancel }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const trimmed = value.trim();
          if (trimmed && trimmed !== initialValue) onCommit(trimmed);
          else onCancel();
        } else if (e.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== initialValue) onCommit(trimmed);
        else onCancel();
      }}
      className="text-[13px] px-1 py-0.5 border border-[#0067c0] rounded outline-none w-full bg-white text-[#1b1b1b]"
    />
  );
}

export function EntryList({ pane, visibleEntries, onOpen, onSelect, onRenameCommit, dnd }) {
  const listRef = useRef(null);
  const [dragOverName, setDragOverName] = useState(null);

  const headerBtn = (col, label) => (
    <button
      onClick={() => {
        if (pane.sortBy === col) pane.setSortDir(pane.sortDir === 'asc' ? 'desc' : 'asc');
        else {
          pane.setSortBy(col);
          pane.setSortDir('asc');
        }
      }}
      className="flex items-center gap-1 hover:text-[#0067c0]"
    >
      {label}
      {pane.sortBy === col && (
        <span className="text-[10px]">{pane.sortDir === 'asc' ? '▲' : '▼'}</span>
      )}
    </button>
  );

  const rowDragProps = (entry) => ({
    draggable: pane.renamingName !== entry.name,
    onDragStart: (e) => dnd.onEntryDragStart(e, entry),
    onDragOver: (e) => {
      if (!entry.dir) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = dnd.effectFor(e);
      setDragOverName(entry.name);
    },
    onDragLeave: () => setDragOverName((prev) => (prev === entry.name ? null : prev)),
    onDrop: (e) => {
      if (!entry.dir) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOverName(null);
      dnd.onDropOnFolder(e, entry);
    },
  });

  if (pane.view === 'icons') {
    return (
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto p-3 grid gap-1 content-start"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}
        onClick={() => pane.setSelected(new Set())}
      >
        {visibleEntries.map((entry, index) => (
          <div
            key={entry.name}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(entry, index, e);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpen(entry);
            }}
            className={`flex flex-col items-center gap-1 p-2 rounded cursor-default select-none ${pane.selected.has(entry.name) ? 'bg-[#cce8ff]' : dragOverName === entry.name ? 'bg-[#d5ecff] ring-1 ring-[#0067c0]' : 'hover:bg-[#f0f0f0]'}`}
            title={entry.name}
            {...rowDragProps(entry)}
          >
            <span className="text-[36px] leading-none">{iconFor(entry)}</span>
            {pane.renamingName === entry.name ? (
              <InlineNameInput
                initialValue={entry.name}
                onCommit={(v) => onRenameCommit(entry, v)}
                onCancel={() => pane.setRenamingName(null)}
              />
            ) : (
              <span className="text-[12px] text-center break-all line-clamp-2">{entry.name}</span>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="flex-1 overflow-y-auto"
      onClick={() => pane.setSelected(new Set())}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 h-8 bg-[#f3f3f3] border-b border-[#e5e5e5] text-[12px] text-[#605e5c]">
        <div className="flex-1 min-w-0">{headerBtn('name', 'Nome')}</div>
        <div className="w-32 shrink-0">{headerBtn('date', 'Modificado em')}</div>
        <div className="w-20 shrink-0 text-right">{headerBtn('size', 'Tamanho')}</div>
      </div>
      {visibleEntries.map((entry, index) => (
        <div
          key={entry.name}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(entry, index, e);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onOpen(entry);
          }}
          className={`file-row flex items-center gap-2 px-3 h-8 text-[13px] cursor-default select-none ${pane.selected.has(entry.name) ? 'bg-[#cce8ff]' : dragOverName === entry.name ? 'bg-[#d5ecff] ring-1 ring-inset ring-[#0067c0]' : ''}`}
          {...rowDragProps(entry)}
        >
          <span className="text-[16px] w-5 shrink-0 text-center">{iconFor(entry)}</span>
          {pane.renamingName === entry.name ? (
            <div className="flex-1 min-w-0">
              <InlineNameInput
                initialValue={entry.name}
                onCommit={(v) => onRenameCommit(entry, v)}
                onCancel={() => pane.setRenamingName(null)}
              />
            </div>
          ) : (
            <span className="flex-1 min-w-0 truncate text-[#1b1b1b]">{entry.name}</span>
          )}
          <span className="w-32 shrink-0 text-[12px] text-[#605e5c]">
            {formatDate(entry.mtime)}
          </span>
          <span className="w-20 shrink-0 text-[12px] text-[#605e5c] text-right">
            {entry.dir ? '' : formatBytes(entry.size)}
          </span>
        </div>
      ))}
      {visibleEntries.length === 0 && (
        <div className="flex items-center justify-center h-24 text-[13px] text-[#a19f9d]">
          Pasta vazia
        </div>
      )}
    </div>
  );
}
