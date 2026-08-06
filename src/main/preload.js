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
  getLocalIp: () => ipcRenderer.invoke('server:localIp'),

  // Connection request (Conectar por IP)
  requestConnection: (host, opts) => ipcRenderer.invoke('connect:request', host, opts),

  checkForUpdates: () => ipcRenderer.invoke('app:checkUpdate'),

  notify: (opts) => ipcRenderer.invoke('app:notify', opts),

  testConnection: (host, port) => ipcRenderer.invoke('net:test', { host, port }),
});
