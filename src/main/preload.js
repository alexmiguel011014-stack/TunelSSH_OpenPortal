const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Electron 32+ com contextIsolation não expõe mais File.path direto;
  // precisa passar o File pelo webUtils no preload para pegar o caminho real.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistoryEntry: (entry) => ipcRenderer.invoke('history:add', entry),

  connectVnc: (machine) => ipcRenderer.invoke('vnc:connect', machine),
  disconnectVnc: (machineId) => ipcRenderer.invoke('vnc:disconnect', machineId),
  getVncCredential: (machineId) => ipcRenderer.invoke('vnc:getCredential', machineId),
  setVncCredential: (machineId, password) =>
    ipcRenderer.invoke('vnc:setCredential', { machineId, password }),
  getProxyUrl: () => ipcRenderer.invoke('vnc:proxyUrl'),

  onVncStatus: (callback) => {
    const handler = (_, status) => callback(status);
    ipcRenderer.on('vnc:status', handler);
    return () => ipcRenderer.removeListener('vnc:status', handler);
  },

  // RDP nativo (GOALS 2) — sidecar C#/MSTSCLib reparented sobre um <div>
  // posicionado pelo renderer (ver RdpViewer.jsx). rect é sempre em pixels
  // físicos (já multiplicado por devicePixelRatio), pois SetWindowPos do lado
  // Win32 não conhece pixels lógicos do DOM.
  startRdp: (machine, rect, lifecycleId) =>
    ipcRenderer.invoke('rdp:start', { machine, rect, lifecycleId }),
  resizeRdp: (machineId, rect, lifecycleId) =>
    ipcRenderer.invoke('rdp:resize', { machineId, rect, lifecycleId }),
  setRdpVisible: (machineId, visible, lifecycleId) =>
    ipcRenderer.invoke('rdp:setVisible', { machineId, visible, lifecycleId }),
  stopRdp: (machineId, lifecycleId = null) =>
    ipcRenderer.invoke('rdp:stop', { machineId, lifecycleId }),
  onRdpStatus: (callback) => {
    const handler = (_, status) => callback(status);
    ipcRenderer.on('rdp:status', handler);
    return () => ipcRenderer.removeListener('rdp:status', handler);
  },

  // Provisionamento de hospedagem RDP nesta máquina (manual, uma vez por PC)
  enableRdpHosting: () => ipcRenderer.invoke('rdp:enableHosting'),
  createRdpCredential: (username, password) =>
    ipcRenderer.invoke('rdp:createCredential', { username, password }),
  generateRdpPassword: () => ipcRenderer.invoke('rdp:generatePassword'),

  // Modo laboratório (GOALS 16) — lista de PCs do gerente, matrícula, quem gerencia
  // este PC e "Iniciar com o Windows".
  getLabRoster: () => ipcRenderer.invoke('lab:roster'),
  addLabPc: (host) => ipcRenderer.invoke('lab:add', host),
  removeLabPc: (hostId) => ipcRenderer.invoke('lab:remove', hostId),
  openLabPc: (hostId) => ipcRenderer.invoke('lab:open', hostId),
  onLabStatus: (callback) => {
    const handler = (_, roster) => callback(roster);
    ipcRenderer.on('lab:status', handler);
    return () => ipcRenderer.removeListener('lab:status', handler);
  },
  getLabManagers: () => ipcRenderer.invoke('lab:managers'),
  removeLabManager: (login) => ipcRenderer.invoke('lab:removeManager', login),
  onLabHostChanged: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('lab:hostChanged', handler);
    return () => ipcRenderer.removeListener('lab:hostChanged', handler);
  },
  getStartWithWindows: () => ipcRenderer.invoke('lab:getStartWithWindows'),
  setStartWithWindows: (enabled) => ipcRenderer.invoke('lab:setStartWithWindows', enabled),
  getLabServiceState: () => ipcRenderer.invoke('lab:serviceState'),
  enableLabService: (options) => ipcRenderer.invoke('lab:enableService', options),
  disableLabService: () => ipcRenderer.invoke('lab:disableService'),
  // GOALS 18: alunos, reserva, troca de aluno e pasta de um PC de laboratório.
  getLabStudents: (hostId) => ipcRenderer.invoke('lab:students', hostId),
  addLabStudent: (payload) => ipcRenderer.invoke('lab:studentAdd', payload),
  setLabStudentQuota: (payload) => ipcRenderer.invoke('lab:studentQuota', payload),
  deleteLabStudent: (payload) => ipcRenderer.invoke('lab:studentDelete', payload),
  reserveLabPc: (payload) => ipcRenderer.invoke('lab:reserve', payload),
  handOverLabPc: (payload) => ipcRenderer.invoke('lab:handOver', payload),
  extendLabReservation: (payload) => ipcRenderer.invoke('lab:extend', payload),
  endLabReservation: (payload) => ipcRenderer.invoke('lab:end', payload),
  openLabFolder: (payload) => ipcRenderer.invoke('lab:folder', payload),
  // GOALS 19: o registro central de acessos do laboratório.
  queryLabLog: (filters) => ipcRenderer.invoke('lab:logQuery', filters),
  exportLabLog: (filters) => ipcRenderer.invoke('lab:logExport', filters),
  getLabLogRetention: () => ipcRenderer.invoke('lab:logRetention'),
  setLabLogRetention: (days) => ipcRenderer.invoke('lab:setLogRetention', days),
  onLabLogChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('lab:logChanged', handler);
    return () => ipcRenderer.removeListener('lab:logChanged', handler);
  },

  getVersion: () => ipcRenderer.invoke('app:version'),

  // Server/Agent status
  getLocalIp: () => ipcRenderer.invoke('server:localIp'),

  // Tela inicial "Este PC" (IP + senha de acesso) e senha do TightVNC local
  getLocalAccess: () => ipcRenderer.invoke('access:getLocal'),
  rotateSessionPassword: () => ipcRenderer.invoke('access:rotate'),
  onLocalAccessChanged: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on('access:changed', handler);
    return () => ipcRenderer.removeListener('access:changed', handler);
  },
  setupHostVnc: () => ipcRenderer.invoke('hostVnc:setup'),
  allowDirectVnc: () => ipcRenderer.invoke('hostVnc:allowDirect'),

  checkForUpdates: () => ipcRenderer.invoke('app:checkUpdate'),

  notify: (opts) => ipcRenderer.invoke('app:notify', opts),

  testConnection: (host, port) => ipcRenderer.invoke('net:test', { host, port }),

  getDiagStatus: () => ipcRenderer.invoke('diag:getStatus'),

  // Painel de Atividade (GOALS 4) — histórico local + push ao vivo de
  // eventos de sessão reportados por outras máquinas configuradas.
  getActivityLog: () => ipcRenderer.invoke('activity:get'),
  onActivityEvent: (callback) => {
    const handler = (_, event) => callback(event);
    ipcRenderer.on('activity:new', handler);
    return () => ipcRenderer.removeListener('activity:new', handler);
  },

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
  ftRename: (sessionId, virtualPath, newVirtualPath) =>
    ipcRenderer.invoke('ft:rename', sessionId, virtualPath, newVirtualPath),
  ftUploadBatch: (sessionId, payload) => ipcRenderer.invoke('ft:uploadBatch', sessionId, payload),
  ftDownloadBatch: (sessionId, payload) =>
    ipcRenderer.invoke('ft:downloadBatch', sessionId, payload),

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
