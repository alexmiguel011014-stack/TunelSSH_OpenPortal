# OpenPortal Remote

Acesso remoto seguro a PCs Windows via Tailscale + TightVNC + Electron.
**Modo Hibrido:** este app funciona como cliente (conecta em outros PCs) E como servidor.

---

## O que precisa instalar

| App | Onde baixar | Pra que |
|-----|-------------|---------|
| **Tailscale** | https://tailscale.com/download | VPN gratuita para conectar os PCs |
| **TightVNC Server** | https://www.tightvnc.com/download.php | Servidor VNC no PC remoto (apenas no PC alvo) |
| **Node.js** | https://nodejs.org (v18+) | Para rodar o app |
| **OpenPortal Remote** | Este repositorio | Interface VNC remota |

### Dependencias do Node (instaladas via `npm install`)

| Pacote | Versao | Uso |
|--------|--------|-----|
| `ws` | ^8.18.0 | Servidor WebSocket para proxy VNC |
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
|  +----------+                                                     |
|  | VNC Proxy|                                                     |
|  | :18900   |                                                     |
|  | WS->TCP  |                                                     |
|  +----+-----+                                                     |
|       |                                                            |
|       v                                                            |
|  TightVNC(5900)                                                    |
|  PC Remoto                                                         |
+------------------------------------------------------------------+
```

### Fluxo VNC
1. Usuario seleciona um PC na sidebar/dashboard
2. noVNC (iframe) conecta no proxy local `ws://127.0.0.1:18900`
3. Proxy abre socket TCP para o TightVNC remoto (porta 5900)
4. Dados sao bridgeados: video frames + teclado/mouse

---

## Como usar

### 0. Instalar o app (usuarios finais)
Baixe o instalador na pagina de **Releases** do GitHub:
`https://github.com/alexmiguel011014-stack/TunelSSH_OpenPortal/releases`

Execute o `.exe` — nao precisa de Node.js nem terminal.

### 1. Configurar Tailscale
Instale e logue com a **mesma conta** em todos os PCs.

### 2. Instalar TightVNC Server
Apenas no PC que sera acessado remotamente. Porta padrao: 5900.

### 3. Baixar e rodar o app (desenvolvedores)
```bash
git clone https://github.com/alexmiguel011014-stack/TunelSSH_OpenPortal.git
cd TunelSSH_OpenPortal
npm install
npm run dev
```

### 4. Tela inicial (Dashboard)
- **"Conectar a um PC"** — lista de PCs cadastrados com conexao VNC e conexao rapida por IP
- **"Conectar por IP"** — dispara um pedido de conexao que o PC remoto precisa aceitar

---

## Estrutura do projeto

```
TunelSSH/
+-- README.md                Este arquivo
+-- package.json             Dependencias e scripts
+-- docs/
|   +-- README.md            (link para o README raiz)
|   +-- STATUS.md            Status atual e diagrama de arquitetura
|   +-- PLAN.md              Plano de implementacao detalhado
|   +-- HISTORY.md           Historico de bugs e modificacoes
|   +-- PROCEDIMENTOS.md     Regras de desenvolvimento
+-- scripts/
|   +-- start.bat            Atalho para iniciar o app
|   +-- start.vbs            Atalho silencioso
|   +-- start-vite.ps1       Helper Vite
+-- src/
|   +-- main/                Processo principal (Electron + servicos)
|   |   +-- main.js                     Inicializacao (janela, proxies)
|   |   +-- preload.js                  Ponte segura IPC (contextBridge)
|   |   +-- proxy.js                    WebSocket <-> TCP (VNC, porta 18900)
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
|               +-- Dashboard.jsx      Tela inicial (lista de PCs)
|               +-- Sidebar.jsx        Barra lateral (maquinas, logs)
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
