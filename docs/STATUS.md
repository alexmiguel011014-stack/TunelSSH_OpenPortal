# OpenPortal Remote — Status

## Projeto: EM DESENVOLVIMENTO — Abordagem iframe + scaling manual implementados

O React agora funciona. O noVNC foi extraído para iframe isolado (abordagem do senior).

---

## O Que Funciona (Modo Hibrido — Agente + Cliente)

- [x] **File server embutido** — `file-server.js` inicia automaticamente na porta 5001
- [x] **Agente receptor** — outras maquinas Tailscale podem enviar arquivos para este PC sem terminal
- [x] **Dashboard inicial** — mostra status do servidor, IP local, botao "Copiar IP", lista de PCs
- [x] **Sidebar com status local** — IP e status do servidor visiveis na barra lateral
- [x] **IP Tailscale detectado** — via `tailscale ip -4` ou fallback por interfaces de rede
- [x] **Cleanup automatico** — `stopFileServer()` no fechamento do app

## O Que Funciona (File Transfer)

- [x] **Arquitetura backend completa** — file proxy (18901), file server remoto (5001), streaming chunked
- [x] **Layout two-panel** — Local (esquerda) + Remoto (direita) com breadcrumbs clicaveis
- [x] **Multi-selecao local** — checkbox ou Ctrl+Click para selecionar varios itens
- [x] **Upload unificado** — bota "Enviar para Remoto" envia arquivos E pastas no mesmo clique
- [x] **Upload de pastas recursivo** — `ft:uploadFolder` caminha na arvore local, cria pastas no remoto
- [x] **Atalhos rapidos** — botoes Area de Trabalho, Downloads, Documentos no painel local
- [x] **Colunas** — Nome, Tamanho (KB/MB/GB), Data de Modificacao nos dois paineis
- [x] **Barra de progresso** — percentual visivel durante transferencia
- [x] **Drives locais** — botoes C:, D:, etc. detectados via `fs.statSync`
- [x] **Protecao path traversal** — `resolveSafePath()` no file server remoto
- [x] **Integracao sidebar** — botao "Files" que abre/fecha o painel
- [x] **Navegacao "Voltar"** — entry `..` para subir de diretorio

## O Que Funciona (Geral)

- [x] Proxy WebSocket↔TCP na porta 18900
- [x] Conexao VNC testada e funciona (responde RFB 003.008)
- [x] Tailscale conecta os dois PCs
- [x] Porta VNC 5900 aberta nos dois PCs
- [x] Senhas configuradas
- [x] Script start.vbs abre o app sem janela de terminal
- [x] Atalho "OpenPortal Remote" na area de trabalho
- [x] React renderiza (sidebar funciona, clica funciona)
- [x] noVNC isolado em iframe (public/noVNC/vnc.html)
- [x] @novnc/novnc removido do package.json
- [x] Vite bundler nunca mais toca no noVNC
- [x] **Vite agora escuta em 127.0.0.1 (IPv4) em vez de ::1 (IPv6)**
- [x] **Dev workflow com nodemon para auto-restart do Electron**
- [x] **HMR do Vite funcionando para alteracoes no renderer**
- [x] **Sidebar recolhivel com botao hamburguer (3 barrinhas 20% opacidade)**
- [x] **PC conectado removido da lista, seção propria na sidebar**
- [x] **Barra superior do RemoteViewer removida, fullscreen responsivo**
- [x] **Funcoes de reconnect/disconnect movidas para dentro da sidebar**
- [x] **Cadastro dinamico de PCs (ate 20) com botao Add/Remove**
- [x] **Startup logs removidos (App started, electronAPI available, Config loaded)**
- [x] **Scaling VNC rework** — scaleViewport:false, fitScreen() manual com _display.scale
- [x] **Mouse tracking corrigido** — _display.scale atualizado corretamente para traduzir coordenadas
- [x] **Zoom da pagina desabilitado** — sidebar nao oscila mais com Ctrl+Scroll
- [x] **RemoteViewer captura resolucao remota (vnc-resolution event)**
- [x] **Conexao VNC via iframe testada e funcionando**
- [x] **Overflow VNC resolvido — tela preenche corretamente sem corte**
- [x] **Otimizacoes de conexao** — setNoDelay, keepAlive, qualityLevel:4, compressionLevel:3, keyboardDelay:20
- [x] **F12 funciona via View > Toggle Developer Tools**

## O Que Funciona (Packaging / Distribuicao)

- [x] **Instalador NSIS** — `electron-builder` gera `.exe` instalavel com opcao de pasta, atalhos, desinstalador
- [x] **Auto-update** — `electron-updater` verifica GitHub Releases e atualiza automaticamente
- [x] **Firewall rule** — instalador adiciona regra no firewall para porta 5001 (file server)
- [x] **Icone personalizado** — `resources/icon.ico` usado no exe, instalador e atalhos
- [x] **Build script** — `BUILD.bat` para gerar instalador facilmente

## Em Andamento (bugs)

- [ ] **File transfer com layout two-panel (AnyDesk style)** — upload funciona, mas:
  - Download nao implementado (foco em upload)
  - Drag & drop nao implementado
  - Renomear nao implementado
- [ ] **Modo hibrido** — agente receptor funciona, mas:
  - Nao ha indicacao visual quando outro PC esta enviando arquivos para esta maquina
  - O agente so aceita conexoes na rede local/Tailscale (sem autenticacao)

---

## Arquivos Principais

| Arquivo | O que faz |
|---------|-----------|
| `start.vbs` | Abre o app sem janela de terminal (executa npm run dev) |
| `start.bat` | Abre o app (alternativa) |
| `src/main/main.js` | Electron — cria janela, F12, DevTools |
| `src/main/proxy.js` | Proxy WebSocket ↔ TCP (porta 18900) |
| `src/main/preload.js` | Seguranca entre processos |
| `src/main/config-manager.js` | Salva configuracao em arquivo |
| `src/main/ipc-handlers.js` | Comunicacao entre processos |
| `src/renderer/vite.config.js` | Vite config (host 127.0.0.1) |
| `src/renderer/src/main.jsx` | Entry point React (com error handler) |
| `src/renderer/src/App.jsx` | Layout principal + painel de logs |
| `src/renderer/src/components/Sidebar.jsx` | Barra lateral com lista de PCs |
| `src/renderer/src/components/RemoteViewer.jsx` | Container do iframe noVNC |
| `src/renderer/src/components/StatusBadge.jsx` | Bolinha de status |
| `src/renderer/src/hooks/useVnc.js` | Stub vazio (removido) |
| `src/renderer/public/noVNC/vnc.html` | noVNC standalone (iframe) |
| `src/renderer/public/noVNC/novnc.js` | noVNC bundle (184KB, esbuild) |
| `src/main/file-proxy.js` | Proxy WebSocket <-> TCP para arquivos (porta 18901) |
| `src/main/file-transfer.js` | Gerenciador de transferencia (main process) |
| `src/main/remote-file-server.js` | Servidor TCP de arquivos (CLI wrapper) |
| `src/main/file-server.js` | Modulo TCP file server (embutido no Electron, auto-start) |
| `src/renderer/src/components/FileTransfer.jsx` | Interface two-panel de transferencia de arquivos |
| `src/renderer/src/components/Dashboard.jsx` | Tela inicial com status do agente + lista de PCs |
| `docs/PROCEDIMENTOS.md` | Regras de desenvolvimento e build |
| `docs/PLAN.md` | Plano de implementacao e decisoes tecnicas |
| `scripts/installer.nsh` | Script NSIS para regra de firewall no instalador |
| `scripts/BUILD.bat` | Script para gerar o instalador |
| `resources/icon.ico` | Icone do aplicativo |

---

## Arquitetura Atual

```
+------------------------------------------------------------------+
|                      Electron Shell (Modo Hibrido)                |
|                                                                   |
|  +----------------------------+  +---------------------------+    |
|  | React App                  |  | noVNC (iframe)            |    |
|  |  Dashboard (inicial)       |  | vnc.html + novnc.js       |    |
|  |    - Minha Maquina (agent) |  | ws://127.0.0.1:18900      |    |
|  |    - Conectar a um PC      |  +---------------------------+    |
|  |  Sidebar (colapsavel)      |                                   |
|  |    - Minha Maquina status  |                                   |
|  |    - PC Conectado          |                                   |
|  |    - Lista de PCs          |                                   |
|  |  ConfigPanel               |                                   |
|  |  FileTransfer (two-panel)  |                                   |
|  |    +--------+ +---------+  |                                   |
|  |    | Local  |>>| Remoto |  |                                   |
|  |    +--------+ +---------+  |                                   |
|  +------------+---------------+                                   |
|               |                                                   |
|   IPC via preload.js + Main Process Services:                     |
|   - Proxy VNC (18900)                                             |
|   - Proxy Files (18901)                                           |
|   - File Server TCP (5001) <- AUTO-START (agente receptor)       |
|               |                                                   |
+---------------+---------------------------------------------------+
                |
     +----------+-----------+
     |                      |
 Proxy VNC               Proxy Files
 ws://:18900              ws://:18901
     |                      |
 TCP bridge               TCP bridge (file-proxy.js)
 (proxy.js)                |
     |                      |
 TightVNC(5900)      File Server TCP (5001)
 MAQUINA REMOTA       MAQUINA REMOTA ou LOCAL
                      (embutido no Electron,
                       iniciado automaticamente)
```

---

## Senhas VNC

| PC | IP | Senha |
|---|---|---|
| PC local (skytre) | `100.66.218.65` | `011014` |
| PC remoto (desktop-o18jvru) | `100.81.199.56` | `Alex.777` |

---

## O Que Foi Testado (Historico)

| Teste | Abordagem | Resultado |
|-------|-----------|-----------|
| A | Remover noVNC (stub) | Sidebar aparece, tela cinza |
| B | Vite optimizeDeps.exclude | Sidebar aparece, tela cinza |
| C | noVNC via CDN script tag | Sidebar aparece, nada ao clicar |
| D | Dynamic import | Sidebar aparece, nada ao clicar |
| E | noVNC em iframe standalone | **Funcionando** |
| F | **Bug IPv4/IPv6 resolvido** | **App recebe atualizacoes dinamicamente** |

---

## Chaves de Sessao

- Vite rodando na porta 5173 (host 127.0.0.1)
- Proxy WebSocket na porta 18900
- Electron em modo dev (NODE_ENV=development)
- nodemon assistindo src/main/ para auto-restart

---

*Ultima atualizacao: 2026-07-30 — instalador NSIS + auto-update + firewall*
