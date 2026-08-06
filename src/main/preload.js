const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  getLocalIp: () => ipcRenderer.invoke('server:localIp'),

  // Connection request (Conectar por IP)
  requestConnection: (host, opts) => ipcRenderer.invoke('connect:request', host, opts),

  // --- File transfer -------------------------------------------------------
  // Caminhos remotos são sempre virtuais estilo POSIX ("/", "/Documentos/a.txt").
  // Caminhos locais são sempre nativos do SO e vêm prontos do main.
  ftConnect: (host, port, opts) => ipcRenderer.invoke('ft:connect', host, port, opts),
  ftDisconnect: (sessionId) => ipcRenderer.invoke('ft:disconnect', sessionId),
  ftInfo: () => ipcRenderer.invoke('ft:info'),
  ftList: (path) => ipcRenderer.invoke('ft:list', path),
  ftStat: (path) => ipcRenderer.invoke('ft:stat', path),
  ftDownload: (remotePath, options) => ipcRenderer.invoke('ft:download', remotePath, options),
  ftUpload: (remotePath, options) => ipcRenderer.invoke('ft:upload', remotePath, options),
  ftUploadFolder: (localPath, remoteParent) => ipcRenderer.invoke('ft:uploadFolder', localPath, remoteParent),
  ftDownloadFolder: (remotePath, localRoot, options) => ipcRenderer.invoke('ft:downloadFolder', remotePath, localRoot, options),
  ftDelete: (remotePath) => ipcRenderer.invoke('ft:delete', remotePath),
  ftMkdir: (remotePath) => ipcRenderer.invoke('ft:mkdir', remotePath),

  onFtProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ft:progress', handler);
    return () => ipcRenderer.removeListener('ft:progress', handler);
  },

  onFtStatus: (callback) => {
    const handler = (_, status) => callback(status);
    ipcRenderer.on('ft:status', handler);
    return () => ipcRenderer.removeListener('ft:status', handler);
  },

  checkForUpdates: () => ipcRenderer.invoke('app:checkUpdate'),

  notify: (opts) => ipcRenderer.invoke('app:notify', opts),

  testConnection: (host, port) => ipcRenderer.invoke('net:test', { host, port }),

  showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  readLocalFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeLocalFile: (filePath, data) => ipcRenderer.invoke('fs:writeFile', filePath, data),
  statLocal: (filePath) => ipcRenderer.invoke('fs:stat', filePath),

  // --- Navegação local (multiplataforma) -----------------------------------
  // getRoots: drives no Windows, "/" + volumes montados no Linux/macOS.
  // getQuickAccess: Início / Área de Trabalho / Downloads / Documentos
  //   resolvidos pelo Electron, respeitando pastas localizadas.
  // pathInfo: pai, migalhas de pão e separador de um caminho local.
  // listLocalDir: entradas + navegação pronta, sem concatenar caminho na UI.
  joinPath: (base, ...parts) => ipcRenderer.invoke('fs:joinPath', base, ...parts),
  getRoots: () => ipcRenderer.invoke('fs:getRoots'),
  getQuickAccess: () => ipcRenderer.invoke('fs:getQuickAccess'),
  getPathInfo: (dirPath) => ipcRenderer.invoke('fs:pathInfo', dirPath),
  getHomeDir: () => ipcRenderer.invoke('fs:getHomeDir'),
  listLocalDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),

  // Compatibilidade com a API anterior.
  getDrives: () => ipcRenderer.invoke('fs:getDrives'),
  getSpecialDirs: () => ipcRenderer.invoke('fs:getSpecialDirs'),
});
