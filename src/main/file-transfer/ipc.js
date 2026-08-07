'use strict';

// IPC do módulo de transferência de arquivos: expõe o painel local (fs
// direto) e o painel remoto (via túnel — ver tunnel-manager.js) ao
// renderer, e roda a fila de lote (upload/download em massa) sequencial
// com progresso por arquivo e por lote.
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const localFs = require('./local-fs');
const tunnelManager = require('./tunnel-manager');

function send(mainWindow, channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function joinVirtual(baseDir, name) {
  return baseDir === '/' ? `/${name}` : `${baseDir}/${name}`;
}

async function expandLocalUploadJobs(localPaths, destDir) {
  const jobs = [];
  for (const localPath of localPaths) {
    const st = await fs.promises.stat(localPath);
    const baseName = path.basename(localPath);
    const remoteBase = joinVirtual(destDir, baseName);
    if (st.isDirectory()) {
      jobs.push({ kind: 'dir', remotePath: remoteBase });
      const entries = await localFs.walkDir(localPath);
      for (const entry of entries) {
        const remotePath = `${remoteBase}/${entry.segments.join('/')}`;
        if (entry.dir) jobs.push({ kind: 'dir', remotePath });
        else jobs.push({ kind: 'file', remotePath, nativePath: entry.nativePath, size: entry.size });
      }
    } else {
      jobs.push({ kind: 'file', remotePath: remoteBase, nativePath: localPath, size: st.size });
    }
  }
  return jobs;
}

async function expandRemoteDownloadJobs(client, remotePaths, destDir) {
  const jobs = [];
  for (const remotePath of remotePaths) {
    const info = await client.stat(remotePath);
    const baseName = remotePath.split('/').filter(Boolean).pop() || remotePath;
    const localBase = path.join(destDir, baseName);
    if (info.dir) {
      jobs.push({ kind: 'dir', localPath: localBase });
      const entries = await client.walkRemote(remotePath);
      for (const entry of entries) {
        const localPath = path.join(localBase, ...entry.segments);
        if (entry.dir) jobs.push({ kind: 'dir', localPath });
        else jobs.push({ kind: 'file', localPath, remotePath: entry.virtualPath, size: entry.size });
      }
    } else {
      jobs.push({ kind: 'file', localPath: localBase, remotePath, size: info.size });
    }
  }
  return jobs;
}

function makeEmitter(mainWindow, batchId, phase, batchTotal) {
  const startedAt = Date.now();
  let batchSent = 0;
  return {
    setBatchSent: (v) => { batchSent = v; },
    getBatchSent: () => batchSent,
    emit: (extra) => {
      const elapsedMs = Date.now() - startedAt;
      send(mainWindow, 'ft:progress', {
        batchId,
        phase,
        batchTotal,
        batchSent,
        elapsedMs,
        speedBps: elapsedMs > 0 ? Math.round((batchSent / elapsedMs) * 1000) : 0,
        ...extra,
      });
    },
  };
}

async function runUploadBatch(mainWindow, sessionId, jobs, batchId) {
  const client = tunnelManager.getClient(sessionId);
  const fileJobs = jobs.filter((j) => j.kind === 'file');
  const batchTotal = fileJobs.reduce((sum, j) => sum + j.size, 0);
  const tracker = makeEmitter(mainWindow, batchId, 'upload', batchTotal);
  let ok = 0;
  let failed = 0;

  for (const job of jobs) {
    if (job.kind === 'dir') {
      try {
        await client.mkdir(job.remotePath);
      } catch (err) {
        failed++;
        tracker.emit({ fileName: job.remotePath, error: err.message });
      }
      continue;
    }

    const fileName = path.basename(job.nativePath);
    try {
      await client.uploadFromFile(job.nativePath, job.remotePath, ({ sent, total }) => {
        tracker.emit({ fileName, fileSent: sent, fileSize: total, batchSent: tracker.getBatchSent() + sent });
      });
      tracker.setBatchSent(tracker.getBatchSent() + job.size);
      ok++;
      tracker.emit({ fileName, fileSent: job.size, fileSize: job.size, fileDone: true });
    } catch (err) {
      failed++;
      tracker.emit({ fileName, error: err.message });
    }
  }

  tracker.emit({ done: true, ok, failed });
  return { ok, failed };
}

async function runDownloadBatch(mainWindow, sessionId, jobs, batchId) {
  const client = tunnelManager.getClient(sessionId);
  const fileJobs = jobs.filter((j) => j.kind === 'file');
  const batchTotal = fileJobs.reduce((sum, j) => sum + j.size, 0);
  const tracker = makeEmitter(mainWindow, batchId, 'download', batchTotal);
  let ok = 0;
  let failed = 0;

  for (const job of jobs) {
    if (job.kind === 'dir') {
      try {
        await fs.promises.mkdir(job.localPath, { recursive: true });
      } catch (err) {
        failed++;
        tracker.emit({ fileName: job.localPath, error: err.message });
      }
      continue;
    }

    const fileName = path.basename(job.localPath);
    try {
      await client.downloadToFile(job.remotePath, job.localPath, ({ received, total }) => {
        tracker.emit({ fileName, fileSent: received, fileSize: total, batchSent: tracker.getBatchSent() + received });
      });
      tracker.setBatchSent(tracker.getBatchSent() + job.size);
      ok++;
      tracker.emit({ fileName, fileSent: job.size, fileSize: job.size, fileDone: true });
    } catch (err) {
      failed++;
      tracker.emit({ fileName, error: err.message });
    }
  }

  tracker.emit({ done: true, ok, failed });
  return { ok, failed };
}

function registerFileTransferIpc(mainWindow) {
  // --- Painel local (fs direto, sem túnel) ---
  ipcMain.handle('fs:listRoots', () => ({
    roots: localFs.listRoots(),
    quickAccess: localFs.quickAccess(),
  }));

  ipcMain.handle('fs:listDir', async (_, dirPath) => ({ entries: await localFs.listDir(dirPath) }));

  ipcMain.handle('fs:parent', (_, dirPath) => ({ parent: localFs.parentOf(dirPath) }));

  ipcMain.handle('fs:mkdir', async (_, dirPath) => {
    try {
      await localFs.makeDir(dirPath);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('fs:delete', async (_, itemPath) => {
    try {
      await localFs.remove(itemPath);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('fs:rename', async (_, oldPath, newPath) => {
    try {
      await localFs.rename(oldPath, newPath);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // Cópia de arquivo/pasta externo (drag&drop vindo do Explorer do Windows)
  // para dentro do painel local — não passa pelo túnel.
  ipcMain.handle('fs:copyExternal', async (_, srcPaths, destDir) => {
    let ok = 0;
    const errors = [];
    for (const src of srcPaths) {
      try {
        await localFs.copyInto(src, destDir);
        ok++;
      } catch (err) {
        errors.push(`${path.basename(src)}: ${err.message}`);
      }
    }
    return { success: errors.length === 0, ok, failed: errors.length, errors };
  });

  // --- Túnel (painel remoto) ---
  ipcMain.handle('ft:connect', async (_, host, opts) => {
    try {
      send(mainWindow, 'ft:status', { host, state: 'connecting' });
      const res = await tunnelManager.connect(host, opts || {});
      send(mainWindow, 'ft:status', { host, state: 'connected', sessionId: res.sessionId });
      return { success: true, sessionId: res.sessionId, reused: res.reused };
    } catch (err) {
      send(mainWindow, 'ft:status', { host, state: 'error', message: err.message });
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('ft:disconnect', (_, sessionId) => {
    tunnelManager.disconnect(sessionId);
    send(mainWindow, 'ft:status', { sessionId, state: 'disconnected' });
    return { success: true };
  });

  ipcMain.handle('ft:list', async (_, sessionId, virtualPath) => {
    const entries = await tunnelManager.getClient(sessionId).list(virtualPath);
    return { entries };
  });

  ipcMain.handle('ft:stat', async (_, sessionId, virtualPath) => {
    return tunnelManager.getClient(sessionId).stat(virtualPath);
  });

  ipcMain.handle('ft:mkdir', async (_, sessionId, virtualPath) => {
    return tunnelManager.getClient(sessionId).mkdir(virtualPath);
  });

  ipcMain.handle('ft:delete', async (_, sessionId, virtualPath) => {
    return tunnelManager.getClient(sessionId).remove(virtualPath);
  });

  ipcMain.handle('ft:rename', async (_, sessionId, virtualPath, newVirtualPath) => {
    return tunnelManager.getClient(sessionId).rename(virtualPath, newVirtualPath);
  });

  // --- Lote (upload/download em massa, sequencial, com progresso) ---
  ipcMain.handle('ft:uploadBatch', async (_, sessionId, { localPaths, destDir, batchId }) => {
    try {
      const jobs = await expandLocalUploadJobs(localPaths, destDir);
      const result = await runUploadBatch(mainWindow, sessionId, jobs, batchId);
      return { success: true, ...result };
    } catch (err) {
      send(mainWindow, 'ft:progress', { batchId, phase: 'upload', done: true, ok: 0, failed: localPaths.length, error: err.message });
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('ft:downloadBatch', async (_, sessionId, { remotePaths, destDir, batchId }) => {
    try {
      const client = tunnelManager.getClient(sessionId);
      const jobs = await expandRemoteDownloadJobs(client, remotePaths, destDir);
      const result = await runDownloadBatch(mainWindow, sessionId, jobs, batchId);
      return { success: true, ...result };
    } catch (err) {
      send(mainWindow, 'ft:progress', { batchId, phase: 'download', done: true, ok: 0, failed: remotePaths.length, error: err.message });
      return { success: false, message: err.message };
    }
  });
}

module.exports = { registerFileTransferIpc };
