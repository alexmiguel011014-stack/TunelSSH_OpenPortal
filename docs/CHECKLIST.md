# Checklist de Retomada — TunelSSH_OpenPortal

> **Finalidade:** Este arquivo permite retomar o trabalho exatamente onde paramos, mesmo que a conexão caia no meio de uma sessão. Atualize os status (`[ ]`/`[x]`) ao concluir cada item e commite-o junto das mudanças.

Última atualização: 2026-08-05
Último commit aplicado e enviado: `5776276`

---

## 1. Estado ATUAL do repositório (snapshot)

- **Branch:** `master` (sincronizado com `origin/master`).
- **Último commit:** `ed25bf7` — "feat: esconde menu nativo, move barra VNC para o topo e atualizacoes para a sidebar".
- **Worktree:** limpo (somente arquivos soltos NÃO commitados: `Trusted Root Certification Authorities`, `build-log.txt`, `icone.png` — nunca commitar).
- **Remote:** `origin https://github.com/alexmiguel011014-stack/TunelSSH_OpenPortal.git`.
- **Regras (AGENTS.md / rules.md):** commitar e dar `git push` após cada mudança validada; NUNCA criar release/instalador sem ordem explícita; validar com `npm run build` + `node --check`.

---

## 2. Como retomar após queda de conexão

1. Leia este arquivo e identifique o primeiro item pendente (`[ ]`).
2. Confirme o estado do git: `git status` / `git log --oneline -5`.
3. Faça a mudança, valide (`npm run build`, `node --check <arquivo>`).
4. `git add` (somente arquivos intencionais) → `git commit` → `git push origin master`.
5. Atualize este checklist (marque `[x]`) e commite.

---

## 3. Melhorias de CONFIÂNCIA de conexão — APROVADAS para executar

> O usuário pediu: executar TUDO o que está listado abaixo (as melhorias de confiabilidade entre PCs + permeabilidades). Fazer mapa por prioridade.

### 🔴 Alta prioridade

- [x] **Heartbeat / ping periódico** no proxy TCP + WebSocket (ex.: a cada 30s). Detectar desconexão silenciosa (rede cai sem TCP RST) e emitir `vnc:status`/`ft:status` com `state:'disconnected'`. Hoje só existe `IDLE_TIMEOUT=30min` em `proxy.js` e timeouts por operação em `file-transfer.js` — sem heartbeat.
- [x] **Retry automático em `connection-request.js`** (timeout 15s): 2–3 tentativas com ~5s de intervalo antes de falhar; expor opção de reenvio.
- [x] **Indicador de saúde VNC na Sidebar**: ponto verde/vermelho ao lado do PC com base em `statuses[machine.id]` (reintroduzir um status discreto, sem o painel "Conectado" removido em `f7f4ca1`).

### 🟡 Média

- [x] **Retry automático VNC** na `RemoteViewer` ao detectar `vnc-status:'disconnected'|'error'`: backoff exponencial (3s→5s→10s, até ~5 tentativas) + opção manual "Reconectar".
- [x] **Detecção de rede Tailscale** antes de conectar: avisar se o IP não for 100.x.x.x / 10.x.x.x / 172.x.x.x (evita erro comum).
- [x] **Resume de transferência** interrompida (download retomando de um byte offset / upload do último chunk confirmado) — esforço alto; validar protocolo.

### 🟢 Baixa

- [x] **Histórico de conexões** (array circular últimas 50) com timestamp e sucesso/falha para diagnóstico.
- [x] **Teste de conexão rápido** (tcping/socket probe IP:porta) na tela de configuração / Sidebar.
- [x] **Notificações de sistema** (Notification API do renderer): "Download concluído", "Conexão perdida", etc.
- [x] **Atalhos de teclado globais**: ex.: F1 tela cheia no VNC (já existe F12 para devtools via `globalShortcut`).
- [x] **Tema claro/escuro** alternável.

### 🐛 Bug fix (sobreposição de UI)

- [x] **Barra VNC sobrescrevendo o hambúrguer da sidebar**: quando a sidebar estava recolhida, a barra de controles do VNC (dimensão, tela cheia, desconectar, etc.) ficava por cima do botão hambúrguer no topo-esquerdo. Corrigido com `paddingLeft: '44px'` no `<div>` da barra de controles em `RemoteViewer.jsx`, garantindo que o conteúdo da barra não alcance a área do hambúrguer.

### 🗂️ Files UI (Explorador de Arquivos estilo Windows)

- [x] **Arquitetura agradável**: `FilePanel` refatorado em sub-componentes (`BreadcrumbBar`, `FileToolbar`, `FileRow`) + helper `fileIcons.js`, tornando a listagem mais parecida com o Explorador do Windows.
- [x] **Visual separado por arquivo**: linhas com mais respiro (`7px 12px`), efeito hover, seleção com borda azul, pastas em negrito, ícones por tipo de arquivo (imagem, vídeo, PDF, doc, código, compactado…).
- [x] **Toggle de visualização**: botões "Lista" / "Ícones" no toolbar; a visão "Ícones" exibe um grid de cards grandes como o Explorer em "Ícones extras".
- [x] **Upload pergunta destino**: ao enviar, um modal (`UploadDialog`) pergunta onde soltar o arquivo no PC remoto (antes só o download perguntava).

---

## 4. Estado das fases de interface (já concluídas — apenas referência)

- [x] **Fase 1 — Tela Files** (commit `7302228`): busca, ordenação, selecionar todos, progresso detalhado, bloqueio durante transferência, breadcrumbs confiéis, ações centrais.
- [x] **Fase 2 — UX app-wide** (commit `2ad64bc`): sidebar (PT + logs com filtro/busca/exportar), dashboard objetivo, barra VNC (reconectar/tela cheia/qualidade/desc), ConfigPanel com validação, StatusBadge PT.
- [x] **Remoções Sidebar** (commit `f7f4ca1`): removido painel de logs, seção "Conectado" e botão Settings.
- [x] **Menu nativo + VNC top bar + Atualizações na Sidebar** (commit `ed25bf7`): menu nativo escondido (`autoHideMenuBar` + `setMenuBarVisibility(false)`), barra VNC fixa no topo (não mais sobreposta), botão "🔄 Atualizações" na Sidebar.

**Avançar daqui:** implementar os itens da Seção 3 (confiança de conexão).

---

## 5. Se estiver em modo dev / teste local

- Atalho de teste: `OpenPortal Remote - Local.lnk` → executa `scripts/start.vbs` → `npm run dev`.
- Executável instalado antigo (`OpenPortal Remote.exe` na Área de Trabalho) NÃO deve ser usado para testar (fica desatualizado).
- Fechar app sempre que editar código principal (`src/main/*`): `Stop-Process -Name electron -Force`.

---

## 6. Validações padrão antes de commitar

- `npm run build` (frontend vite, deve dar "✓ built in ...")
- `node --check src/main/<arquivo>.js` (processo principal)
- `git diff --check` (sem espaÃ§o/trailing)
- Só commitar arquivos intencionados; nunca secrets nem os 3 arquivos soltos citados.