// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

export function formatBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

export function formatElapsed(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

const EXT_ICONS = {
  jpg: '🖼️',
  jpeg: '🖼️',
  png: '🖼️',
  gif: '🖼️',
  bmp: '🖼️',
  webp: '🖼️',
  svg: '🖼️',
  ico: '🖼️',
  mp4: '🎬',
  mkv: '🎬',
  avi: '🎬',
  mov: '🎬',
  wmv: '🎬',
  webm: '🎬',
  mp3: '🎵',
  wav: '🎵',
  flac: '🎵',
  ogg: '🎵',
  m4a: '🎵',
  zip: '🗜️',
  rar: '🗜️',
  '7z': '🗜️',
  tar: '🗜️',
  gz: '🗜️',
  pdf: '📕',
  doc: '📘',
  docx: '📘',
  xls: '📗',
  xlsx: '📗',
  csv: '📗',
  ppt: '📙',
  pptx: '📙',
  exe: '⚙️',
  msi: '⚙️',
  js: '📄',
  jsx: '📄',
  ts: '📄',
  tsx: '📄',
  json: '📄',
  html: '📄',
  css: '📄',
  md: '📄',
  py: '📄',
  java: '📄',
  c: '📄',
  cpp: '📄',
  cs: '📄',
  go: '📄',
  rs: '📄',
  sh: '📄',
  ps1: '📄',
};

export function iconFor(entry) {
  if (entry.dir) return '📁';
  const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
  return EXT_ICONS[ext] || '📄';
}

export function joinVirtual(base, name) {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export function guessSep(nativePath) {
  return nativePath && nativePath.includes('\\') ? '\\' : '/';
}

export function joinNative(base, name) {
  const sep = guessSep(base);
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
}

export function sortAndFilter(entries, { query, sortBy, sortDir }) {
  const q = query.trim().toLowerCase();
  let list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice();
  const dir = sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (sortBy === 'size') return (a.size - b.size) * dir;
    if (sortBy === 'date') return ((a.mtime || 0) - (b.mtime || 0)) * dir;
    return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) * dir;
  });
  return list;
}
