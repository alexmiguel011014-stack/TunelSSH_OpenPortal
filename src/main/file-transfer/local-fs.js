'use strict';

// Helpers do lado LOCAL (a própria máquina onde o Electron main roda).
// Não passa pelo túnel: é fs/os/path direto, multiplataforma.
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function quickAccess() {
  const home = os.homedir();
  const named = {
    'Área de Trabalho': 'Desktop',
    Downloads: 'Downloads',
    Documentos: 'Documents',
    Imagens: 'Pictures',
    Vídeos: 'Videos',
  };
  const list = [{ name: 'Início', path: home }];
  for (const [ptName, enName] of Object.entries(named)) {
    const ptPath = path.join(home, ptName);
    const enPath = path.join(home, enName);
    let resolved = ptPath;
    try {
      fs.accessSync(ptPath);
    } catch {
      try {
        fs.accessSync(enPath);
        resolved = enPath;
      } catch {
        resolved = ptPath;
      }
    }
    list.push({ name: ptName, path: resolved });
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

module.exports = { listRoots, quickAccess, listDir, parentOf, walkDir, makeDir, remove, rename };
