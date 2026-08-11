'use strict';

// Helpers do lado LOCAL (a própria máquina onde o Electron main roda).
// Não passa pelo túnel: é fs/os/path direto, multiplataforma.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

function listRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const drivePath = `${letter}:\\`;
      try {
        fs.accessSync(drivePath);
        roots.push({ name: `${letter}:`, path: drivePath });
      } catch {}
    }
    return roots;
  }

  const roots = [{ name: '/', path: '/' }];
  const mountBases = ['/Volumes', '/media', '/run/media', '/mnt'];
  for (const base of mountBases) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (base === '/media' || base === '/run/media') {
        const userDir = path.join(base, entry.name);
        try {
          const subEntries = fs.readdirSync(userDir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory()) roots.push({ name: sub.name, path: path.join(userDir, sub.name) });
          }
        } catch {}
      } else {
        roots.push({ name: entry.name, path: path.join(base, entry.name) });
      }
    }
  }
  return roots;
}

// Usa as pastas especiais do próprio Windows (via Electron app.getPath),
// não um "chute" de home + nome fixo — isso é o que faz funcionar mesmo
// quando o OneDrive redireciona Área de Trabalho/Documentos/Imagens/Vídeos
// para dentro de "OneDrive\..." em vez do perfil puro. Adivinhar o caminho
// (como antes) causava tanto pasta errada quanto ENOENT.
function quickAccess() {
  const home = os.homedir();
  const named = [
    ['Área de Trabalho', 'desktop'],
    ['Downloads', 'downloads'],
    ['Documentos', 'documents'],
    ['Imagens', 'pictures'],
    ['Vídeos', 'videos'],
  ];
  const list = [{ name: 'Início', path: home }];
  for (const [label, electronName] of named) {
    try {
      const resolved = app.getPath(electronName);
      if (resolved && fs.existsSync(resolved)) {
        list.push({ name: label, path: resolved });
      }
    } catch {
      // pasta especial indisponível nesta plataforma/perfil — só omite do
      // acesso rápido em vez de expor um caminho que não existe
    }
  }
  return list;
}

async function listDir(dirPath) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      const st = await fs.promises.stat(full);
      items.push({
        name: entry.name,
        path: full,
        dir: entry.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      // item pode ter sido removido/permissão negada entre o readdir e o stat
    }
  }
  return items;
}

function parentOf(dirPath) {
  const parent = path.dirname(dirPath);
  return parent === dirPath ? null : parent;
}

function makeDir(dirPath) {
  return fs.promises.mkdir(dirPath, { recursive: true });
}

function remove(itemPath) {
  return fs.promises.rm(itemPath, { recursive: true, force: true });
}

function rename(oldPath, newPath) {
  return fs.promises.rename(oldPath, newPath);
}

// Copia um arquivo/pasta externo (ex.: arrastado do Explorer do Windows)
// para dentro de destDir, mantendo o nome original. Usado pelo drag&drop.
async function copyInto(srcPath, destDir) {
  const baseName = path.basename(srcPath);
  const dest = path.join(destDir, baseName);
  await fs.promises.cp(srcPath, dest, { recursive: true });
  return dest;
}

// Percorre uma árvore local e devolve uma lista plana de segmentos relativos
// (nunca string com separador), para reconstrução multiplataforma no destino.
async function walkDir(rootPath) {
  const out = [];

  async function walk(current, relSegments) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    if (entries.length === 0 && relSegments.length > 0) {
      out.push({ segments: relSegments, dir: true, size: 0 });
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const segments = [...relSegments, entry.name];
      if (entry.isDirectory()) {
        out.push({ segments, dir: true, size: 0 });
        await walk(full, segments);
      } else {
        const st = await fs.promises.stat(full);
        out.push({ segments, dir: false, size: st.size, nativePath: full });
      }
    }
  }

  await walk(rootPath, []);
  return out;
}

module.exports = { listRoots, quickAccess, listDir, parentOf, walkDir, makeDir, remove, rename, copyInto };
