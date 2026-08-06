'use strict';

// Caminhos "virtuais" do protocolo de arquivos.
//
// O formato de fio (wire format) trocado entre cliente e agente é SEMPRE
// estilo POSIX e SEMPRE absoluto em relação à raiz do agente: "/", "/Documentos",
// "/Documentos/nota.txt". Isso mantém o protocolo independente do sistema
// operacional das duas pontas: um cliente Windows pode falar com um agente
// Linux e vice-versa.
//
// Cada ponta converte virtual <-> nativo com `toNative` / `fromNative`, usando o
// módulo `path` do próprio SO. Nada de concatenar "\\" na mão.
//
// Compatibilidade: `toVirtual` também aceita entrada com "\" (formato antigo do
// protocolo), então agentes/clientes de versões anteriores continuam funcionando
// durante o rollout.

const path = require('path');

const WIN32 = process.platform === 'win32';

// Normaliza qualquer entrada para o caminho virtual canônico ("/a/b").
// Resolve "." e ".." textualmente e descarta separadores redundantes.
function toVirtual(input) {
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

function segments(virtualPath) {
  return toVirtual(virtualPath).split('/').filter(Boolean);
}

function join(base, ...parts) {
  return toVirtual([base, ...parts].join('/'));
}

function parent(virtualPath) {
  const segs = segments(virtualPath);
  segs.pop();
  return '/' + segs.join('/');
}

function basename(virtualPath) {
  const segs = segments(virtualPath);
  return segs.length ? segs[segs.length - 1] : '';
}

function isRoot(virtualPath) {
  return segments(virtualPath).length === 0;
}

// Migalhas de pão do caminho virtual: [{ name, path }] a partir da raiz.
function crumbs(virtualPath) {
  const out = [];
  let acc = '';
  for (const name of segments(virtualPath)) {
    acc += '/' + name;
    out.push({ name, path: acc });
  }
  return out;
}

// Um componente de caminho precisa ser um nome simples. Rejeita separadores,
// "." / "..", NUL e (no Windows) ":" — que permitiria escapar via caminho
// relativo a drive ("C:pasta") ou alternate data streams ("arq:stream").
function isSafeName(name) {
  const n = name === null || name === undefined ? '' : String(name);
  if (!n || n === '.' || n === '..') return false;
  if (n.includes('/') || n.includes('\\') || n.includes('\0')) return false;
  if (WIN32 && n.includes(':')) return false;
  return true;
}

// Converte virtual -> nativo dentro de `rootDir`, garantindo que o resultado
// não escape da raiz. `path.relative` funciona mesmo quando a raiz é um drive
// ("C:\") e cobre symlink-free traversal por "..".
function toNative(rootDir, virtualPath) {
  const rootResolved = path.resolve(rootDir);
  const segs = segments(virtualPath);
  for (const seg of segs) {
    if (!isSafeName(seg)) {
      throw new Error(`Componente de caminho invalido: ${JSON.stringify(seg)}`);
    }
  }
  const full = segs.length ? path.resolve(rootResolved, ...segs) : rootResolved;
  const rel = path.relative(rootResolved, full);
  if (rel && (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep))) {
    throw new Error('Access denied: path outside root directory');
  }
  return full;
}

// Converte nativo -> virtual. Fora da raiz retorna "/" (nunca vaza caminho real).
function fromNative(rootDir, nativePath) {
  const rootResolved = path.resolve(rootDir);
  const rel = path.relative(rootResolved, path.resolve(nativePath));
  if (!rel) return '/';
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) return '/';
  return toVirtual(rel.split(path.sep).join('/'));
}

// --- Helpers para caminhos NATIVOS locais (painel "Este Computador") ---------
// O renderer nunca monta caminho local na mão: pede estes dados ao main.

// Migalhas de pão nativas: [{ name, path }], começando pela raiz do volume.
// Windows: "C:" -> "C:\Users" -> ... | POSIX: "/" -> "/home" -> ...
function nativeCrumbs(inputPath) {
  const full = path.resolve(inputPath);
  const root = path.parse(full).root;
  const rest = full.slice(root.length);
  const rootLabel = root.replace(/[\\/]+$/, '') || path.sep;
  const out = [{ name: rootLabel, path: root }];
  let acc = root;
  for (const part of rest.split(path.sep).filter(Boolean)) {
    acc = path.join(acc, part);
    out.push({ name: part, path: acc });
  }
  return out;
}

// Diretório pai nativo, ou null quando já está na raiz do volume.
function nativeParent(inputPath) {
  const full = path.resolve(inputPath);
  const up = path.dirname(full);
  return up === full ? null : up;
}

module.exports = {
  toVirtual,
  segments,
  join,
  parent,
  basename,
  isRoot,
  crumbs,
  isSafeName,
  toNative,
  fromNative,
  nativeCrumbs,
  nativeParent,
};
