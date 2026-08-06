# Histórico de Modificacoes

## [2026-07-29] Bug Crítico: IPv4 vs IPv6 — Vite nao conectava no Electron

### Resumo

O app inteiro estava "quebrado" silenciosamente: o React nao renderizava,
alteracoes nos arquivos nao apareciam, e nada indicava o erro claramente.

### Causa Raiz

**Vite v6.4.3 no Windows escuta apenas em IPv6 (`[::1]:5173`) por padrao.**
O Electron (Chromium) tentava conectar em IPv4 (`127.0.0.1:5173` ou
`localhost` resolvido para IPv4), resultando em:

```
ERR_CONNECTION_REFUSED
```

O Electron abria a janela, mas carregava uma pagina de erro em branco.
O React nunca montava. O `console.log` mostrava "Page loaded" porque o
evento `did-finish-load` disparava mesmo em paginas de erro.

### Sintomas

- Janela do Electron abria com fundo escuro, mas sem nenhum componente React
- Nenhum erro aparecia no DevTools (que tentava abrir mas tambem falhava)
- `electron-out.log` mostrava "Proxy listening" e "Creating window" normal
- `npm run dev` rodava sem erros visiveis
- Qualquer alteracao nos arquivos .jsx nao tinha efeito porque o
  Electron nunca carregou o Vite de verdade

### Diagnostico

1. `netstat -ano | findstr 5173` mostrou `[::1]:5173` (IPv6 apenas)
2. `curl http://127.0.0.1:5173` falhava, `curl http://[::1]:5173` funcionava
3. Ao iniciar o Electron manualmente, o log mostrava:
   `Failed to load URL: http://localhost:5173/ with error: ERR_CONNECTION_REFUSED`

### Arquivos Afetados e Correcoes

| Arquivo | O que mudou |
|---------|-------------|
| `src/renderer/vite.config.js` | Adicionado `server.host: '127.0.0.1'` |
| `src/main/main.js` | `loadURL('http://localhost:5173')` -> `http://127.0.0.1:5173` |
| `src/main/ipc-handlers.js` | `ws://localhost:18900` -> `ws://127.0.0.1:18900` |
| `src/renderer/src/components/RemoteViewer.jsx` | `ws://localhost:18900` -> `ws://127.0.0.1:18900` |
| `src/renderer/public/noVNC/vnc.html` | `ws://localhost:18900` default -> `ws://127.0.0.1:18900` |

### Licao Aprendida

**Sempre verificar em qual interface/IP o servidor de desenvolvimento
esta ouvindo.** `localhost` no Windows 10+ pode resolver para IPv6 `::1`
dependendo da configuracao de DNS e do `hosts` file. O Vite 6 em particular
tem esse comportamento padrao.

Comando diagnostico:
```powershell
netstat -ano | findstr "5173"
# Se mostrar [::1]:5173, o servidor esta apenas em IPv6
# Se mostrar 127.0.0.1:5173, esta em IPv4 (correto)
```

---

## [2026-07-29] Melhoria: Dev Workflow com Auto-Update

### Problema

Apos corrigir o IPv4/IPv6, o app funcionava mas nao refletia alteracoes
dinamicamente:
- Edicoes em `src/renderer/` precisavam de refresh manual (Vite HMR nao
  estava configurado corretamente)
- Edicoes em `src/main/` exigiam reiniciar o Electron manualmente
- Os scripts `start.bat` e `start.vbs` inicializavam Vite e Electron de
  forma independente, sem coordenacao

### Solucao

1. **Vite HMR:** Garantido forçando host IPv4 e usando `--host 127.0.0.1`
   no comando `dev:renderer`

2. **nodemon:** Instalado como devDependency para assistir `src/main/`
   e reiniciar o Electron automaticamente em qualquer alteracao:
   ```bash
   nodemon --watch src/main --ext js,json --exec "cross-env NODE_ENV=development electron ."
   ```

3. **Script `dev` atualizado:**
   ```bash
   concurrently -k "npm run dev:renderer" "wait-on http://127.0.0.1:5173 && npm run dev:electron:watch"
   ```
   O `-k` garante que ao fechar um processo, o outro tambem encerre.

4. **start.vbs / start.bat:** Agora executam `npm run dev` em vez de
   comandos manuais, garantindo o workflow completo.

### Resultado

| Tipo de Alteracao | Comportamento |
|-------------------|---------------|
| `.jsx` / `.css` (renderer) | **Instantâneo** via Vite HMR |
| `.js` / `.json` (main) | **Auto-restart** via nodemon (2-3s) |
| `vite.config.js` | Requer reinicio manual |
| `package.json` | Requer reinicio manual |

### Como usar

1. Clique no atalho "OpenPortal Remote" na area de trabalho
2. O app abre em modo desenvolvimento
3. Edite qualquer arquivo — as mudancas sao refletidas automaticamente
4. Para encerrar, feche a janela do Electron

---

---

## [2026-07-29] UI: Sidebar recolhivel, cadastro dinamico, scaling VNC, startup logs

### Problemas

1. **UX ruim:** Sidebar fixa ocupava espaco mesmo quando nao usada. PC conectado aparecia na lista junto com os demais. Startup logs poluiam o painel.
2. **Overflow VNC:** Tela remota aparecia >100% do viewport (cortada). `scaleViewport: true` no noVNC nao resolvia.
3. **Cadastro estatico:** Maquinas eram fixas no JSON, sem interface para adicionar/remover.

### Mudancas

| Arquivo | Mudanca |
|---------|---------|
| `src/renderer/src/App.jsx` | Startup logs removidos; keep loading config silently |
| `src/renderer/src/components/Sidebar.jsx` | Sidebar recolhivel com hamburger; secao "Conectado" no topo com expand Reconnect/Disconnect; botao Logs movido; Add/Remove dinamico (limite 20) |
| `src/renderer/src/components/RemoteViewer.jsx` | Barra superior removida; fullscreen; captura resolucao remota via postMessage |
| `src/renderer/src/components/ConfigPanel.jsx` | Add/Remove de maquinas (ate 20) |
| `src/renderer/public/noVNC/vnc.html` | Status bar removida; scaleViewport removido; fitScreen() manual com CSS `max-width/max-height !important` + `object-fit: contain` |
| `docs/STATUS.md` | Atualizado |

### VNC Scaling

- `scaleViewport: false` + `resizeSession: false` — manual fitScreen() via CSS
- Canvas scaled com `width/height` em CSS proporcional ao container
- Fallback CSS: `max-width: 100% !important; max-height: 100% !important; object-fit: contain`
- ResizeObserver + window.resize + postMessage('resize-viewport') para re-escalar
- `desktopresolution` event captura resolucao remota e envia ao React

---

## [2026-07-29] VNC Scaling Rework + Zoom Fix

### Problema
1. **Tela VNC cortada (overflow)** — `scaleViewport: true` com CSS `max-width/max-height !important` causava conflito: noVNC calculava um scale, CSS sobrescrevia com outro, canvas ficava maior que o container
2. **Mouse tracking incorreto** — `absX(mouseX / _scale)` usava `_scale = 1` porque o CSS scalado externamente nunca atualizava `_display.scale` interno
3. **Zoom da pagina afetava sidebar** — Ctrl+Scroll/Electron View > Zoom escalonava a pagina inteira, sidebar oscilava de tamanho

### Causa
- `scaleViewport: true` faz noVNC chamar `_updateScale()` → `_rescale()` que seta `canvas.style.width/height` e `_display._scale`. O CSS `!important` sobrescrevia `canvas.style`, entao o canvas renderizava num tamanho mas `_scale` ficava em outro (1). Mouse coords dividiam por 1 em vez do scale real.
- Electron `zoom-changed` nao tinha handler, o zoom padrao escalonava o `webContents` inteiro.

### Solucao

**vnc.html:**
- `scaleViewport: false` — desliga scaling automatico do noVNC
- `fitScreen()` manual: calcula `scale = Math.min(containerW/fbW, containerH/fbH, 1)`
- Seta `rfb._display.scale = scale` — isso chama `_rescale()` internamente, que:
  - Atualiza `canvas.style.width/height` (sem CSS concorrente)
  - Atualiza `_display._scale` usado por `absX()`/`absY()` para traduzir mouse
- Fallback `getFbWidth()`/`getFbHeight()` lendo `rfb._fbWidth/_fbHeight` (o evento `desktopresolution` nunca dispara nessa versao do noVNC)
- Resolucao capturada no `connect` event e enviada como `vnc-resolution` ao parent
- `ResizeObserver` no canvas (criado apos connect) para mudancas dinamicas de resolucao do servidor
- CSS: `max-width/max-height !important` removidos; `overflow: hidden` no container

**main.js:**
- `mainWindow.webContents.on('zoom-changed')` → `setZoomLevel(0)` — impede que o zoom da pagina afete sidebar

### Arquivos Modificados
| Arquivo | Mudanca |
|---------|---------|
| `src/renderer/public/noVNC/vnc.html` | scaleViewport:false; fitScreen() manual com _display.scale; fallback _fbWidth/_fbHeight; ResizeObserver no canvas; removido max-width/max-height !important; resolucao capturada no connect |
| `src/main/main.js` | Adicionado handler zoom-changed para resetar zoom |

### Resultado
- Tela VNC cabe inteira no container sem corte
- Mouse clica no lugar correto no desktop remoto
- Sidebar nao oscila com zoom

---

## [2026-07-29] Otimizacoes de Conexao VNC

### Mudancas

**proxy.js (rede):**
- `tcpSocket.setNoDelay(true)` — desliga algoritmo de Nagle, dados saem sem bufferizar (menos latencia)
- `tcpSocket.setKeepAlive(true, 5000)` — detecta conexao morta em 5 segundos

**vnc.html (protocolo VNC):**
- `qualityLevel: 4` (era 6) — qualidade JPEG 4/9, reduz dados em ~30-50% sem degradacao visivel em texto/UI
- `compressionLevel: 3` (era 2) — compressao zlib 3/9, mais compressao com pouco impacto em CPU
- `keyboardDelay: 20` (era 50) — teclado responde 2.5x mais rapido (20ms vs 50ms)

### Arquivos Modificados
| Arquivo | Mudanca |
|---------|---------|
| `src/main/proxy.js` | Adicionado setNoDelay(true) + setKeepAlive(true, 5000) |
| `src/renderer/public/noVNC/vnc.html` | qualityLevel:4, compressionLevel:3, keyboardDelay:20 |

---

## [2026-07-30] Instalador NSIS + Auto-update

### Problema
O app so rodava via `npm run dev`, exigindo Node.js + terminal. Nao havia
instalador para distribuicao, nem mecanismo de atualizacao.

### Solucao

**1. electron-builder configurado (NSIS installer)**
- Instalador com licenca (MIT), escolha de pasta, atalhos desktop/start menu
- Desinstalador no "Adicionar/Remover Programas"
- Icone personalizado (.ico)

**2. Auto-update com electron-updater**
- `main.js` integra `autoUpdater` que verifica GitHub Releases na inicializacao
- Dialogos nativos: "Nova versao disponivel" / "Reiniciar agora?"
- IPC handler `app:checkUpdate` + preload exposto `checkForUpdates()`

**3. Script de build**
- `BUILD.bat` — um clique para gerar o instalador
- Roda `npm run build` + `electron-builder --win nsis`

### Arquivos Criados
| Arquivo | Descricao |
|---------|-----------|
| `docs/LICENSE.txt` | Licenca MIT para o instalador |
| `resources/icon.ico` | Icone do app (formato Windows ICO) |
| `BUILD.bat` | Script para gerar o instalador |

### Arquivos Modificados
| Arquivo | Mudanca |
|---------|---------|
| `package.json` | Adicionado electron-updater; config NSIS completa (licenca, icone, atalhos); publish GitHub |
| `src/main/main.js` | Import e setup do autoUpdater; dialogo de atualizacao; IPC app:checkUpdate |
| `src/main/preload.js` | Exposto `checkForUpdates()` no electronAPI |
