# OpenPortal Remote

Acesso remoto seguro a PCs Windows via Tailscale + TightVNC + Electron.

---

## Sumário

- [O que precisa instalar](#o-que-precisa-instalar)
- [Passo a passo completo](#passo-a-passo-completo)
  - [1. Tailscale (VPN)](#1-tailscale-vpn)
  - [2. TightVNC Server](#2-tightvnc-server)
  - [3. OpenPortal Remote](#3-openportal-remote)
- [Como usar](#como-usar)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Solução de problemas](#solucao-de-problemas)

---

## O que precisa instalar

| App | Onde baixar | Pra que |
|-----|-------------|---------|
| **Tailscale** | https://tailscale.com/download | VPN gratuita que conecta os PCs |
| **TightVNC Server** | https://www.tightvnc.com/download.php | Servidor VNC no PC remoto |
| **Node.js** | https://nodejs.org (v18+) | Para rodar o app em desenvolvimento |
| **OpenPortal Remote** | Este projeto | Interface para conectar via VNC |

---

## Passo a passo completo

### 1. Tailscale (VPN)

O Tailscale cria uma rede privada entre seus PCs sem precisar abrir portas no roteador.

**Em CADA PC que voce quer conectar:**

1. Baixe e instale o Tailscale de https://tailscale.com/download
2. Crie uma conta (Google / Microsoft / GitHub)
3. Faça login no Tailscale em cada PC **com a mesma conta**
4. Anote o IP Tailscale de cada maquina (aparece no menu da bandeja do Windows:
   `100.x.x.x`)

> Todos os PCs precisam estar logados no **mesmo** Tailscale account.

### 2. TightVNC Server

Instale no PC que voce quer **acessar remotamente** (o PC alvo).

1. Baixe de https://www.tightvnc.com/download.php
2. Durante a instalacao, escolha:
   - **Install service** (para rodar em segundo plano)
   - Defina uma **senha de acesso** (ex: `MinhaSenha123`)
   - Marque "Register application for automatic startup"
3. Após instalado, o TightVNC roda como servico no PC alvo na porta **5900**
4. Para verificar: clique com botao direito no icone do TightVNC na bandeja
   e veja se esta "Listening on port 5900"

### 3. OpenPortal Remote

**No PC que voce vai usar para controlar:**

1. Instale o Node.js de https://nodejs.org (v18 ou superior)
2. Abra o terminal (PowerShell) e confirme:
   ```
   node --version
   npm --version
   ```
3. Clone ou copie a pasta do projeto para o seu PC
4. Instale as dependencias:
   ```
   cd "D:\ProjetosVS\TunelSSH"
   npm install
   ```
5. Inicie o app:
   ```
   npm run dev
   ```
   Ou clique duas vezes no atalho **"OpenPortal Remote"** da area de trabalho
   (se foi criado).

> Na primeira vez que rodar, pode demorar alguns segundos para o Vite
> iniciar e o Electron abrir a janela.

---

## Como usar

### Configurar as maquinas

1. Abra o app
2. Clique no botao de engrenagem na sidebar ou va em **Settings**
3. Para adicionar um PC novo: clique em **"+"** ou **"Add PC"**
4. Para remover: passe o mouse sobre o PC na lista e clique no **"x"**
5. Limite maximo: **20 PCs**

### Conectar

1. Na barra lateral, clique no PC desejado
2. O iframe do noVNC carrega e tenta conectar
3. Status aparece na sidebar na secao **"Conectado"** expandida
4. Para reconectar: use o botao **Reconnect** na sidebar
5. Para desconectar: clique no **"Disconnect"** na sidebar

### Sidebar recolhivel

- Clique no icone de **hamburguer** (3 barrinhas, canto superior esquerdo)
  para recolher/expandir a sidebar
- Quando recolhida, o VNC ocupa a tela inteira

### Logs

Clique em **"Logs"** dentro da sidebar para ver o terminal de depuracao
com todas as mensagens do app.

---

## Estrutura do projeto

```
TunelSSH/
+-- README.md           Instrucoes de uso
+-- STATUS.md           Status atual do desenvolvimento
+-- PLAN.md             Plano de implementacao detalhado
+-- HISTORY.md          Historico de bugs e modificacoes
+-- package.json        Dependencias e scripts
+-- start.bat           Iniciar o app (terminal visivel)
+-- start.vbs           Iniciar o app (sem janela de terminal)
|
+-- src/
|   +-- main/           Processo principal (Electron)
|   |   +-- main.js             Janela, atalhos, inicializacao
|   |   +-- preload.js          Ponte segura entre processos
|   |   +-- proxy.js            Proxy WebSocket <-> TCP
|   |   +-- config-manager.js   Leitura/escrita de config
|   |   +-- ipc-handlers.js     Comunicacao entre processos
|   |
|   +-- renderer/       Interface grafica (React)
|       +-- src/
|           +-- App.jsx              Layout principal
|           +-- main.jsx             Entry point React
|           +-- components/
|               +-- Sidebar.jsx      Barra lateral
|               +-- RemoteViewer.jsx  Iframe noVNC
|               +-- ConfigPanel.jsx  Tela de configuracao
|               +-- StatusBadge.jsx  Indicador de status
|               +-- Terminal.jsx     Terminal de logs
```

---

## Solucao de problemas

### "ERR_CONNECTION_REFUSED" ao abrir o app

**Causa:** Vite pode estar ouvindo em IPv6 em vez de IPv4.
**Solucao:** Verifique se o `vite.config.js` tem `host: '127.0.0.1'`.

### O app abre mas a tela fica preta/cinza

1. Pressione `Ctrl+Shift+I` para abrir o DevTools
2. Va na aba **Console** e veja se há erros vermelhos
3. Se vir erro de conexao com o Vite, reinicie o app

### A sidebar aparece mas o VNC nao conecta

1. Confirme que o Tailscale esta rodando nos dois PCs
2. Teste o ping: `ping 100.x.x.x` (do PC local para o remoto)
3. Confirme que o TightVNC esta rodando no PC remoto:
   `netstat -ano | findstr 5900`
4. Verifique se a senha VNC esta correta no arquivo de config

### Esqueci a senha do VNC

A senha é a que voce definiu na instalacao do **TightVNC Server**
no PC remoto. Para alterar:
1. Abra o TightVNC no PC remoto (icone da bandeja)
2. Va em "Configuration" e mude a senha

### O F12 nao abre o DevTools

Use o menu: **View > Toggle Developer Tools** ou atalho
**Ctrl+Shift+I**.

---

## Tamanho do projeto

O projeto completo ocupa aproximadamente **~603 MB** no disco,
sendo:
- `node_modules/`: ~602 MB (dependencias)
- `src/`: ~0,22 MB (codigo fonte)
- Demais arquivos: < 1 MB

---

## Licenca

Projeto privado - OpenPortal Remote.
