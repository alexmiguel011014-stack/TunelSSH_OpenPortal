# Arquitetura de Conexão — OpenPortal vs AnyDesk/TeamViewer

## 1. Como Funciona AnyDesk/TeamViewer

### Fluxo Simplificado

```
CLIENTE (Quer controlar)          SERVIDOR (PC a controlar)
         |                                    |
         | 1. Abre app                       | 1. Abre app
         | 2. Digita ID/código               |
         | 3. Envia: "Quero conectar"        |
         |                                   | 2. Recebe pedido
         |                                   | 3. Mostra: "User quer se conectar?"
         |                                   |    [Aceitar] [Rejeitar] [Senha?]
         |                                   |
         | <---- Resposta: Aceitar/Rejeitar <|
         |                                   |
         | 4a. Se ACEITAR: Cria túnel criptografado
         | 4b. Mostra tela remota + controle
         |                                   | 4a. Se ACEITAR: Libera acesso
         |                                   | 4b. Mostra status
         |
         | 5. Comunica via: Socket TCP/UDP criptografado
         | 6. Dados: Video (H264), Áudio, Mouse, Teclado
```

### Características Principais

✅ **Identificação**

- ID único global (ex: "482917356" no AnyDesk)
- Qualquer pessoa pode descobrir seu ID e tentar conectar
- Servidor DEVE estar rodando para receber conexões

✅ **Autenticação**

- Aprovação manual obrigatória (Aceitar/Rejeitar)
- Opcional: Senha adicional de segurança
- A senha pode variar por conexão (não é fixa)

✅ **Autenticação Extra**

- Se você configurar "Senha de acesso" → obrigatória pra TODAS as conexões
- Se você configurar "Senha de segurança" → sorteada, mostrada na tela, muda cada vez

✅ **Transporte**

- Servidor conhece seu próprio IP/porta
- Criptografia de ponta-a-ponta
- Se não puder conectar direto → usa relay (servidor deles)

✅ **Sessão**

- Apenas UM usuário remoto por vez (em geral)
- Pode bloquear mouse/teclado do usuário local

---

## 2. Como Funciona Seu OpenPortal Remote

### Fluxo Atual

```
CLIENTE (App local)               SERVIDOR (App remoto)
         |                                    |
         | 1. Abre app                       | 1. Abre app
         | 2. Configura: IP Tailscale        |
         | 3. Clica "Conectar" a um PC       |
         |                                   |
         | 4. Envia: "Quero conexão" via     |
         |    porta 18902 (TCP Signal)       |
         |                                   | 2. Recebe em port 18902
         |                                   | 3. Mostra diálogo:
         |                                   |    "User quer se conectar?"
         |                                   |    [Aceitar] [Rejeitar]
         |                                   |
         | <---- Resposta: Approved (true/false) <|
         |                                   |
         | 5a. Se APPROVED:
         |     - Socket permanece aberto
         |     - Vira túnel de arquivos
         |     - VNC conecta sem pedir senha
         |                                   |
         | 5b. Conecta ao VNC (porta 5900)   |
         |     via Proxy WebSocket 18900     |
         |                                   |
         | 6. Comunica: noVNC (Mouse, Teclado, Video)
```

### Características Atuais

✅ **Identificação**

- Precisa saber o IP Tailscale do PC remoto
- Tailscale já gerencia a autenticação entre os dois
- Servidor DEVE estar rodando

✅ **Autenticação**

- Aprovação manual por padrão — **mas** identidades Tailscale (e-mail de login,
  resolvido via `tailscale whois` sobre o IP real do socket) cadastradas na
  lista `allowedUsers` desta máquina pulam o diálogo e entram direto. Quem não
  está na lista continua vendo o diálogo manual normalmente. Ver
  `src/main/connection/identity.js` e a seção "Auto-aprovação de conexões" em
  Configurações.
- Sem senha (você removeu propositalmente)
- Fallback: senha VNC opcional (o que implementamos)

✅ **Transporte**

- Usa Tailscale (já criptografado)
- Proxy WebSocket intermediário (18900)
- VNC por RFB nativo

✅ **Sessão**

- Múltiplas conexões simultâneas: cada PC conectado mantém sua sessão (VNC +
  arquivos) viva em segundo plano. A UI mostra uma tela em foco por vez;
  trocar de PC não desconecta os outros.
- Aprova conexão a cada tentativa (não fica salvo)

> **Modelo de estado (multi-sessão):** o renderer guarda um mapa
> `connectedMachines` (chave = id da máquina → `{ machine, ftSessionId }`) e um
> `focusedMachineId` separado para qual está visível — ver
> `src/renderer/src/App.jsx`. Trocar o foco só troca `focusedMachineId`;
> desconectar remove apenas aquela entrada do mapa. Cada máquina conectada tem
> sua própria instância de `RemoteViewer` (iframe) montada; instâncias fora de
> foco ficam ocultas (`display: none`), nunca desmontadas — desmontar
> derrubaria a sessão VNC (o socket mora dentro do iframe). O Explorador de
> Arquivos sempre segue a máquina em foco, sem seletor próprio. Nenhuma
> mudança foi necessária no proxy WebSocket (`proxy.js`) nem na sessão de
> arquivos (`file-transfer-session.js`): ambos já eram indexados por
> conexão/host, nunca por "a" conexão ativa — só o estado do renderer tinha
> essa limitação.

> **Setup da auto-aprovação:** cada pessoa que deve auto-aprovar precisa do
> **próprio** login Tailscale — um login compartilhado entre várias pessoas
> quebra a identificação, já que `tailscale whois` devolveria o mesmo e-mail
> para todo mundo que o usa. O plano gratuito do Tailscale já suporta até 6
> contas de usuário separadas em uma tailnet.

### Painel de Atividade (push entre máquinas)

Cada sessão de arquivos que termina numa máquina pode ser reportada, em
tempo real, para outras identidades Tailscale — pensado para um professor
acompanhar o uso de várias máquinas de alunos sem precisar entrar em cada
uma. Nenhum servidor novo: reaproveita a mesma porta de sinalização (18902)
que já recebe pedidos de conexão, com um novo tipo de mensagem
`{ type: 'activity-event', ... }` — fire-and-forget, sem diálogo, sem
resposta esperada (ver `src/main/connection/connection-request.js`).

**Fluxo:**

1. Uma sessão de arquivos fecha (`file-session-close`) em `src/main/main.js`.
2. Monta o evento `{ identity, machineName, startedAt, endedAt, durationMs,
filesTransferred }` — `identity` vem sempre da resolução `tailscale whois`
   (GOALS 3), nunca do nome auto-declarado pelo cliente.
3. Para cada login em `reportTo` (configurado em Configurações, nesta
   máquina), resolve o IP Tailscale atual via `tailscale status --json`
   (`resolveLoginToIp` em `identity.js`) e envia o evento para a porta 18902
   daquele IP.
4. Se o destino estiver inalcançável, o envio é descartado silenciosamente —
   best-effort, não há fila nem retry. A sessão em si não é afetada, só o
   aviso ao vivo não chega.
5. Quem recebe (qualquer instância do app, também sempre ouvindo na 18902)
   persiste em `activity.json` (`src/main/config/activity-log.js`), mostra
   uma notificação do SO e atualiza o painel "Atividade" ao vivo via IPC.

**Alerta opcional por Telegram:** o mesmo evento, se habilitado nas
Configurações desta máquina, também vira uma mensagem de texto enviada via
`telegraf` — ver `docs/TELEGRAM_SETUP.md`. É uma camada extra, não o
mecanismo de entrega: o painel in-app funciona inteiro sem isso.

### RDP nativo (transporte alternativo ao VNC)

Selecionável **por máquina** em Configurações (campo "Transporte") — VNC
continua sendo o padrão, nenhuma máquina já cadastrada muda de
comportamento sozinha (`resolveTransport()` em
`src/renderer/src/shared/lib/connectionState.js` trata qualquer valor
diferente de `"rdp"`, incluindo ausente, como `"vnc"`).

**Por que existe, além do VNC:** usa o próprio Remote Desktop do Windows
(via controle ActiveX `MSTSCLib`, o mesmo que o `mstsc.exe` embute) em vez
de reimplementar o protocolo RDP em JS — isso evita o trade-off de
segurança que as bibliotecas JS disponíveis (`node-rdpjs`, `mstsc.js`,
ambas abandonadas — ver GOALS.md) exigiriam: desabilitar NLA (Network
Level Authentication) em cada máquina de destino. Com MSTSCLib, NLA
continua ligado — nada muda na autenticação do Windows.

**Por que precisa de um processo sidecar:** o Chromium/Electron não hospeda
controles ActiveX/COM dentro do próprio renderer. A solução é um processo
nativo separado (C#/.NET Framework 4.8 WinForms, `sidecar/`) que hospeda o
controle em sua própria janela nativa, reparented (Win32 `SetParent`) para
dentro do HWND do `BrowserWindow` do Electron — visualmente parece estar
"dentro" do app, como o `<iframe>` do noVNC, mas é uma janela do SO real
sobreposta à área de um `<div>` posicionado pelo React
(`RdpViewer.jsx`), não conteúdo do DOM.

**Canal de comando (named pipe):** o processo principal (`rdp-sidecar.js`)
sobe uma sidecar por máquina RDP conectada (`spawn`) e fala com ela por um
named pipe local — nunca por argv, para a senha nunca aparecer em
Task Manager/`Get-Process`. Uma linha JSON por comando
(`rdp-protocol.js`/`sidecar/Program.cs`):

```
{"cmd":"connect","host":"100.x.x.x","port":3389,"username":"u","password":"p"}
{"cmd":"resize","x":10,"y":10,"w":800,"h":600}
{"cmd":"visibility","visible":true}
{"cmd":"disconnect"}
```

`resize` acompanha o `<div>` do `RdpViewer` (via `ResizeObserver`, em
pixels físicos — multiplicados por `devicePixelRatio`, já que
`SetWindowPos` do Win32 não conhece pixels lógicos do DOM).
`visibility` existe porque a janela nativa **não é filha do DOM**: um
`display:none` no `<div>` do React não a esconde — ao trocar de foco entre
várias máquinas conectadas (GOALS 1), o processo principal precisa
esconder/mostrar a sidecar explicitamente.

**Sem mudança em `proxy.js`:** ao contrário do VNC/noVNC (código de
navegador, só alcança a rede via o bridge WS→TCP de `proxy.js`), a sidecar
é um processo nativo que abre sua própria conexão TCP direta à porta 3389
do destino. O fluxo de aprovação existente
(`connection-request.js`/`handleConnectionRequest`) continua sendo o
único portão de entrada, igual ao VNC — RDP não pula essa etapa.

**Provisionamento (uma vez por máquina, feito na aba Configurações da
própria máquina de destino, não em quem conecta):**

1. _Habilitar Remote Desktop_ — liga `fDenyTSConnections=0` no registro e a
   regra de firewall "Remote Desktop", via PowerShell elevado
   (`src/main/system/rdp-provisioning.js`). Abre um prompt de UAC; nenhuma
   mudança em NLA.
2. _Criar conta dedicada_ — cria uma conta local do Windows só para o app
   usar (senha aleatória gerada uma vez, nunca a senha pessoal de quem está
   logado ali), adicionada ao grupo "Remote Desktop Users". A senha só
   aparece uma vez na tela — precisa ser copiada para o campo "Senha RDP"
   de quem for configurar esta máquina como RDP no próprio app.

**Controle ActiveX (MSTSCLib via Devolutions/MsRdpEx):** `sidecar/Program.cs`
hospeda um `AxMsRdpClient11NotSafeForScripting` (a versão mais nova de
cliente que o pacote expõe) dentro do `SidecarForm`. Os assemblies de
interop (`Interop.MSTSCLib.dll`/`AxInterop.MSTSCLib.dll` — exatamente o que
`aximp`/`tlbimp` gerariam à mão a partir de `mstscax.dll`) vêm prontos do
pacote NuGet `Devolutions.MsRdpEx`, modo "Legacy" (padrão do pacote para
net48) — nada foi gerado manualmente. `PackageReference` funciona no
`.csproj` clássico (não SDK-style) porque o MSBuild do VS Build Tools já
traz seus próprios targets de restore do NuGet; não precisou instalar mais
nada. `EnableCredSspSupport = true` (em `AdvancedSettings7`) é o que mantém
NLA ligado no servidor — o motivo desta arquitetura existir em vez de uma
lib RDP em JS. `SmartSizing` (em `AdvancedSettings2`) deixa o controle
escalar o desenho para o tamanho do container sem renegociar a resolução
remota a cada `resize`.

**Estado atual (2026-09-16):** o encaixe visual (embedding), o canal de
comando e o controle MSTSCLib em si estão implementados e ligados ao fluxo
real de conexão/desconexão (GOALS 1's `connectedMachines`, sem um segundo
modelo de estado paralelo). Testado (smoke test) contra `127.0.0.1:3389`
com credenciais fictícias — só para provar que `Connect()` não derruba a
sidecar, sem máquina real nem credencial real envolvida. **Ainda não
verificado**: uma sessão RDP de verdade, autenticada, contra uma máquina
Pro/Enterprise/Education real com hospedagem RDP habilitada — isso
continua exigindo uma máquina física fora do alcance deste ambiente de
desenvolvimento (ver GOALS.md, item de verificação manual).

---

## 3. Comparação Lado-a-Lado

| Aspecto                    | AnyDesk/TeamViewer                  | OpenPortal Remote                                                          |
| -------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| **Identificação**          | ID global único                     | IP Tailscale (deve saber antes)                                            |
| **Discovery**              | Fácil (qualquer um descobre seu ID) | Difícil (precisa estar na rede Tailscale)                                  |
| **Aprovação**              | Obrigatória + Opcional senha        | Manual, com auto-aprovação opcional por identidade Tailscale allow-listada |
| **Identidade do Servidor** | ID público                          | IP privado (Tailscale)                                                     |
| **Conhecimento prévio**    | Não (só o ID)                       | Sim (precisa do IP)                                                        |
| **Transportes**            | TCP + UDP, próprio protocolo        | Tailscale + WebSocket + RFB                                                |
| **Criptografia**           | Nativa                              | Tailscale cuida                                                            |
| **Unidade remota**         | Sua                                 | TightVNC (separado)                                                        |

---

## 4. Problemas Atuais no Seu Projeto

### ⚠️ Problema 1: Falta de Identificação Global

**Situação:**

- Você precisa saber o IP Tailscale do PC remoto ANTES
- Se você tem 10 PCs remotos, precisa gerenciar 10 IPs
- Não há registro central (como AnyDesk)

**Impacto:**

- Difícil adicionar novos PCs
- Propenso a erros de digitação de IP
- Sem forma de "descobrir" PCs remotos automaticamente

**Solução possível:**

- Criar registro central (banco de dados, arquivo na nuvem)
- Ou usar ID único + lookup de IP via Tailscale

---

### ⚠️ Problema 2: Sem Senha Pré-Configurada (Atualmente)

**Situação:**

- Você removeu a senha para simplificar
- Mas isso deixa o system dependente APENAS da aprovação
- Se o PC remoto estiver desatendido, qualquer um pode aprovar!

**Impacto:**

- Segurança reduzida em ambientes compartilhados
- Sem fallback se a aprovação falhar por motivo legítimo

**O que implementamos:**

- Você agora pode configurar senha VNC como fallback ✅
- Se rejeitar → pede senha
- Se aceitar → entra direto

---

### ⚠️ Problema 3: VNC é Separado (TightVNC é software externo)

**Situação:**

- Seu app não CONTROLA o TightVNC
- TightVNC tem sua própria UI, senhas, configurações
- Você não pode "desativar" ou "ativar" o VNC via app

**Impacto:**

- Confusão: é a senha do VNC ou da aprovação?
- Duas camadas de autenticação descoordenadas
- Dificuldade em configurar em massa

**Solução:**

- Integrar um servidor VNC nativo no Electron (não é simples)
- Ou aceitar que é sempre preciso configurar TightVNC manualmente

---

### ⚠️ Problema 4: Lógica Confusa (Aprovação vs Autenticação)

**Situação:**

- Quando rejeita → socket fecha
- Mas VNC ainda tenta conectar
- Usuário não sabe se foi rejeição ou autenticação normal

**Impacto:**

- Mensagens de erro confusas
- Fluxo de UX ruim
- Código difícil de manter

**Solução:**

- Passar `rejected: true` explicitamente para vnc.html
- Se rejeitado → erro claro "Conexão recusada"
- Se aprovado → conecta direto

---

## 5. O Que Você DEVERIA Fazer (Recomendações)

### ✅ Curto Prazo (Agora)

```javascript
// 1. Corrigir a lógica de aprovação/rejeição
//    → Implementar "rejected: true" explícito
//    → Passar para vnc.html via URL
//    → Se rejeitado: erro claro, sem tentar VNC

// 2. Melhorar mensagens de erro
//    → "Conexão recusada pelo PC remoto"
//    → "VNC pede senha (configure em Configurações)"
//    → "Tailscale não alcança o IP"

// 3. Documentar o fluxo
//    → Deixar claro: Aprovação é trava principal
//    → Senha VNC é fallback/segurança extra
```

### ⚠️ Médio Prazo (Próximas releases)

```javascript
// 1. Adicionar registro central de PCs
//    → Arquivo JSON na nuvem (OneDrive, Dropbox)
//    → Ou banco de dados simples (Firebase)
//    → Permite: descobrir IPs, compartilhar lista entre usuários

// 2. Senhas pré-configuradas por PC
//    → Cada PC tem sua senha salva no config
//    → Mais seguro que ID único global
//    → Você já implementou isso ✅

// 3. Melhorar UX da aprovação
//    → Mostrar: "PC X em 192.168.1.10"
//    → Mostrar: "Usuário: Seu Computador (100.x.x.x)"
//    → Opção: "Lembrar esta aprovação por 5 min"
```

### 🚀 Longo Prazo (Arquitetura)

```javascript
// 1. Considerar integrar servidor VNC nativo
//    → noVNC.core (JavaScript VNC server)
//    → Ou compilar TightVNC como módulo
//    → Daria controle total de autenticação

// 2. Autenticação em dois níveis INTEGRADA
//    → Nível 1: Aprovação do app
//    → Nível 2: Senha gerenciada pelo app (não TightVNC)
//    → Você controla tudo

// 3. Identificação central
//    → Cada PC remoto = ID único + IP Tailscale
//    → Servidor central conhece todos
//    → Cliente pode "buscar" ou "digitar" ID
```

---

## 6. Sua Arquitetura NÃO Está Longe

**Longe NÃO está:**

- Você tem a base certa (Tailscale + Aprovação)
- Você tem a UI (React + Sidebar)
- Você tem o transporte (WebSocket proxy)
- Você tem arquivos (túnel multiplexado)

**Diferenças:**

1. Falta identificação central (você precisa saber IPs)
2. VNC é separado (TightVNC, não integrado)
3. Lógica de aprovação é confusa (sem feedback claro)

**Próximos passos sensatos:**

1. ✅ Corrigir aprovação/rejeição (semana 1)
2. ✅ Melhorar mensagens de erro (semana 1)
3. Adicionar senhas por PC (já feito ✅)
4. Testar tudo em produção
5. Se funcionar bem → considerar ID central depois

---

## 7. Checklist de Funcionalidade vs AnyDesk

| Feature                         | AnyDesk | OpenPortal     | Status   |
| ------------------------------- | ------- | -------------- | -------- |
| Controle remoto (Mouse/Teclado) | ✅      | ✅             | Funciona |
| Transferência de arquivos       | ✅      | ✅             | Funciona |
| Múltiplos PCs                   | ✅      | ✅             | Funciona |
| Aprovação obrigatória           | ✅      | ✅             | Funciona |
| Senhas de acesso                | ✅      | ✅ (novo)      | Funciona |
| ID único descobrível            | ✅      | ❌             | Não tem  |
| Descoberta automática de PCs    | ✅      | ❌             | Não tem  |
| Histórico de conexões           | ✅      | ✅             | Funciona |
| Notificações                    | ✅      | ✅             | Funciona |
| Suporte a VPN                   | ✅      | ✅ (Tailscale) | Funciona |
| Chat/Suporte remoto             | ✅      | ❌             | Não tem  |

---

_Conclusão: Seu projeto está 80% completo. Faltam 20% de "polimento" e identificação central._

_Última atualização: 2026-08-07_
