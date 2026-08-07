# OpenPortal Remote — Status

## Projeto: EM DESENVOLVIMENTO — Abordagem iframe + scaling manual implementados

O React agora funciona. O noVNC foi extraído para iframe isolado (abordagem do senior).

---

## O Que Funciona (Modo Hibrido)

- [x] **Dashboard inicial** — mostra IP local, botao "Copiar IP", lista de PCs
- [x] **IP Tailscale detectado** — via `tailscale ip -4` ou fallback por interfaces de rede

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
- [x] **Icone personalizado** — `resources/icon.ico` usado no exe, instalador e atalhos
- [x] **Build script** — `BUILD.bat` para gerar instalador facilmente

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
| `src/renderer/src/components/Dashboard.jsx` | Tela inicial com status do agente + lista de PCs |
| `docs/PROCEDIMENTOS.md` | Regras de desenvolvimento e build |
| `docs/PLAN.md` | Plano de implementacao e decisoes tecnicas |
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
|  |    - Conectar a um PC      |  | ws://127.0.0.1:18900      |    |
|  |  Sidebar (colapsavel)      |  +---------------------------+    |
|  |    - PC Conectado          |                                   |
|  |    - Lista de PCs          |                                   |
|  |  ConfigPanel               |                                   |
|  +------------+---------------+                                   |
|               |                                                   |
|   IPC via preload.js + Main Process Services:                     |
|   - Proxy VNC (18900)                                             |
|               |                                                   |
+---------------+---------------------------------------------------+
                |
     +----------+----------+
     |                     |
Proxy VNC                (VNC remoto)
  ws://127.0.0.1:18900      TCP :5900
     |                     |
 TCP bridge              |
 (proxy.js)               |
     |                     |
  TightVNC(5900)          |
  MAQUINA REMOTA          |
```

---

## Senhas VNC

O app não guarda nem envia senha de VNC — o diálogo de aprovação
(Aceitar/Rejeitar) no PC remoto é a única trava de acesso. Se o TightVNC do
lado remoto tiver senha própria configurada, a conexão falha na etapa do
VNC (fora do controle do app); nesse caso, remova a senha do TightVNC ou
configure-o para aceitar conexões sem senha na rede Tailscale/privada.

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

*Ultima atualizacao: 2026-07-30 — instalador NSIS + auto-update*
