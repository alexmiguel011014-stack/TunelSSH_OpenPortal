// Caminhos do painel REMOTO.
//
// O protocolo usa caminhos virtuais estilo POSIX, sempre absolutos em relação à
// raiz do agente ("/", "/Documentos/nota.txt"). Como o formato é fixo, a UI pode
// manipulá-los com segurança sem saber o SO do outro lado — quem traduz para
// "C:\Users\..." ou "/home/..." é o agente.
//
// Caminhos LOCAIS nunca são montados aqui: o main process devolve `p` (absoluto),
// `parent` e `crumbs` prontos em `listLocalDir` / `getPathInfo`.

export function toVirtual(input) {
  if (input === null || input === undefined) return '/';
  const raw = String(input).trim();
  if (!raw) return '/';
  const segs = [];
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { segs.pop(); continue; }
    segs.push(part);
  }
  return '/' + segs.join('/');
}

export function segments(virtualPath) {
  return toVirtual(virtualPath).split('/').filter(Boolean);
}

export function joinVirtual(base, ...parts) {
  return toVirtual([base, ...parts].join('/'));
}

export function parentOf(virtualPath) {
  const segs = segments(virtualPath);
  segs.pop();
  return '/' + segs.join('/');
}

export function baseName(virtualPath) {
  const segs = segments(virtualPath);
  return segs.length ? segs[segs.length - 1] : '';
}

export function isRoot(virtualPath) {
  return segments(virtualPath).length === 0;
}

// Migalhas de pão do painel remoto: [{ name, path }] a partir da raiz.
export function virtualCrumbs(virtualPath) {
  const out = [];
  let acc = '';
  for (const name of segments(virtualPath)) {
    acc += '/' + name;
    out.push({ name, path: acc });
  }
  return out;
}

// --- Formatação ------------------------------------------------------------

export function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = n;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}
