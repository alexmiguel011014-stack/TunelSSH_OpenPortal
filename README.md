# OpenPortal Remote

Acesso remoto seguro a PCs Windows via Tailscale + TightVNC + Electron.
**Modo Hibrido:** este app funciona como cliente (conecta em outros PCs) E como servidor (recebe conexões de arquivos automaticamente).

---

## O que precisa instalar

| App | Onde baixar | Pra que |
|-----|-------------|---------|
| **Tailscale** | https://tailscale.com/download | VPN gratuita para conectar os PCs |
| **TightVNC Server** | https://www.tightvnc.com/download.php | Servidor VNC no PC remoto (apenas no PC alvo) |
| **Node.js** | https://nodejs.org (v18+) | Para rodar o app |
| **OpenPortal Remote** | Este repositorio | Interface VNC + transferencia de arquivos |

### Dependencias do Node (instaladas via `npm install`)

| Pacote | Versao | Uso |
|--------|--------|-----|
| `ws` | ^8.18.0 | Servidor WebSocket para proxy VNC e arquivos |
| `electron` | ^33.0.0 | Desktop shell do app |
| `react` / `react-dom` | ^18.3.0 | Interface grafica |
| `vite` | ^6.0.0 | Build tool e dev server |
| `tailwindcss` | ^3.4.0 | Estilos CSS |
| `electron-builder` | ^25.1.0 | Empacotamento para distribuicao |
| `nodemon` | ^3.0.0 | Auto-restart do Electron em desenvolvimento |
| `concurrently` | ^9.1.0 | Rodar Vite + Electron em paralelo |
| `wait-on` | ^8.0.0 | Aguardar Vite iniciar antes do Electron |

---

## Como funciona (arquitetura)

```
+------------------------------------------------------------------+
|                      Electron Shell (Modo Hibrido)                |
|                                                                   |
|  Servicos iniciados automaticamente ao abrir o app:               |
|                                                                   |
|  +----------+    +-----------+    +------------------+           |
|  | VNC Proxy|    |File Proxy |    |File Server (TCP) |           |
|  | :18900   |    | :18901    |    | :5001            |           |
|  | WS->TCP  |    | WS->TCP   |    | (agente receptor)|           |
|  +----+-----+    +----+------+    +--------+---------+           |
|       |               |                    |                      |
|       v               v                    v                      |
|  TightVNC(5900)  File Server(5001)   Recebe conexoes de          |
|  PC Remoto       PC Remoto           outros PCs na rede          |
|                                       (sem precisar rodar        |
|                                        nada no terminal)         |
+------------------------------------------------------------------+
```

### Fluxo VNC
1. Usuario seleciona um PC na sidebar/dashboard
2. noVNC (iframe) conecta no proxy local `ws://127.0.0.1:18900`
3. Proxy abre socket TCP para o TightVNC remoto (porta 5900)
4. Dados sao bridgeados: video frames + teclado/mouse

### Fluxo File Transfer (upload)
1. Abre "Files" na sidebar → painel duplo (Local | Remoto)
2. Seleciona arquivos/pastas no painel local, navega no remoto
3. "Enviar para Remoto" → main process le os arquivos via `fs`
4. Conecta no file proxy (18901) → TCP para file server remoto (5001)
5. Streaming em chunks de 64KB com barra de progresso

### Agente Receptor (novo no Modo Hibrido)
- O file server TCP (porta 5001) e iniciado automaticamente com o app
- Outros PCs na Tailscale podem enviar/receber arquivos deste PC
- **Nao precisa rodar `node remote-file-server.js` no terminal**

---

## Como usar

### 1. Configurar Tailscale
Instale e logue com a **mesma conta** em todos os PCs.

### 2. Instalar TightVNC Server
Apenas no PC que sera acessado remotamente. Porta padrao: 5900.

### 3. Baixar e rodar o app
```bash
git clone https://github.com/alexmiguel011014-stack/TunelSSH_OpenPortal.git
cd TunelSSH_OpenPortal
npm install
npm run dev
```

### 4. Tela inicial (Dashboard)
- **"Minha Maquina (Agente)"** — mostra o IP Tailscale local, status do servidor de arquivos (ATIVO), botao "Copiar IP"
- **"Conectar a um PC"** — lista de PCs cadastrados com botoes VNC e Files

### 5. Transferencia de arquivos
1. Clique em **"Files"** na sidebar
2. Painel esquerdo: navegue nos arquivos locais (drives C:, D:, atalhos Desktop/Downloads/Documentos)
3. Painel direito: navegue no PC remoto conectado
4. Selecione (checkbox ou Ctrl+Click) e clique em **"Enviar para Remoto"**

---

## Estrutura do projeto

```
TunelSSH/
+-- README.md                Este arquivo
+-- STATUS.md                Status atual e diagrama de arquitetura
+-- PLAN.md                  Plano de implementacao detalhado
+-- HISTORY.md               Historico de bugs e modificacoes
+-- PROCEDIMENTOS.md         Regras de desenvolvimento
+-- package.json             Dependencias e scripts
+-- start.bat / start.vbs    Atalhos para iniciar o app
|
+-- src/
|   +-- main/                Processo principal (Electron + servicos)
|   |   +-- main.js                     Inicializacao (janela, proxies, file server)
|   |   +-- preload.js                  Ponte segura IPC (contextBridge)
|   |   +-- proxy.js                    WebSocket <-> TCP (VNC, porta 18900)
|   |   +-- file-proxy.js               WebSocket <-> TCP (arquivos, porta 18901)
|   |   +-- file-server.js              Servidor TCP de arquivos embutido (porta 5001)
|   |   +-- file-transfer.js            Gerenciador de transferencia (main)
|   |   +-- remote-file-server.js       CLI wrapper do file-server (uso opcional)
|   |   +-- config-manager.js           Leitura/escrita de config em arquivo
|   |   +-- ipc-handlers.js             Todos os handlers IPC
|   |
|   +-- renderer/            Interface grafica (React)
|       +-- index.html                 Shell HTML
|       +-- vite.config.js             Configuracao do Vite
|       +-- src/
|           +-- App.jsx                Layout principal + roteamento
|           +-- main.jsx               Entry point React
|           +-- components/
|               +-- Dashboard.jsx      Tela inicial (agente + lista de PCs)
|               +-- Sidebar.jsx        Barra lateral (status, maquinas, logs)
|               +-- FileTransfer.jsx   Explorador two-panel (local | remoto)
|               +-- RemoteViewer.jsx   Iframe noVNC
|               +-- ConfigPanel.jsx    Gerenciamento de maquinas
|               +-- StatusBadge.jsx    Indicador de status
|               +-- Terminal.jsx       Terminal de logs
|       +-- public/
|           +-- noVNC/
|               +-- vnc.html           Viewer VNC standalone
|               +-- novnc.js           Bundle noVNC (184KB)
```

---

## Solucao de problemas

### App abre com tela preta
- Pressione `F12` (ou `Ctrl+Shift+I`) para abrir DevTools
- Verifique erros no Console

### VNC nao conecta
- Tailscale esta rodando? `ping 100.x.x.x`
- TightVNC esta rodando no PC remoto? `netstat -ano | findstr 5900`
- Senha VNC correta?

### File Transfer nao conecta no remoto
- O PC remoto precisa estar com o app OpenPortal Remote **aberto** (o file server TCP :5001 inicia automaticamente)
- Ou rode `node src/main/remote-file-server.js` manualmente no PC remoto se nao estiver usando o app

### "Servidor: INATIVO" no Dashboard
- Pode ser conflito de porta. Verifique se outra aplicacao esta usando a porta 5001
- Reinicie o app

---

## Desenvolvimento

```bash
# Modo desenvolvimento (Vite HMR + nodemon)
npm run dev

# Build do renderer
npm run build

# Empacotar para Windows
npm run dist
```

---

## Licenca

Projeto privado — OpenPortal Remote.
