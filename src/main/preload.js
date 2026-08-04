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

  // File transfer API
  ftConnect: (host, port) => ipcRenderer.invoke('ft:connect', host, port),
  ftDisconnect: () => ipcRenderer.invoke('ft:disconnect'),
  ftList: (path) => ipcRenderer.invoke('ft:list', path),
  ftDownload: (remotePath, options) => ipcRenderer.invoke('ft:download', remotePath, options),
  ftUpload: (remotePath, options) => ipcRenderer.invoke('ft:upload', remotePath, options),
  ftUploadFolder: (localPath, remoteParent) => ipcRenderer.invoke('ft:uploadFolder', localPath, remoteParent),
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

  showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  readLocalFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeLocalFile: (filePath, data) => ipcRenderer.invoke('fs:writeFile', filePath, data),
  statLocal: (filePath) => ipcRenderer.invoke('fs:stat', filePath),

  // Local file system browsing
  getHomeDir: () => ipcRenderer.invoke('fs:getHomeDir'),
  getDrives: () => ipcRenderer.invoke('fs:getDrives'),
  getSpecialDirs: () => ipcRenderer.invoke('fs:getSpecialDirs'),
  listLocalDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
});
