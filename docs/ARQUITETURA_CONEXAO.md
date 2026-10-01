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
controle. Cada máquina escolhe um dos modos: `embedded` usa Win32 `SetParent`
para encaixar a janela no `BrowserWindow`; `native-window` mantém a janela
WinForms separada; `auto-fallback` começa embutido e abre, no máximo uma vez,
a janela separada somente se o primeiro evento nativo falhar depois de
`ConnectReturned`. Falhas de pipe, comando ou prontidão são erros locais, não
evidência de incompatibilidade de embedding. Todos os
modos usam o mesmo ActiveX, NLA e pipe privado — o fallback não muda protocolo
nem autenticação.

**Canal de comando (named pipe):** o processo principal (`rdp-sidecar.js`)
sobe uma sidecar por máquina RDP conectada (`spawn`) e fala com ela por um
named pipe local — nunca por argv, para a senha nunca aparecer em
Task Manager/`Get-Process`. Uma linha JSON por comando
(`rdp-protocol.js`/`sidecar/Program.cs`):

```
{"cmd":"connect","host":"100.x.x.x","port":3389,"username":"u","password":"p","lifecycleId":"..."}
{"cmd":"resize","x":10,"y":10,"w":800,"h":600,"lifecycleId":"..."}
{"cmd":"visibility","visible":true,"lifecycleId":"..."}
{"cmd":"disconnect","lifecycleId":"..."}
```

O pipe duplex é aberto com `PipeOptions.Asynchronous`: leitura de comandos e
escrita de estados usam operações overlapped independentes. A thread do
WinForms/ActiveX nunca escreve no pipe; ela apenas tenta inserir um snapshot
sanitizado numa fila FIFO limitada a 256 itens, e uma thread de transporte é a
única escritora. Fila cheia, cliente que parou de ler ou pipe rompido encerram
a geração dona, em vez de bloquear pintura, entrada, `Connect()` ou callbacks
COM. Não há framework IPC ou serializador novo: o contrato continua sendo JSON
por linha sobre o named pipe do .NET Framework. Sua ACL permite acesso apenas
à conta Windows que iniciou a sidecar; o nome aleatório por geração não
substitui essa restrição.

**Decisão do transporte (G7-R4/C1, medida em 2026-09-24):** o modo `ipc-test`
da sidecar aceita um 10º argumento só para esta comparação (`sync-duplex`,
`async-duplex` ou `split`) e, com ele, escreve no stderr o início e o fim de
cada leitura de comando e escrita de estado, com a thread (`ui` ou `worker`).
O bloco "IPC transport comparison (G7-R4)" de `rdp-sidecar-binary.test.js`
roda o mesmo probe contra o executável real nos três transportes
(`RDP_IPC_REPORT=1` imprime a tabela):

| Transporte                 | Probe sem 2ª escrita                                                | 100 respostas | Ordem      | Parada (disconnect → saída)                                       | CPU do processo |
| -------------------------- | ------------------------------------------------------------------- | ------------- | ---------- | ----------------------------------------------------------------- | --------------- |
| duplex síncrono (antigo)   | não chegou em 500 ms; só após a próxima escrita do cliente (749 ms) | —             | —          | sem `DisconnectComplete`; saiu só quando o cliente fechou (2,1 s) | 172 ms          |
| duplex assíncrono (em uso) | 16 ms                                                               | 28 ms         | preservada | 95 ms, código 0, sem kill                                         | 281 ms          |
| dois pipes                 | 15 ms                                                               | 13 ms         | preservada | 92 ms, código 0, sem kill                                         | 172 ms          |

No duplex síncrono, no instante do prazo, a thread `ui` estava dentro da
escrita do estado e a `worker` dentro da leitura do comando — a mesma espera
descrita no incidente abaixo. A CPU é o tempo total do processo e é dominada
pela inicialização do WinForms; não separa os transportes.

Os dois transportes corretos passam no mesmo critério (resposta em menos de
500 ms sem outra escrita, ordem preservada, parada em menos de dois segundos
sem matar o processo). Fica o **duplex assíncrono**: um handle só, uma conexão,
uma falha parcial possível e um teardown, contra dois de cada nos dois pipes. A
variante de dois pipes também não traria acesso mínimo por sentido: o cliente
`net` do Node sempre lê do pipe e fecha na hora um pipe só de entrada
(`PipeDirection.In`), então os dois handles precisariam ser `InOut` de
qualquer jeito. Dois pipes só voltam a ser considerados se o teste do
executável real falhar no duplex assíncrono no runtime suportado.

Essa separação foi exigida por uma falha real em 2026-09-18: o Electron enviou
`connect` às `00:57:57.282Z`, a sidecar criou `ConnectCommand` às
`00:57:57.3230795Z`, mas o estado só chegou ao Electron depois do timeout de
`00:58:12.285Z`, quando o cliente escreveu `disconnect`/fechou o pipe. Como a
publicação ocorria antes de `_rdp.Connect()`, aquela tentativa nunca alcançou o
controle RDP. O teste `rdp-sidecar-binary.test.js` reproduziu o atraso no
transporte síncrono sem ActiveX nem credenciais e agora exige resposta em menos
de 500 ms sem uma segunda escrita do cliente.

Autoteste local, sem destino RDP: compilar `sidecar/OpenPortalRdpSidecar.csproj`
em Debug e executar `npx vitest run
src/main/connection/__tests__/rdp-sidecar-binary.test.js --maxWorkers=1`.

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
do destino. O app pede a aprovação (`connection-request.js`/
`handleConnectionRequest`) antes de abrir a sidecar, mas, ao contrário do VNC
depois do GOALS 10, **ela não é o único portão**: a 3389 atende direto, e
quem estiver no Tailscale e tiver uma conta com acesso RDP ao destino pode
entrar com um cliente RDP comum, sem passar pela aprovação. O que protege é
a autenticação do Windows (NLA, senha da conta) e a regra de firewall que só
aceita a faixa do Tailscale. Levar o RDP pelo túnel da 18902, como o VNC,
fica para um GOALS próprio.

**Provisionamento (uma vez por máquina, feito na aba Configurações da
própria máquina de destino, não em quem conecta):**

1. _Habilitar Remote Desktop_ — liga `fDenyTSConnections=0` no registro,
   inicia o `TermService` e cria (ou atualiza) a regra própria
   `OpenPortal-RDP-Tailscale`: TCP 3389 só de `100.64.0.0/10`. As regras
   "Remote Desktop" do Windows ficam desligadas, porque valem para qualquer
   rede e têm nome traduzido ("Área de Trabalho Remota" em pt-BR). Roda em
   PowerShell elevado (`src/main/system/rdp-provisioning.js`), com prompt de
   UAC e nenhuma mudança em NLA. O `Start-Process -Verb RunAs` não devolve o
   código de saída do script, então o app só diz "habilitado" depois de ler
   de volta: RDP permitido, regra ativa, serviço rodando. O `TermService` é
   Manual, mas o Windows o inicia no boot enquanto o RDP está permitido.
2. _Criar conta dedicada_ — cria uma conta local do Windows só para o app
   usar (senha aleatória gerada uma vez, nunca a senha pessoal de quem está
   logado ali) e a coloca no grupo de Área de Trabalho Remota pelo SID
   `S-1-5-32-555`, porque o nome do grupo muda com o idioma. O app confere a
   entrada no grupo antes de dizer "Conta criada". A senha só aparece uma
   vez na tela e precisa ser copiada para o campo "Senha RDP" de quem for
   configurar esta máquina como RDP no próprio app.

Senhas nunca vão na linha de comando do PowerShell elevado, que outros
processos leem e que pode parar em logs de auditoria. Isso vale para esta
conta e para a senha que "Proteger TightVNC" gera. O Node grava a senha num
arquivo temporário no `%TEMP%` do usuário, o script elevado lê o arquivo para
`$secret` e o apaga na hora, e o Node apaga de novo no fim, caso o UAC tenha
sido recusado.

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

**Prontidão, posse e ciclo de vida:** a sidecar só abre o pipe depois de
`Shown`, da primeira volta do loop visual e da criação explícita do handle do
ActiveX. O comando recebido é enfileirado com `BeginInvoke`; `Connect()` nunca
é chamado durante a inicialização ou por um despacho síncrono que prenda o
loop de mensagens. `CommandReceived`, `ConnectInvoking` e `ConnectReturned`
confirmam separadamente que o comando chegou, que a chamada começou e que ela
retornou. `UIParentWindowHandle` aponta para o formulário da sidecar,
portanto avisos de certificado/autenticação aparecem na janela RDP em vez de
ficarem escondidos atrás do Electron.

Cada montagem de `RdpViewer` cria um
`lifecycleId` opaco e não sensível. `start`, `resize`, `visibility` e
`stop` atravessam preload/IPC com esse identificador; o processo principal
ignora qualquer comando cujo ID não seja o dono atual da sidecar. Isso é
especialmente importante no modo de desenvolvimento: o React StrictMode
executa montagem → cleanup → remontagem como prova, e um cleanup atrasado
da primeira geração não pode encerrar a segunda. Um `stop` sem ID é
reservado à ação explícita do usuário. Encerramento intencional,
supersessão e falha inesperada aparecem separadamente no trace.
A sidecar também monitora o PID do processo principal e, no modo embutido,
o HWND pai; perda do pipe, encerramento do Electron ou destruição da janela
encerra o formulário e a sessão em vez de deixar um processo órfão.

**Estados autoritativos:** abrir o pipe ou criar o processo não significa
que a sessão está utilizável. O estado visível segue esta tabela; eventos
repetidos ou pertencentes a uma geração antiga são descartados:

| Origem                                   | Estado da UI                                                | Observação                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| preflight local/TCP falhou               | `error` / `local-sidecar` ou `network`                      | não cria processo quando executável ou destino não estão prontos                                                                  |
| `ControlReady`/`EmbeddingResult`         | interno (`control-ready`)                                   | requisito obrigatório antes de aceitar `connect`                                                                                  |
| `CommandSent`                            | `connecting` (`command-written`)                            | aguarda confirmação da sidecar, não evento ActiveX                                                                                |
| `CommandReceived`                        | `connecting` (`command-received`)                           | comando está na thread UI; aguarda chamada do controle                                                                            |
| `ConnectInvoking`/`ConnectReturned`      | `connecting`                                                | mede a chamada COM; só no retorno inicia prazo do primeiro evento                                                                 |
| `OnConnecting`                           | `connecting`                                                | inicia o prazo de transporte/autenticação                                                                                         |
| `OnConnected`                            | `connecting` (`transport-connected`)                        | confirma transporte, não login concluído                                                                                          |
| aviso de autenticação/certificado        | `connecting` / `certificate-warning`                        | prazo é pausado; usuário decide na janela RDP                                                                                     |
| `OnLoginComplete`                        | `connected`                                                 | primeiro ponto considerado autenticado e utilizável                                                                               |
| `OnLogonError` -5/-4 (disputa de sessão) | `connecting` / `session-contention`                         | prazo é pausado; a pessoa responde na tela da sessão RDP                                                                          |
| `OnLogonError` 3, 0/1/2, -1/-6/-7        | `connecting` / `logon-warning`, `authentication`, `policy`  | prazo é pausado; a categoria passa para o `OnDisconnected` seguinte                                                               |
| `OnLogonError` -2 (Winlogon continua)    | interno                                                     | volta a contar o prazo de autenticação                                                                                            |
| `OnFatalError`                           | `error` / `host-control`                                    | mensagem sanitizada para o renderer                                                                                               |
| `OnDisconnected` antes/depois do login   | `error` antes, `disconnected` depois; categoria pelo código | `classifyRdpDisconnect`: `ExtendedDisconnectReason` informativo, depois `discReason`, depois a categoria do último `OnLogonError` |
| `WindowProbe`                            | só log local                                                | lista classe/título das janelas da sidecar num aviso ou num prazo                                                                 |
| pipe/processo inesperadamente encerrado  | `error` / `local-sidecar`                                   | emitido uma vez, mesmo com vários callbacks locais                                                                                |
| prazo da etapa expirou                   | `error` / `local-sidecar` ou `timeout`                      | identifica despacho, chamada COM, primeiro evento ou autenticação                                                                 |
| cleanup/supersessão/ação explícita       | nenhum erro; `disconnected` apenas para ação explícita      | não cria histórico falso do probe do StrictMode                                                                                   |

`OnLogonError` não é sempre falha. Os códigos da Microsoft para ele incluem a
disputa de sessão (-5: "outro usuário está conectado", o caso de quem entra
no PC B com a conta dedicada enquanto alguém usa o PC) e avisos do Winlogon.
Por isso nenhum código de `OnLogonError` encerra a tentativa: o fim vem sempre
no `OnDisconnected`. Os códigos do `OnDisconnected` e da
`ExtendedDisconnectReason` viram categorias com mensagem própria: senha ou
conta recusada (2055 e os `SSL_ERR_*`), rede (516, 264, 2308...), política,
certificado e sessão assumida por outra conexão (estendido 5). O estendido 7
não é usado: o controle real manda 2308 + 7 quando o outro lado só fecha o
TCP. O número fica no log local; o renderer recebe categoria e mensagem.

Os prazos são independentes: 5 s para `control-ready`, 5 s de `CommandSent`
até `CommandReceived`, 10 s da confirmação do comando até `ConnectReturned`,
15 s de `ConnectReturned` até o primeiro evento ActiveX e 45 s para
autenticação depois desse evento. Se um evento ActiveX ocorrer sincronamente
dentro de `Connect()`, ele já satisfaz o prazo e o `ConnectReturned` posterior
não arma outro timer. Avisos que exigem ação humana suspendem o prazo. Cada
prazo é cancelado ao trocar de etapa e pertence somente ao `lifecycleId` atual.

No encerramento, Node envia `disconnect` e mantém a leitura aberta; a sidecar
desconecta o controle e responde `DisconnectComplete`. Só então Node faz o
half-close do pipe. Se a confirmação não chegar, o grace period existente
fecha o canal e encerra somente o processo daquela geração. Isso impede que
um `end()` imediato descarte justamente o último diagnóstico.

O trace local registra ID, modo, PID, timestamps, evento, etapa, valor
`Connected`, HWNDs, pai real/solicitado, estilo, thread, contexto DPI, resultado
de `SetParent` e versão do controle. Senha, objeto de credencial, comando bruto
e conteúdo de diálogo nunca são registrados; o renderer recebe só categoria e
mensagem sanitizadas.

**Recuperação conservadora:**

| Situação                                                        | Resultado e limpeza                               | Repetição automática     |
| --------------------------------------------------------------- | ------------------------------------------------- | ------------------------ |
| executável ausente ou TCP inacessível                           | erro de preflight, sem sidecar                    | nenhuma                  |
| pipe/processo ou despacho perdido                               | erro local único; encerra somente a geração dona  | nenhuma                  |
| prontidão em qualquer modo                                      | erro da etapa e limpeza da sidecar                | nenhuma                  |
| primeiro evento no modo `auto-fallback`, após `ConnectReturned` | encerra embutido e abre uma janela nativa         | uma vez                  |
| primeiro evento nos outros modos                                | erro da etapa e encerramento gracioso             | nenhuma                  |
| aviso de certificado/autenticação                               | mostra a janela, pausa prazo e aguarda o usuário  | nenhuma                  |
| credencial/política rejeitada                                   | erro sanitizado e encerramento                    | nenhuma                  |
| desconexão remota ou cancelamento explícito                     | estado terminal e limpeza da sidecar              | nenhuma                  |
| StrictMode, reload ou geração substituída                       | evento antigo ignorado; só o dono atual permanece | nenhuma                  |
| duas máquinas simultâneas                                       | uma entrada, pipe e processo por `machineId`      | independente por máquina |

**Preflight e suporte:** cada tentativa escreve no painel de logs um ID de trace
abreviado, modo e etapa. O log local completo acrescenta host/porta configurados,
resultado TCP, presença da sidecar e versão do controle. Para escalar um problema,
anotar o ID, horário, modo, etapa/evento final e quantidade de processos sidecar;
não copiar `config.json`, senha, comando do pipe nem registros de segurança do
Windows. Se o modo `native-window` também falhar, conferir no destino o serviço
Remote Desktop Services, firewall/porta, NLA, formato do usuário e permissão
"Allow log on through Remote Desktop Services", e comparar com `mstsc.exe` usando
a mesma conta dedicada.

**Matriz de validação manual:** em uma máquina Windows com NLA ligado,
confirmar (1) credencial válida chegando a `OnLoginComplete`, com tela e
entrada utilizáveis; (2) credencial inválida chegando a erro de
autenticação; (3) destino silencioso chegando ao timeout; (4) desconexão
explícita sem processo órfão; e (5) remontagem StrictMode deixando uma única
sidecar dona da sessão. Depois, voltar a mesma máquina para VNC e confirmar
que o transporte original continua funcionando.

**Estado atual (2026-09-21):** prontidão explícita, transporte duplex
overlapped, fila de status fora da UI, acknowledgements de comando/chamada,
encerramento confirmado, diálogos parentados, trace redigido e os três modos
de hospedagem estão implementados. A regressão automatizada cobre o executável
real sem ActiveX (100 estados ordenados, JSON fragmentado, geração obsoleta,
peer perdido e fila saturada), posse obsoleta, perda de pipe, falha de escrita,
transição dos prazos, pausa por aviso e fallback único. Os 88 testes passam,
assim como as compilações Debug/Release e o build do renderer. A sessão RDP
real com credenciais válidas e entrada de tela ainda exige a validação manual
da matriz acima (ver GOALS.md).

**Evidência com o ActiveX real (2026-09-29, MSTSCLib 10.0.26100, PC A):** a
sidecar de verdade, conectando em alvos TCP falsos em `127.0.0.1` (sem destino
RDP nem credencial real), mostra a mesma ordem nos modos `native-window` e
`embedded` com `SetParent` entre processos (erro 0, DPI e thread iguais):

| Alvo                  | `ConnectReturned` | `OnConnecting` | Fim                                                   |
| --------------------- | ----------------- | -------------- | ----------------------------------------------------- |
| porta fechada         | +1,5 s            | +1,5 s         | `OnDisconnected` 516 em +17,5 s                       |
| aceita e fecha o TCP  | +0,7 s            | +0,75 s        | `OnDisconnected` 2308, estendido 7, em +0,78 s        |
| aceita e não responde | +0,7 s            | +0,75 s        | nada em 90 s; o prazo de 45 s de autenticação encerra |

Ou seja: com a prontidão explícita e o pipe assíncrono, o controle entrega os
eventos na hora, embutido ou não. O "`OnConnecting` e depois silêncio" que
travava a UI se reproduz com um destino que aceita o TCP e não fala RDP, e o
prazo de autenticação o limita. O teste "RDP sidecar with the real ActiveX
control" repete o segundo caso nos dois modos a cada `npm test` no Windows, e
falha se o `.exe` for mais velho que o `Program.cs`.

### Modo laboratório (GOALS 16–19)

Um professor (o **gerente**) gerencia vários PCs de laboratório a partir do próprio
OpenPortal; o aluno entra no PC com o **Remote Desktop do Windows**, usando uma conta do
Windows que o gerente cria, e não precisa do OpenPortal. O uso é estritamente sequencial
(um aluno por PC, nunca dois) e não há monitoramento de atividade. Um PC com o modo
laboratório desligado se comporta exatamente como antes.

**Dois componentes em cada PC de laboratório**

| Componente                         | Onde roda                   | O que faz                                                                                   |
| ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| App OpenPortal                     | Sessão do dono do PC        | Atende a rede (porta 18902): autoriza o gerente, mostra o diálogo de matrícula, responde ao status |
| Serviço do laboratório (GOALS 17)  | LocalSystem, sem rede       | Contas dos alunos, cota de disco, fim forçado da sessão; conversa só com o app, por um pipe local |

Os alunos são usuários comuns, em sessões RDP próprias: não alcançam o app, os arquivos
dele nem o pipe do serviço.

**Papéis e confiança**

- **Gerente** = um login Tailscale listado em `lab.managers` do PC gerenciado. **PC
  gerenciado** = um PC que aceitou pelo menos um gerente.
- A identidade do gerente vem **só** de `tailscale whois` sobre o IP real do socket
  (`socket.remoteAddress`), nunca de um nome declarado na mensagem. Sem login verificado
  (`unknown`), a resposta é `unauthorized`.
- A autorização efetiva é a lista de aprovação automática `allowedUsers` ∪ `lab.managers`
  (um gerente abre a tela do PC sem diálogo) e a lista de envio `reportTo` ∪ `lab.managers`.
- **Matrícula:** o gerente pede para gerenciar um PC (`lab-enroll`); a pessoa que está nele
  clica em **Aceitar** num diálogo no estilo de "Solicitação de conexão" que mostra o login
  verificado. Nada é matriculado remotamente sem esse clique. O dono pode sair a qualquer
  momento por **Remover gerente** no cartão "Este PC é gerenciado"; remover o último gerente
  desliga o modo laboratório do PC.
- **Bloqueio:** 5 pedidos recusados seguidos do mesmo IP bloqueiam esse IP por 5 minutos
  (`locked`), o mesmo limitador usado pela senha de acesso (`FailureLimiter`).
- O **status é consultado** pelo gerente a cada 10 s (não empurrado): a resposta do próprio PC
  é a verdade, e uma resposta que não vem também é informação ("PC sem resposta", GOALS 19).

**Protocolo (versão `labProtocol` = 1)**

Mesma porta de sinalização (18902) e mesma ideia do `connect-request`: **um objeto JSON por
conexão**, em UTF-8. O cliente abre a conexão, escreve o pedido e espera um objeto JSON de
resposta; o PC gerenciado responde e fecha (a única exceção é `lab-folder`, abaixo).

- **Limites:** pedido ≤ 4 KiB; resposta ≤ 256 KiB; textos sem caracteres de controle; campos
  desconhecidos são ignorados. Pedido maior que o limite, JSON inválido, campo ausente ou de
  tipo errado: `bad-request`.
- **Pedido:** `{ "type": "lab-…", "labProtocol": 1, …campos }`. `labProtocol` é obrigatório.
- **Resposta de sucesso:** `{ "type": "lab-response", "request": "<tipo do pedido>", "ok": true,
"labProtocol": 1, …campos }`.
- **Resposta de erro:** `{ "type": "lab-response", "request": "<tipo>", "ok": false, "error":
"<código>", "message": "<texto em português, opcional>", "labProtocol": 1 }`.
- **Códigos de erro:** `unauthorized` (não é gerente, ou identidade desconhecida), `locked`
  (IP bloqueado), `busy` (outro diálogo de matrícula aberto, ou PC com aluno ativo),
  `bad-request`, `unsupported` (tipo desconhecido, `labProtocol` maior que o do PC, ou
  mensagem de um GOALS ainda não implementado — a resposta traz o `labProtocol` do PC para o
  gerente marcar "Incompatível"), `internal` (falha inesperada no PC; nunca carrega detalhes).
- **Autorização:** toda mensagem `lab-*` exige que o remetente seja gerente, **exceto**
  `lab-enroll`. Não há senha nem segredo em nenhuma resposta, salvo a senha do aluno em
  `lab-reserve`, entregue uma única vez.

**Mensagens**

| Tipo (GOALS)                  | Pedido (além de `type`, `labProtocol`)                                  | Resposta de sucesso (além do envelope)                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lab-enroll` (16)             | —                                                                       | `accepted: true, hostId, hostName, appVersion` — ou `accepted: false, reason: "rejected" ou "timeout"` |
| `lab-status` (16)             | —                                                                       | `hostId, hostName, appVersion, managed, service, state, student?, studentCount, disk?`                  |
| `lab-students` (18)           | —                                                                       | `students: [{label, account, quotaGb, usedGb, lastSessionAt?, state}], capacity`                        |
| `lab-student-add` (18)        | `label` (1–40 caracteres), `quotaGb` (1–2000)                           | `student`                                                                                               |
| `lab-student-quota` (18)      | `account`, `quotaGb` (1–2000)                                           | `student`                                                                                               |
| `lab-student-delete` (18)     | `account`                                                               | — (recusado com `busy` se o aluno está ativo)                                                           |
| `lab-reserve` (18)            | `account`, `startWithinMs` (60 s a 24 h), `sessionMs` (5 min a 12 h)    | `reservationId, account, userName, password, startBy, endsAt` (única resposta com senha)                |
| `lab-extend` (18)             | `reservationId`, `addMs` (1 min a 12 h)                                 | `endsAt`                                                                                                |
| `lab-end` (18)                | `reservationId`, `reason`: `manager-ended` ou `manager-handover`        | `ended: true`                                                                                           |
| `lab-folder` (18)             | `account`                                                               | `tunnel: true`; depois da resposta o socket vira uma sessão de arquivos **somente leitura** na pasta do aluno |
| `lab-events` (19)             | `sinceSeq` (inteiro ≥ 0), `limit` (1–500)                               | `events: [...], lastSeq, firstSeq`                                                                      |

`lab-enroll` aceito é **idempotente**: um login que já é gerente recebe `accepted: true` sem
novo diálogo. O diálogo fecha sozinho depois de 60 s (`reason: "timeout"`) ou quando quem
pediu desiste. Só um diálogo de matrícula fica aberto por vez (os outros recebem `busy`), e
cada recusa conta para o bloqueio do IP.

**Campos de `lab-status`**

- `hostId` (UUID criado uma vez neste PC), `hostName`, `appVersion`, `managed` (verdadeiro se
  há ao menos um gerente).
- `service: { installed, running }` — até o GOALS 17 o serviço não está instalado.
- `state`: `free` | `reserved` | `in-use`; até o GOALS 18 é sempre `free`.
- `student?: { label, since, endsAt }` — presente com `state` ≠ `free`; só rótulo e horários.
- `studentCount`; `disk?: { totalGb, freeGb }` — preenchido a partir do GOALS 17.
- O status é montado por uma lista de campos permitidos: nenhuma senha, token ou segredo
  consegue entrar nele, mesmo que a camada de baixo devolva mais.

**`lab-folder`** é a única mensagem que mantém o socket aberto: depois do `tunnel: true`
ele vira o mesmo transporte multiplexado da sessão de arquivos (`FileAgentSession`), com
raiz na pasta de perfil do aluno e **sem** operações que alteram (enviar, apagar, renomear,
criar pasta). Não abre diálogo: o gerente já está autorizado.

**Eventos (GOALS 19)** têm o formato `{ v: 2, hostId, hostName, seq, at, type, student?:
{label, account}, reservationId?, sourceIp?, endReason?, detail? }`, com os tipos
`student-added`, `student-deleted`, `quota-changed`, `reservation-start`, `reservation-end`,
`session-logon`, `session-logoff`, `manager-enrolled`, `manager-removed`, `host-lost` e
`host-back`, e os motivos de fim `student-left`, `manager-ended`, `manager-handover`,
`deadline`, `unused-expired` e `service-restart`. Os eventos do GOALS 4 (sem `v`) continuam
aceitos e mostrados.

**Configuração deste PC (`config.json`)**

| Chave                   | Quem altera                                              | Para quê                                                  |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `hostId`                | Só o main, uma vez; o renderer não consegue alterar      | Identidade estável do PC                                  |
| `lab.managers`          | Só a matrícula aceita e "Remover gerente" (locais)       | Logins que gerenciam este PC                              |
| `lab.managed`           | Só o main (derivado de `lab.managers`)                   | Este PC é gerenciado                                      |
| `lab.mode`              | O renderer (Configurações → "Modo laboratório")          | Mostra a tela "Laboratório" neste PC (lado do gerente)    |
| `lab.roster`            | Só o main (matrícula e "Remover" da tela)                | Lista de PCs que este app gerencia (até 50)               |

**Como os alunos chegam aos PCs (decisão G16-D1, 2026-09-30)**

Os alunos usam só o Remote Desktop do Windows, então o que importa é um caminho de rede até
a porta 3389; o canal dos gerentes (porta 18902) continua pelo Tailscale em todos os casos.

- **Alunos em casa — opção B (gratuita):** compartilhar cada PC de laboratório com a conta
  Tailscale do aluno ("node sharing"). Cada aluno usa a própria conta gratuita e o
  compartilhamento não aumenta o número de usuários da tailnet do professor (o plano gratuito
  tem 6). O professor gera um link de convite reutilizável por PC no painel do Tailscale
  (até 1.000 usos; expira em 30 dias se não for usado). O dispositivo compartilhado fica em
  quarentena (responde, mas não inicia conexões). A regra de firewall `OpenPortal-RDP-Tailscale`
  já aceita todo o `100.64.0.0/10`, o que cobre as tailnets dos alunos. Antes de depender
  disso, confirmar com um aluno real: o uso do link, o RDP pelo compartilhamento e o que
  `tailscale whois` devolve para um aluno convidado.
- **Alunos na sala — opção E:** os alunos estão na mesma rede dos PCs; a regra de firewall da
  3389 é ampliada da faixa Tailscale para a sub-rede local. O RDP é criptografado por si, mas a
  rede da escola passa a alcançar a porta: só a conta de aluno habilitada (uma por vez, com
  senha aleatória que expira) a protege. Os PCs precisam de IP fixo (reserva no DHCP) e vale
  conferir, a partir do aparelho do aluno, que a rede deixa a porta passar
  (`Test-NetConnection <ip> -Port 3389`; isolamento de clientes no Wi-Fi e VLANs podem
  bloquear).
- Saída se os termos do Tailscale mudarem: NetBird Community (gratuito, sem limite de
  usuários e dispositivos, mas exige um servidor próprio).

**Como um PC de laboratório volta depois de reiniciar (decisão G16-D2, 2026-09-30)**

O app precisa estar rodando na sessão do dono para gerenciar o PC, e depois de reiniciar
ninguém está logado. Decisão: uma **conta comum dedicada** (por exemplo `openportal-host`,
sem direitos de administrador e sem acesso de aluno) com **login automático** configurado
por quem administra o PC (ferramenta Autologon da Sysinternals ou `netplwiz`; isso guarda a
senha dessa conta no PC, por escolha de quem administra) e a opção **Iniciar com o Windows**
ligada nas Configurações do app. Quando um aluno entra por RDP, a sessão do dono é só
**desconectada**, não encerrada: o app continua rodando e escutando a 18902 (observado no
G17-V1). O app só oferece "Iniciar com o Windows" depois que o modo laboratório está ligado e
a opção vem desligada por padrão.

**Canais internos (renderer ↔ main)**

`lab:roster`, `lab:add`, `lab:remove`, `lab:status` (assinatura de eventos), `lab:open`
(GOALS 16 I8); `lab:managers` e `lab:removeManager` (cartão "Este PC é gerenciado");
`lab:getStartWithWindows` e `lab:setStartWithWindows` ("Iniciar com o Windows"). Dois
canais só empurram dados do main para a tela: `lab:status` (a lista de PCs, quando algo que
ela mostra muda) e `lab:hostChanged` (os gerentes deste PC ou o modo mudaram). Cada
handler valida a entrada; nenhum devolve segredo ao renderer. `lab:open` devolve só o
necessário para pedir acesso pelo fluxo normal (nome, IP e porta) e recusa PC em uso,
Offline, Incompatível ou Sem acesso.

**Fora do escopo:** monitoramento de apps e downloads; bloqueio de área de transferência ou
de unidades no RDP; alunos trocando de PC; armazenamento central de arquivos; fila de
espera; mais de um aluno ativo por PC; discos virtuais; domínio Windows; PCs com Windows
Home (não hospedam RDP).

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
