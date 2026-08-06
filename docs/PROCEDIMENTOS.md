# Procedimentos de Desenvolvimento

## Regra Geral

> **Antes de configurar algo novo no app:**
> 1. Feche o app completamente
> 2. Nao deixe ele abrir enquanto voce mexe
> 3. Depois que terminar de arrumar, abra ele

Isso evita que o Electron trave arquivos, que o Vite entre em conflito
com edicoes no config, ou que o nodemon reinicie o app no meio de uma
alteracao.

---

## 1. Fechar o App Completamente

### Metodo 1 — Taskkill (forca bruta)

Sempre que for comecar a editar, rode no PowerShell:

```powershell
Stop-Process -Name "electron" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
```

Ou no CMD:

```cmd
taskkill /F /IM electron.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
```

### Metodo 2 — Fechar a janela do Electron

Apenas fechar a janela ja encerra o Electron, mas o Vite pode continuar
rodando em background. Verifique com:

```powershell
Get-Process -Name "node"
```

Se o Vite ficou rodando, mate manualmente.

### Metodo 3 — Script start.vbs ja faz isso

O `start.vbs` ja executa o taskkill antes de iniciar tudo de novo.
Entao se voce so reiniciar, ele limpa os processos anteriores.

---

## 2. Impedir Que o App Abra Sozinho

Enquanto estiver editando arquivos:

- **Nao clique no atalho da area de trabalho**
- **Nao rode `npm run dev`**
- Se o nodemon estiver rodando e voce salvar um arquivo em `src/main/`,
  ele vai reiniciar o Electron automaticamente. Para evitar:

  ```powershell
  Stop-Process -Name "electron" -Force
  Stop-Process -Name "node" -Force
  ```

Depois que terminar TODAS as alteracoes, ai sim abra o app.

---

## 3. Impedir Janelas Indesejadas (CMD, Bloco de Notas, etc.)

### Problema

Quando o app inicia em modo dev, o `npm run dev` pode abrir:

- Janela de CMD para o Vite
- Janela de CMD para o Electron
- Bloco de notas se houver erro de configuracao
- Outros programas inesperados

### Solucao Implementada

O `start.vbs` ja resolve isso:

```vbscript
' Esconde completamente qualquer janela de terminal
WshShell.Run "cmd /c ...", 0, False
'                         ^ ^
'                         | +--- False = nao esperar
'                         +--- 0 = janela invisivel
```

### Se alguma janela indesejada aparecer mesmo assim

1. Feche a janela manualmente
2. Verifique se o atalho na area de trabalho esta apontando para
   `start.vbs` e nao para `start.bat`
3. O `start.vbs` esconde TODAS as janelas de terminal
4. Se ainda aparecer, pode ser erro no codigo — verifique os logs:

   ```powershell
   Get-Content "D:\ProjetosVS\TunelSSH\electron-err.log" -Tail 20
   Get-Content "D:\ProjetosVS\TunelSSH\electron-out.log" -Tail 20
   ```

### Forcar que nenhuma janela abra (modo seguro)

Se quiser garantir que nada abre alem do app:

```powershell
# 1. Limpar processos antigos
taskkill /F /IM electron.exe
taskkill /F /IM node.exe

# 2. Iniciar apenas o Vite (sem janela)
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList @(
  "node_modules\vite\bin\vite.js",
  "--config", "src/renderer/vite.config.js",
  "--host", "127.0.0.1"
)

# 3. Esperar Vite ficar pronto (ate 15s)
$timeout = 15
$ready = $false
for ($i = 0; $i -lt $timeout; $i++) {
  Start-Sleep -Seconds 1
  try {
    $wc = New-Object System.Net.WebClient
    $wc.DownloadString("http://127.0.0.1:5173/") | Out-Null
    $ready = $true
    break
  } catch {}
}

# 4. Iniciar Electron (sem janela de terminal)
if ($ready) {
  $env:NODE_ENV = "development"
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList @(
    "node_modules\electron\cli.js",
    "."
  )
}
```

---

## 4. Fluxo de Trabalho Ideal

### Editar arquivos do renderer (React)

1. App esta rodando? Se sim, pode editar — Vite HMR atualiza sozinho
2. Se o app nao estiver rodando: edite primeiro, depois abra

### Editar arquivos do main (Electron)

1. Feche o app (`Stop-Process`)
2. Edite os arquivos
3. Abra o app (`start.vbs` ou `npm run dev`)
4. O nodemon vai assistir e reiniciar automaticamente em alteracoes futuras

### Adicionar uma nova configuracao (geral)

1. `Stop-Process -Name "electron" -Force` + `Stop-Process -Name "node" -Force`
2. Verifique se nenhum processo sobrou: `Get-Process -Name "electron","node"`
3. Faca as alteracoes necessarias
4. Teste com `npm run dev`
5. Se funcionou, pode fechar e abrir pelo atalho normalmente

### Adicionar novo PC na config

Nao precisa fechar o app — clique no **"+"** na sidebar ou va em **Settings**
dentro do app. O limite e 20 PCs. Para remover, passe o mouse sobre o PC
na lista e clique no **"x"**.

---

## 5. Comandos Rapidos

| Acao | Comando |
|------|---------|
| Matar Electron | `Stop-Process -Name "electron" -Force` |
| Matar tudo (Electron + Node) | `Stop-Process -Name "electron","node" -Force` |
| Ver o que esta rodando | `Get-Process -Name "electron","node"` |
| Iniciar o app (janela invisivel) | Clique no atalho "OpenPortal Remote" |
| Iniciar o app (terminal visivel) | `npm run dev` |
| Ver logs do Electron | `Get-Content electron-out.log -Tail 20` |
| Ver erros do Electron | `Get-Content electron-err.log -Tail 20` |
| **Gerar instalador** | `BUILD.bat` (como Administrador) |
| **Verificar atualizacao** | `window.electronAPI.checkForUpdates()` no DevTools |

---

## 6. Checklist Antes de Abrir o App

- [ ] Todas as alteracoes foram salvas
- [ ] Nenhum processo do Electron ou Node esta rodando
- [ ] O arquivo de configuracao (se editado manualmente) esta em JSON valido
- [ ] O `vite.config.js` tem `host: '127.0.0.1'` (se foi alterado)
- [ ] O package.json esta com sintaxe correta (se foi alterado)
- [ ] Os arquivos .jsx nao tem erros de sintaxe obvios

---

## 7. Sessao para o Copilot / Assistente AI

Toda vez que fechar o VSCode e abrir de novo, o assistente AI (Copilot,
opencode, etc.) nao sabe nada sobre o projeto. Para ele entender como
o app funciona, siga este procedimento:

### Ao iniciar uma nova sessao

Digite para o assistente:

> "Leia todos os arquivos .md do projeto TunelSSH"

Isso faz o assistente ler estes arquivos na ordem:

| Arquivo | O que contem |
|---------|-------------|
| `docs/README.md` | Visao geral, instalacao, uso, solucao de problemas |
| `docs/STATUS.md` | Status atual, o que funciona, diagrama arquitetura |
| `docs/PLAN.md` | Plano de implementacao, arquitetura, decisoes tecnicas |
| `docs/HISTORY.md` | Historico de bugs e modificacoes |
| `docs/PROCEDIMENTOS.md` | Este arquivo — regras de desenvolvimento |
| `src/renderer/src/components/Dashboard.jsx` | Tela inicial com status do agente |

### Apos a leitura

O assistente vai entender:

- A arquitetura do app (Electron + React + Vite + Proxy WS/TCP)
- O estado atual do desenvolvimento
- Os bugs conhecidos e como foram resolvidos
- As regras de procedimento (fechar app antes de editar, etc.)
- A estrutura de arquivos e pastas

### Se o assistente ainda estiver confuso

Pergunte:

> "Leia os arquivos fonte em src/ para entender o codigo"

Isso fara ele ler os componentes React e o processo principal.

---

---

## 8. Fluxo de Build e Publicacao

### Gerar o Instalador

1. Feche o app (se estiver rodando)
2. Clique com botao direito no `BUILD.bat` → **Executar como administrador**
3. O script vai:
   - Compilar o renderer (Vite build)
   - Gerar o instalador na pasta `dist-electron/`
4. Saida: `dist-electron/OpenPortal Remote Setup X.X.X.exe`

### Publicar uma Atualizacao (GitHub Releases)

1. Altere a versao no `package.json` (ex: `"version": "1.0.1"`)
2. Rode `BUILD.bat` como administrador
3. Va em: `https://github.com/alexmiguel011014-stack/TunelSSH_OpenPortal/releases`
4. Clique em **"Create a new release"**
5. Tag version: `v1.0.1` (igual ao package.json)
6. Release title: `v1.0.1`
7. Anexe os arquivos da pasta `dist-electron/`:
   - `OpenPortal Remote Setup X.X.X.exe`
   - `OpenPortal Remote Setup X.X.X.exe.blockmap`
8. Publique a release

> O auto-update detecta a nova versao automaticamente na proxima vez
> que o usuario abrir o app instalado.

---

## 9. Checklist Antes de Publicar uma Release

- [ ] Versao atualizada no `package.json`
- [ ] `npm run build` compila sem erros
- [ ] Instalador gera sem erros
- [ ] Testar o instalador em maquina limpa (sem Node.js)
- [ ] .exe e .blockmap anexados na GitHub Release

---

*Ultima atualizacao: 2026-07-30*
