const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Electron 32+ com contextIsolation não expõe mais File.path direto;
  // precisa passar o File pelo webUtils no preload para pegar o caminho real.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  connectVnc: (machine) => ipcRenderer.invoke('vnc:connect', machine),
  disconnectVnc: () => ipcRenderer.invoke('vnc:disconnect'),
  getProxyUrl: () => ipcRenderer.invoke('vnc:proxyUrl'),

  onVncStatus: (callback) => {
    const handler = (_, status) => callback(status);
    ipcRenderer.on('vnc:status', handler);
    return () => ipcRenderer.removeListener('vnc:status', handler);
  },

  getVersion: () => ipcRenderer.invoke('app:version'),

  // Server/Agent status
  getLocalIp: () => ipcRenderer.invoke('server:localIp'),

  checkForUpdates: () => ipcRenderer.invoke('app:checkUpdate'),

  notify: (opts) => ipcRenderer.invoke('app:notify', opts),

  testConnection: (host, port) => ipcRenderer.invoke('net:test', { host, port }),

  // Transferência de arquivos — painel local (fs direto nesta máquina)
  fsListRoots: () => ipcRenderer.invoke('fs:listRoots'),
  fsListDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
  fsParent: (dirPath) => ipcRenderer.invoke('fs:parent', dirPath),
  fsMkdir: (dirPath) => ipcRenderer.invoke('fs:mkdir', dirPath),
  fsDelete: (itemPath) => ipcRenderer.invoke('fs:delete', itemPath),
  fsRename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  fsCopyExternal: (srcPaths, destDir) => ipcRenderer.invoke('fs:copyExternal', srcPaths, destDir),

  // Transferência de arquivos — painel remoto (túnel multiplexado)
  ftConnect: (host, opts) => ipcRenderer.invoke('ft:connect', host, opts),
  ftDisconnect: (sessionId) => ipcRenderer.invoke('ft:disconnect', sessionId),
  ftList: (sessionId, virtualPath) => ipcRenderer.invoke('ft:list', sessionId, virtualPath),
  ftStat: (sessionId, virtualPath) => ipcRenderer.invoke('ft:stat', sessionId, virtualPath),
  ftMkdir: (sessionId, virtualPath) => ipcRenderer.invoke('ft:mkdir', sessionId, virtualPath),
  ftDelete: (sessionId, virtualPath) => ipcRenderer.invoke('ft:delete', sessionId, virtualPath),
  ftRename: (sessionId, virtualPath, newVirtualPath) => ipcRenderer.invoke('ft:rename', sessionId, virtualPath, newVirtualPath),
  ftUploadBatch: (sessionId, payload) => ipcRenderer.invoke('ft:uploadBatch', sessionId, payload),
  ftDownloadBatch: (sessionId, payload) => ipcRenderer.invoke('ft:downloadBatch', sessionId, payload),

  onFtStatus: (callback) => {
    const handler = (_, status) => callback(status);
    ipcRenderer.on('ft:status', handler);
    return () => ipcRenderer.removeListener('ft:status', handler);
  },
  onFtProgress: (callback) => {
    const handler = (_, progress) => callback(progress);
    ipcRenderer.on('ft:progress', handler);
    return () => ipcRenderer.removeListener('ft:progress', handler);
  },
});
