# OpenPortal-Remote — Implementation Plan

## 1. Architecture Overview (Modo Hibrido)

### Dual Service Model
O Electron agora executa simultaneamente:

| Servico | Porta | Tipo | Finalidade |
|---------|-------|------|------------|
| Proxy VNC | 18900 | WebSocket | Bridge noVNC ↔ TightVNC remoto |
| Proxy Files | 18901 | WebSocket | Bridge FileTransfer ↔ File Server remoto |
| File Server (Agente) | 5001 | TCP | Receber conexoes de arquivos de OUTRAS maquinas |

Na inicializacao:
- `file-server.js` e importado e iniciado automaticamente via `startFileServer(5001)`
- `remote-file-server.js` agora e um wrapper CLI que usa o mesmo modulo
- Nao precisa mais rodar scripts manualmente no terminal

```
+-------------------------------------------------------------+
|                     Electron App (Modo Hibrido)             |
|                                                             |
|  +-------------------------------------+   +--------------+ |
|  |     MAIN PROCESS (main.js)          |   |  RENDERER    | |
|  |                                      |   |  (React)     | |
|  |  +-------------------+  +---------+ |   |              | |
|  |  | WebSocket Server  |  |File Srv | |IPC| +----------+ | |
|  |  | (ws library)      |  |TCP:5001 |<-+-->| Dashboard | | |
|  |  | port: 18900       |  |(embutido)| |   | Sidebar   | | |
|  |  +--------+----------+  +---------+ |   | FileTrans | | |
|  |           |                         |   | RemoteView| | |
|  |  +--------v----------+             |   +----------+ | |
|  |  | TCP Proxy         |             |              | |
|  |  | (Node.js net)     |             |              | |
|  |  +--------+----------+             |              | |
|  |           |                        |              | |
|  +-----------+------------------------+--------------+ |
|              |                        |
|  +-----------v-------------+          |
|  | Config Manager          |          |
|  +-------------------------+          |
+--------------+------------------------+
               |
     +---------+---------+
     |                   |
 TCP :5900           TCP :5001
 (VNC remoto)        (file server local/remoto)
```

**Servicos iniciados automaticamente no main.js:**

| Servico | Tipo | Porta | Descricao |
|---------|------|-------|-----------|
| VNC Proxy | WebSocket | 18900 | Bridge noVNC ↔ TightVNC remoto |
| File Proxy | WebSocket | 18901 | Bridge FileTransfer ↔ File Server |
| File Server | TCP | 5001 | Agente receptor (embutido, auto-start) |

**Data flow for a VNC session:**

1. User selects a machine in the Sidebar or Dashboard
2. Renderer creates a noVNC instance pointed at `ws://127.0.0.1:18900?host=100.x.x.x&port=5900`
3. WebSocket server reads query params, opens TCP socket to remote VNC
4. WebSocket server bridges data: `noVNC <WS> Main <TCP> TightVNC`

**Data flow for File Transfer (upload):**

1. User opens "Files" in sidebar, selects items on the left (local) panel
2. User navigates to destination on the right (remote) panel
3. Click "Enviar para Remoto" → main process reads local files via `fs`
4. Main process connects to file proxy (18901) with remote host param
5. Proxy bridges WebSocket ↔ TCP to remote machine's file server (5001)
6. Files are streamed in 64KB chunks with progress reporting

**Data flow for receiving files (this PC as agent):**

1. Another machine connects to this PC's Tailscale IP on port 5001
2. `file-server.js` (embutido) recebe a conexao TCP diretamente
3. Comandos LIST/GET/PUT/DELETE/MKDIR sao processados localmente
4. Acesso restrito ao diretorio do usuario via `resolveSafePath()`

---

## 2. Project Structure

```
TunelSSH/ (project root)
+-- package.json
+-- .gitignore
+-- tailwind.config.js              # TailwindCSS configuration
+-- postcss.config.js               # PostCSS configuration
+-- PLAN.md                         # This file
+-- STATUS.md                       # Current status
+-- HISTORY.md                      # Bug fixes and modifications log
+-- start.bat                       # Dev startup script
+-- start.vbs                       # Silent dev startup (desktop shortcut)
+-- start-vite.ps1                  # Helper for Vite background start
|
+-- src/
|   +-- main/
|   |   +-- main.js                 # Electron entry point
|   |   +-- preload.js              # Context bridge (IPC exposure)
|   |   +-- proxy.js                # WebSocket <-> TCP proxy server
|   |   +-- config-manager.js       # File-based config persistence
|   |   +-- ipc-handlers.js         # All IPC handler registrations
|   |
|   +-- renderer/
|       +-- index.html              # HTML shell
|       +-- vite.config.js          # Vite config for renderer (host: 127.0.0.1)
|       +-- src/
|       |   +-- main.jsx            # React DOM entry point
|       |   +-- App.jsx             # Root component, layout
|       |   +-- index.css           # TailwindCSS imports + global styles
|       |   |
|       |   +-- components/
|       |   |   +-- Sidebar.jsx     # Machine selector sidebar
|       |   |   +-- RemoteViewer.jsx# noVNC iframe wrapper
|       |   |   +-- ConfigPanel.jsx # Settings editor
|       |   |   +-- StatusBadge.jsx # Connection status indicator
|       |   |   +-- Terminal.jsx    # Debug log terminal
|       |   |
|       |   +-- hooks/
|       |   |   +-- useVnc.js       # Stub (noVNC is iframe-isolated)
|       |   |
|       |   +-- lib/
|       |       +-- config.js       # Renderer-side config helper (localStorage)
|       |
|       +-- public/
|           +-- noVNC/
|               +-- vnc.html        # noVNC standalone viewer
|               +-- novnc.js        # noVNC bundle (184KB)
|
+-- resources/
|   +-- icon.png                    # App icon for packaging (TODO)
|
+-- dist/                           # Build output (generated)
|   +-- renderer/                   # Vite build output
|
+-- node_modules/                   # Dependencies
```

---

## 3. package.json

```json
{
  "name": "openportal-remote",
  "version": "1.0.0",
  "description": "Secure remote desktop access to Windows PCs over Tailscale",
  "main": "src/main/main.js",
  "scripts": {
    "dev": "concurrently -k \"npm run dev:renderer\" \"wait-on http://127.0.0.1:5173 && npm run dev:electron:watch\"",
    "dev:renderer": "vite --config src/renderer/vite.config.js --host 127.0.0.1",
    "dev:electron": "cross-env NODE_ENV=development electron .",
    "dev:electron:watch": "nodemon --watch src/main --ext js,json --exec \"cross-env NODE_ENV=development electron .\"",
    "build": "vite build --config src/renderer/vite.config.js",
    "pack": "npm run build && electron-builder --dir",
    "dist": "npm run build && electron-builder"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.20",
    "concurrently": "^9.1.0",
    "cross-env": "^7.0.3",
    "electron": "^33.0.0",
    "electron-builder": "^25.1.0",
    "nodemon": "^3.0.0",
    "postcss": "^8.4.49",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "tailwindcss": "^3.4.0",
    "vite": "^6.0.0",
    "wait-on": "^8.0.0"
  },
  "build": {
    "appId": "com.openportal.remote",
    "productName": "OpenPortal Remote",
    "directories": {
      "output": "dist-electron"
    },
    "files": [
      "src/main/**/*",
      "dist/renderer/**/*"
    ],
    "win": {
      "target": "nsis",
      "icon": "resources/icon.png"
    }
  }
}
```

**noVNC integration:** Isolated via iframe (`public/noVNC/vnc.html`), no npm dependency. `@novnc/novnc` removed from package.json.

---

## 4. Required Dependencies

### Production
| Package | Purpose |
|---------|---------|
| `ws` | WebSocket server in Main process |

### Development
| Package | Purpose |
|---------|---------|
| `electron` | Desktop shell |
| `electron-builder` | Packaging & distribution |
| `react`, `react-dom` | UI framework |
| `vite` | Build tool for renderer |
| `@vitejs/plugin-react` | Vite React integration |
| `tailwindcss`, `postcss`, `autoprefixer` | CSS framework |
| `concurrently` | Run Vite + Electron in parallel during dev |
| `cross-env` | Cross-platform env vars |
| `wait-on` | Wait for Vite dev server before launching Electron |
| `nodemon` | Auto-restart Electron on src/main/ changes |

---

## 5. npm Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `concurrently -k "npm run dev:renderer" "wait-on http://127.0.0.1:5173 && npm run dev:electron:watch"` | Start both dev servers with auto-reload |
| `dev:renderer` | `vite --config src/renderer/vite.config.js --host 127.0.0.1` | Vite dev server (HMR) |
| `dev:electron` | `cross-env NODE_ENV=development electron .` | Electron in dev mode |
| `dev:electron:watch` | `nodemon --watch src/main --ext js,json --exec "cross-env NODE_ENV=development electron ."` | Electron with auto-restart on changes |
| `build` | `vite build --config src/renderer/vite.config.js` | Production renderer build |
| `pack` | `npm run build && electron-builder --dir` | Package without installer |
| `dist` | `npm run build && electron-builder` | Full distribution build |

---

## 6. Main Process Architecture (`src/main/main.js`)

```
main.js
  +-- app.whenReady() -> startWebSocketProxy() + registerIpcHandlers() + createWindow()
  +-- createWindow()
  |     +-- new BrowserWindow({ preload, webPreferences })
  |     +-- loadURL('http://127.0.0.1:5173')        <- dev mode (fixed IPv4)
  |     +-- openDevTools({ mode: 'detach' })         <- dev mode
  +-- app.on('window-all-closed') -> wss.close() + app.quit()
  +-- app.on('activate') -> recreateWindow (macOS compat)
```

### preload.js - Context Bridge

Exposes a safe, limited API to the renderer via `contextBridge`:

```js
// Exposed on window.electronAPI
{
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  connectVnc: (machine) => ipcRenderer.invoke('vnc:connect', machine),
  disconnectVnc: () => ipcRenderer.invoke('vnc:disconnect'),
  getProxyUrl: () => ipcRenderer.invoke('vnc:proxyUrl'),
  onVncStatus: (callback) => { /* ... */ },
  getVersion: () => ipcRenderer.invoke('app:version'),
}
```

### ipc-handlers.js - All IPC Handlers

```
IPC Channels:
  invoke (Renderer -> Main -> Renderer):
    'config:get'        -> returns { machines: [...] } from file
    'config:save'       -> writes config to file, returns success
    'vnc:connect'       -> sends 'vnc:status' connecting, returns { success }
    'vnc:disconnect'    -> sends 'vnc:status' disconnected, returns { success }
    'vnc:proxyUrl'      -> returns 'ws://127.0.0.1:18900'
    'app:version'       -> returns package version

  send (Main -> Renderer):
    'vnc:status'        -> { state, machineId? }
```

---

## 7. TCP <-> WebSocket Proxy Design (`src/main/proxy.js`)

**Query-param raw bridge** (implemented approach):

```js
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const targetHost = url.searchParams.get('host');
  const targetPort = parseInt(url.searchParams.get('port') || '5900', 10);

  // Security: only allow Tailscale IPs (100.*) or localhost in dev mode
  if (!targetHost.startsWith('100.') && !(isDev && targetHost === '127.0.0.1')) {
    ws.close(4002, 'Invalid host');
    return;
  }

  const tcpSocket = net.createConnection(targetPort, targetHost);
  // Bidirectional raw bridge - noVNC doesn't need to know about the proxy
  tcpSocket.on('data', (chunk) => ws.send(chunk));
  ws.on('message', (data) => tcpSocket.write(data));
  // Cleanup on close/error
});
```

This is a transparent proxy - noVNC connects directly with VNC protocol, no JSON framing.

---

## 8. Renderer Architecture

### App.jsx - Root Layout

```
+----------------------------------------------------+
|  Sidebar (fixed, 250px)  |  Content Area          |
|                          |                         |
|  [PC Remoto 1] @ green   |  +-------------------+  |
|  [PC Remoto 2] @ red     |  |                   |  |
|  [PC 3] @ red            |  |   RemoteViewer    |  |
|                          |  |   (noVNC iframe)  |  |
|  -------------           |  |                   |  |
|  [@ Settings]            |  +-------------------+  |
|                          |                         |
|                          |  OR                     |
|                          |                         |
|                          |  +-------------------+  |
|                          |  |  ConfigPanel      |  |
|                          |  +-------------------+  |
+----------------------------------------------------+
```

**State management:** React `useState` + `useContext` (MachineContext).

### RemoteViewer.jsx - noVNC iframe

```jsx
// Mounts an <iframe> pointing to /noVNC/vnc.html
// Passes host, port, proxy URL and password as query params
// iframe status tracked via onLoad/onError events
// Reconnect reloads the iframe with a new React key
```

---

## 9. IPC Design Summary

| Channel | Direction | Type | Payload | Response |
|---------|-----------|------|---------|----------|
| `config:get` | R->M->R | invoke | none | `{ machines: Machine[] }` |
| `config:save` | R->M->R | invoke | `{ machines: Machine[] }` | `{ success: boolean }` |
| `vnc:connect` | R->M->R | invoke | `{ id, host, port }` | `{ success: boolean }` |
| `vnc:disconnect` | R->M->R | invoke | none | `{ success: boolean }` |
| `vnc:proxyUrl` | R->M->R | invoke | none | `ws://127.0.0.1:18900` |
| `vnc:status` | M->R | send | none | `{ state, machineId? }` |
| `app:version` | R->M->R | invoke | none | `string` |
| `server:status` | R->M->R | invoke | none | `{ running, port, rootDir }` |
| `server:localIp` | R->M->R | invoke | none | `{ ip }` |
| `fs:listDir` | R->M->R | invoke | `dirPath` | `[{ n, d, s, m }]` |
| `fs:getDrives` | R->M->R | invoke | none | `[string]` |
| `fs:getHomeDir` | R->M->R | invoke | none | `string` |
| `fs:getSpecialDirs` | R->M->R | invoke | none | `{ desktop, downloads, documents, home }` |
| `fs:stat` | R->M->R | invoke | `filePath` | `{ d, s }` |
| `ft:uploadFolder` | R->M->R | invoke | `localPath, remoteParent` | `{ s, totalFiles, failedFiles }` |

---

## 10. Config Management

**Dual-storage strategy:**

1. **Primary:** File at `%APPDATA%/openportal-remote/config.json` (managed by Main process)
2. **Fallback/cache:** LocalStorage in renderer (loaded from Main on startup, synced on save)

**Current config (pre-configured for testing):**
```json
{
  "machines": [
    { "id": "pc-1", "name": "PC Remoto 1", "host": "100.81.199.56", "port": 5900 },
    { "id": "pc-2", "name": "PC Remoto 2", "host": "100.66.218.65", "port": 5900 },
    { "id": "pc-3", "name": "PC 3", "host": "", "port": 5900 }
  ],
  "proxyPort": 18900
}
```

Config file location: `C:\Users\beatl\AppData\Roaming\openportal-remote\config.json`

**Note:** The config file must be UTF-8 without BOM. The `config-manager.js` reads it via `fs.readFileSync` with `utf-8` encoding.

---

## 11. Security Considerations

1. **IP whitelist:** Main process proxy validates host starts with `100.` (Tailscale range) or `127.0.0.1` (dev mode only).
2. **Context isolation:** `contextIsolation: true`, `nodeIntegration: false` in BrowserWindow.
3. **No remote modules:** `enableRemoteModule: false`.
4. **CSP:** Content-Security-Policy in `index.html` restricts connections to `127.0.0.1` and `ws://127.0.0.1`.
5. **No secrets in renderer:** All TCP connections happen in Main. Renderer never touches raw sockets.

---

## 12. Development Roadmap

### Phase 1: Scaffolding
- [x] Initialize project with `npm init`
- [x] Set up Vite + React + TailwindCSS
- [x] Set up Electron with manual dev setup
- [x] Configure `concurrently` for dev workflow
- [x] Create folder structure
- [x] Verify `npm run dev` launches both Vite and Electron

### Phase 2: Main Process Core
- [x] Implement `main.js` with BrowserWindow creation
- [x] Implement `preload.js` with contextBridge
- [x] Implement `config-manager.js` (file read/write)
- [x] Implement `ipc-handlers.js` (config:get, config:save, vnc:connect, vnc:disconnect, vnc:proxyUrl)
- [x] Config save/load round-trip verified

### Phase 3: TCP<->WebSocket Proxy
- [x] Implement `proxy.js` (WebSocket server + TCP bridge)
- [x] Query-param based routing for noVNC compatibility
- [x] Security validation (Tailscale IP range only)
- [x] Connection/disconnection cleanup

### Phase 4: Renderer UI
- [x] Implement `App.jsx` layout (sidebar + content area)
- [x] Implement `Sidebar.jsx` (machine list, selection, status indicators)
- [x] Implement `ConfigPanel.jsx` (edit form, save/load)
- [x] Implement dark theme with TailwindCSS
- [x] Wire up config IPC calls

### Phase 5: noVNC Integration
- [x] Install and configure `@novnc/novnc`
- [x] Implement `RemoteViewer.jsx` with iframe approach
- [x] Implement `useVnc.js` stub
- [x] Connect noVNC to local WebSocket proxy
- [x] `scaleViewport: true` enabled
- [x] Password pre-configured for both machines

### Phase 6: Dev Workflow Fix (2026-07-29)
- [x] **Root cause found:** Vite listening on IPv6 (`[::1]`), Electron connecting to IPv4 (`127.0.0.1`) = `ERR_CONNECTION_REFUSED`
- [x] Fixed `vite.config.js` - added `host: '127.0.0.1'`
- [x] Fixed all `localhost` references to `127.0.0.1` across the codebase
- [x] Installed `nodemon` for auto-restart of Electron on main process changes
- [x] Updated `package.json` scripts for proper dev workflow
- [x] Updated `start.bat` and `start.vbs` to use `npm run dev`
- [x] **HMR working:** React changes update instantly
- [x] **nodemon working:** Main process changes restart Electron automatically

### Phase 7: Polish
- [x] Add `StatusBadge.jsx` (connecting/connected/disconnected/error indicators)
- [x] Add reconnect mechanism
- [x] Add connection error handling and user feedback
- [x] Test switching between machines (connect/disconnect cycle)
- [x] Debug log panel in app
- [x] Error boundary in main.jsx
- [x] F12 shortcut for DevTools
- [ ] Edge cases (window close during session)

### Phase 7b: UI Overhaul (2026-07-29)
- [x] **Collapsible sidebar** — hamburger button (3 bars, 20% opacity, top-left)
- [x] **Connected machine removed from list** — separate "Conectado" section at top of sidebar with expand (Reconnect/Disconnect)
- [x] **RemoteViewer top bar removed** — only the iframe, fullscreen
- [x] **Logs moved from fixed bottom-right to sidebar** — above Settings button
- [x] **VNC status bar removed** — vnc.html cleaner, no status-bar div
- [x] **Dynamic PC limits** — up to 20 machines, configurable via sidebar + ConfigPanel
- [x] **Startup logs removed** — App started, electronAPI, Config loaded no longer logged
- [x] **Remote resolution capture** — vnc-resolution event via postMessage to React

### Phase 7c: VNC Scaling Rework + Zoom Fix (2026-07-29)
- [x] **scaleViewport disabled** — conflitava com CSS manual, mouse tracking quebrado
- [x] **Manual fitScreen()** — `rfb._display.scale = Math.min(cw/fbW, ch/fbH, 1)` via `_rescale()`
- [x] **Mouse tracking corrigido** — `_scale` agora reflete o scale real do canvas
- [x] **Fallback _fbWidth/_fbHeight** — desktopresolution event nao existe nessa versao do noVNC
- [x] **ResizeObserver no canvas** — para mudancas dinamicas de resolucao do servidor
- [x] **Zoom da pagina desabilitado** — sidebar nao oscila mais (main.js zoom-changed)

### Phase 7d: Otimizacoes de Conexao (2026-07-29)
- [x] **TCP NoDelay** — setNoDelay(true) no proxy para eliminar latencia de Nagle
- [x] **TCP KeepAlive** — setKeepAlive(true, 5000) para deteccao rapida de queda
- [x] **Quality level reduzido** — qualityLevel:4 (era 6) para menos dados em frames JPEG
- [x] **Compression level aumentado** — compressionLevel:3 (era 2) para melhor compressao
- [x] **Keyboard delay reduzido** — keyboardDelay:20 (era 50) para resposta mais rapida

### Phase 8a: Transferencia de Arquivos — Backend (2026-07-29)
- [x] **Pesquisar abordagens** — arquitetura para envio/recebimento de arquivos e pastas
- [x] **Escolher metodo** — proxy dedicado WebSocket <-> TCP (porta 18901)
- [x] **Protocolo binario** — mensagens length-prefixed (8 byte header: type + len)
- [x] **Implementar file server remoto** — remote-file-server.js (Node.js TCP, port 5001)
- [x] **File proxy** — file-proxy.js (WebSocket bridge, mesma validacao de host do VNC)
- [x] **File transfer manager** — file-transfer.js (main process, streaming chunked 64KB)
- [x] **Barra de progresso** — percentual visivel durante transferencia
- [x] **Protecao path traversal** — resolveSafePath() que valida diretorio raiz

### Phase 8b: File Transfer — UI Two-Panel (AnyDesk Style)
- [x] **Layout dual-pane** — Local (esquerda) + Remoto (direita) com breadcrumbs clicaveis
- [x] **Navegacao local** — `fs:listDir`, `fs:getDrives`, `fs:getHomeDir`, `fs:getSpecialDirs`, `fs:stat`
- [x] **Atalhos rapidos** — botoes Area de Trabalho, Downloads, Documentos
- [x] **Multi-selecao** — checkbox ou Ctrl+Click, upload em lote
- [x] **Upload unificado** — botao "Enviar para Remoto" envia arquivos e pastas no mesmo clique
- [x] **Upload de pastas recursivo** — `ft:uploadFolder` com walkDir() e criacao de diretorios
- [x] **Coluna Data de Modificacao** — mtime formatado nos dois paineis
- [x] **Mensagem de espera** — "Aguardando resposta do remote-file-server..." enquanto conecta
- [x] **Drives locais** — botoes C:, D:, etc. com `fs.statSync` (sem `wmic`)
- [ ] **Download** — nao implementado (foco em upload)
- [ ] **Drag & drop** — nao implementado
- [ ] **Renomear** — nao implementado

### Phase 8c: Modo Hibrido — Agente Receptor Embutido (2026-07-29)
- [x] **Modulo file-server.js** — extraido do remote-file-server.js para inicio programatico
- [x] **Auto-start no main.js** — `startFileServer(5001)` chamado no `app.whenReady()`
- [x] **Cleanup no quit** — `stopFileServer()` no `window-all-closed`
- [x] **CLI wrapper** — `remote-file-server.js` vira 3 linhas que chamam o modulo
- [x] **IPC server:status** — retorna running, port, rootDir
- [x] **IPC server:localIp** — detecta IP Tailscale via `tailscale ip -4` ou interfaces de rede
- [x] **Dashboard** — tela inicial com card "Minha Maquina (Agente)" + lista "Conectar a um PC"
- [x] **Sidebar** — indicador de status do servidor local + IP
- [x] **Novos arquivos:** `src/main/file-server.js`, `src/renderer/src/components/Dashboard.jsx`

### Phase 8d: Testing
- [ ] Real VNC connection test with remote machines
- [x] TightVNC authentication handling (password dialog)
- [ ] Test both IPs: 100.81.199.56 and 100.66.218.65

### Phase 9: Packaging
- [ ] Configure `electron-builder` for Windows
- [ ] Build and test distributable
- [ ] App icon (`resources/icon.png`)
- [ ] Final integration test

---

## Key Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Proxy architecture | Query-param raw bridge | noVNC expects raw VNC protocol over WebSocket; JSON framing would break compatibility |
| Single active session | One VNC view at a time | Simpler, matches UX of switching between machines |
| Config storage | File-based (Main) + LocalStorage (Renderer cache) | File ensures durability; LS enables fast renderer reads |
| UI framework | React + TailwindCSS (no component library) | Lightweight, full control over dark theme |
| Dev workflow | concurrently + wait-on + nodemon | Industry standard for Electron + Vite dev |
| Tailscale enforcement | Proxy validates host IP (`100.*` prefix) | Defense in depth; renderer cannot bypass the proxy |
| noVNC integration | Isolated iframe (`public/noVNC/`) | Avoids Vite bundler conflicts with @novnc/novnc |
| **IPv4 binding** | **host: 127.0.0.1** | **Windows Vite defaults to IPv6; Electron expects IPv4** |
| **VNC scaling** | **Manual fitScreen() + _display.scale** | scaleViewport:true conflita com CSS; _display.scale corrige mouse tracking |
| **File transfer** | **Proxy dedicado (porta 18901) + file server remoto** | Mesma arquitetura do VNC; protocolo length-prefixed binario |
| **Modo Hibrido** | **File server embutido no Electron (auto-start)** | Nao precisa rodar script externo; app e cliente e servidor |

---

*Last updated: 2026-07-29 (Phase 8d — Modo Hibrido + Dashboard)*
*End of plan.*
