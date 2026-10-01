# Bateria de testes com dois PCs

Roteiro dos testes que só uma pessoa com os dois PCs consegue fazer. Cada bloco
diz o que fazer, o que deve acontecer e qual item do `GOALS.md` ele fecha. Os
blocos estão na ordem que evita retrabalho: o que prepara o PC B vem primeiro.

- **PC A** (cliente): `skytre`, Tailscale `100.66.218.65`
- **PC B** (destino): `DESKTOP-O18JVRU`, Tailscale `100.81.199.56`
- Os dois PCs rodando o mesmo commit do branch em teste, com o app aberto.

Depois de cada bloco, avise quem estiver acompanhando: ele confere nos logs dos
dois apps (`%APPDATA%\openportal-remote\logs\`) se cada caso passou pelo
caminho certo. Nenhum log guarda senha.

## 0. Antes de começar

- **Desligue a suspensão e a hibernação nos dois PCs** durante a bateria
  (Configurações → Sistema → Energia). Um PC suspenso some da rede e o app
  cai: o PC B hibernou sozinho em 2026-09-24 e o app só voltou depois de ser
  aberto de novo.
- Abra o app pelo `ABRIR_APP.bat` da pasta que está no commit em teste. Ele
  fecha cópias antigas antes de abrir. Depois de atualizar o código, abra de novo.
  No PC A, é o da pasta
  `D:\ProjetosPessoais\TunelSSH\.claude\worktrees\vnc-access-flow-testing-c6ec16`: a pasta
  principal `D:\ProjetosPessoais\TunelSSH` está no `master`, sem as correções. Se o
  `sidecar/Program.cs` mudou desde a última compilação, recompile a sidecar Debug
  antes (o teste "RDP sidecar binary freshness" avisa).
- **Minimize a janela do OpenPortal, não feche.** Fechar encerra o app, e o PC
  some para quem tenta conectar. Se o app sair sozinho, o log diz se foi a
  janela sendo fechada, o Windows encerrando a sessão, uma queda da tela ou um
  evento de energia.

## 1. Preparar o RDP no PC B (GOALS 12, G12-T2; GOALS 2)

No PC B, em **Configurações → Hospedagem RDP nesta máquina**:

1. **Habilitar** → aprove o UAC → deve aparecer "Remote Desktop habilitado e
   confirmado". O app só diz isso depois de conferir que o RDP está permitido,
   que a regra `OpenPortal-RDP-Tailscale` existe e que o serviço de RDP está rodando.
2. **Criar conta dedicada**: deixe `openportal-rdp`, clique em **Gerar senha**,
   **copie a senha** (aparece uma vez só; guarde num gerenciador de senhas) e
   clique em **Criar conta** → UAC → "Conta criada". Se der erro, a mensagem diz
   que a conta não apareceu no grupo de Área de Trabalho Remota.

Esperado: a porta 3389 do PC B só aceita PCs do Tailscale. As regras "Área de
Trabalho Remota" do próprio Windows continuam desligadas, e não sobra nenhuma
pasta `openportal-*` em `%TEMP%`.

## 2. "Proteger TightVNC" com a senha fora da linha de comando (G12-T2)

Num dos PCs, clique em **Proteger TightVNC** no cartão "Este PC" e aprove o UAC.

Esperado: "TightVNC protegido…" continua aparecendo, e uma conexão VNC vinda do
outro PC continua entrando pelo túnel.

## 3. RDP de A para B (G7-T5, G5-R2, G5-T4, G6-T3)

**Atenção:** o RDP abre uma sessão separada com a conta `openportal-rdp`. Como o
Windows Pro só permite uma sessão ativa, quem estiver usando o PC B vai para a
tela de bloqueio; é só entrar de novo depois. Se houver alguém logado no PC B,
a própria sessão RDP pergunta se é para entrar mesmo assim: o app mostra
"Outra pessoa está usando o PC de destino..." no log, espera a resposta sem
dar tempo esgotado e não registra erro no histórico.

No PC A, em Configurações, crie a máquina do PC B com Host `100.81.199.56`,
Transporte **RDP (nativo)**, Usuário `openportal-rdp`, a senha copiada no bloco 1
e porta 3389. Em cada caso, conecte e clique em **Aceitar** no PC B.

| #    | Como                                                       | Esperado                                                                                      |
| ---- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 3.1  | Exibição **Janela compatível**                             | Janela separada com a área de trabalho, mouse e teclado funcionando. Desconectar fecha tudo.  |
| 3.2  | Exibição **Dentro do app**                                 | A sessão aparece dentro da janela do OpenPortal. Mouse e teclado funcionam.                   |
| 3.3  | Exibição **App + fallback automático**                     | Igual a 3.2. Se o modo embutido falhar, abre **uma** janela compatível.                       |
| 3.4  | Senha RDP errada                                           | "O PC de destino recusou a conta RDP..." no log e na notificação, sem ficar tentando de novo. |
| 3.5  | Porta RDP 3390 (destino que não responde)                  | Erro de rede antes de abrir o componente RDP. Depois volte para 3389.                         |
| 3.6  | Clicar em Desconectar enquanto aparece "Conectando"        | Para na hora, sem erro falso e sem janela sobrando.                                           |
| 3.7  | Ctrl+R na janela do app durante a conexão                  | Nenhuma janela RDP "órfã" fica aberta.                                                        |
| 3.8  | Aviso de certificado na primeira conexão, se aparecer      | A conexão espera você decidir e não dá tempo esgotado enquanto o aviso está aberto.           |
| 3.9  | Trocar a máquina de volta para **VNC** e conectar          | O VNC funciona normalmente.                                                                   |
| 3.10 | (Opcional) Escala da tela do PC A em 125% ou 150%          | A sessão embutida ocupa a área certa.                                                         |
| 3.11 | Com a sessão RDP aberta, alguém entra no PC B pelo teclado | A sessão cai com "...outra conexão assumiu o PC de destino...", sem janela RDP sobrando.      |

## 4. VNC: servidor sem senha e troca de senha salva (G8-R1, G8-F2, G8-T5)

1. **Servidor sem senha:** no PC B, abra a configuração do serviço TightVNC e
   desmarque a exigência de senha ("Require VNC authentication"). A 5900 continua
   aceitando só conexões locais, então só entra quem for aprovado. No PC A,
   conecte no PC B (IP + senha de acesso, ou Aceitar).
   Esperado: a tela abre **sem** pedir senha do VNC.
   Depois clique em **Proteger TightVNC** no PC B, que volta a exigir senha.
2. **Troca de senha salva:** no PC A, numa máquina VNC salva, digite uma senha
   nova em "Senha VNC salva" e clique em **Salvar configuração**.
   Esperado: o campo volta vazio, com o aviso "Senha salva; digite uma nova para
   substituir", e nunca mostra a senha antiga. Depois clique em **Remover senha
   salva** e salve: o aviso some.

## 5. Duas sessões ao mesmo tempo (GOALS 1)

No PC A, conecte no PC B e, sem desconectar, conecte também em outra máquina: um
terceiro PC, se houver, ou o próprio PC A (`100.66.218.65`, aprovando no próprio A).

Esperado: as duas sessões funcionam, trocar entre elas não reconecta nenhuma, e
desconectar uma não derruba a outra.

## 6. Painel de atividade (GOALS 4)

1. No PC B, em **Configurações → Reportar atividade para**, adicione o login
   Tailscale do PC A (o e-mail com que você entrou no Tailscale).
2. No PC A, conecte no PC B, envie um arquivo pela aba **Arquivos** e desconecte.

Esperado: a aba **Atividade** do PC A mostra a sessão com quem conectou, a
duração e 1 arquivo. O Telegram é opcional e precisa do token de um bot seu.

## 7. Laboratório (GOALS 16, G16-T2)

Aqui o PC A faz o papel do professor (gerente) e o PC B o de um PC de laboratório. Os
dois no Tailscale, cada um com o app aberto. Os blocos de GOALS 17 a 19 (contas de
aluno, cota, reservas, registro de acessos) entram neste mesmo bloco quando forem feitos.

1. No PC A, em **Configurações → Modo laboratório**, clique em **Desligado** para ligar.
   A barra lateral ganha o item **Laboratório**.
2. No PC A, abra **Laboratório**, digite o IP Tailscale do PC B e clique em **Adicionar PC**.
   No PC B abre a janela **Gerenciar este PC** com o login Tailscale do PC A (o botão
   padrão é **Rejeitar**): clique em **Aceitar**.
   Esperado: o PC A lista o PC B como **Livre** em até 10 s; a tela inicial do PC B
   mostra o cartão **Este PC é gerenciado** com o login do PC A.
3. No PC A, clique em **Abrir tela** no PC B.
   Esperado: a sessão abre **sem** janela de aprovação no PC B.
4. Feche o app no PC B (Sair, confirmando).
   Esperado: em até 30 s o PC A mostra o PC B como **Offline** e o botão **Abrir tela**
   fica desligado. Abra o app no PC B de novo: volta a **Livre**.
5. No PC B, no cartão **Este PC é gerenciado**, clique em **Remover gerente** e confirme.
   Esperado: o cartão some; na consulta seguinte o PC A mostra o PC B como **Sem acesso**.
6. Repita o passo 2 e confirme que o PC B pede o clique de novo (a matrícula não fica
   guardada depois de removida).
7. Reinício: no PC B instale o app, ligue **Iniciar com o Windows** (aparece com o modo
   laboratório ligado ou o PC gerenciado) e deixe a conta dedicada com login automático
   (decisão G16-D2). Reinicie o PC B.
   Esperado: sem ninguém mexer, o PC B volta e o PC A o mostra como **Livre**.

### Serviço do laboratório e contas de aluno (GOALS 17, G17-T2)

Antes de começar, no PC B: o app instalado ou aberto pelo `ABRIR_APP.bat` da pasta do branch, e o
`lab-service/bin/Release/OpenPortalLabService.exe` compilado (`MSBuild lab-service/OpenPortalLabService.csproj
-p:Configuration=Release`). Os comandos `node scripts/lab-pipe.js ...` rodam no PC B, na conta que roda o
OpenPortal, dentro da pasta do projeto. Use cota de 1 GB para o teste ser rápido.

8. No PC B, em **Configurações → Modo laboratório → Alunos neste PC**, clique em **Habilitar neste PC** e
   aprove o pedido do Windows (UAC). Marque "Os alunos estão na mesma rede" só se for o caso.
   Esperado: o estado muda para **Funcionando · 0 alunos**; `sc query OpenPortalLab` mostra RUNNING; o PC A
   continua vendo o PC B como Livre.
9. `node scripts/lab-pipe.js student-create '{"label":"Ana","quotaGb":1}'` e o mesmo para `João`.
   Esperado: as contas `ana` e `joao` existem, **desativadas** (`net user ana`), e as pastas `C:\Users\ana` e
   `C:\Users\joao` já existem. `node scripts/lab-pipe.js disk-info` mostra a recomendação de quantos alunos cabem.
10. `node scripts/lab-pipe.js reserve '{"account":"ana","startWithinMs":600000,"sessionMs":3600000}'`: anote
    `userName` e `password`. No PC A, `mstsc /v:<IP do PC B>` e entre com esse usuário e senha.
    Esperado: a sessão abre; `node scripts/lab-pipe.js status` no PC B mostra o PC **em uso** pela Ana.
11. Na sessão da Ana: copie para Documentos um arquivo maior que 1 GB (ou baixe um) e deixe um arquivo em
    `C:\Users\Public`. Tente abrir `C:\Users\joao`.
    Esperado: o Windows recusa a gravação acima do limite; `C:\Users\joao` dá acesso negado.
12. Com a Ana ativa, rode `reserve` para o João.
    Esperado: erro `busy`, dizendo que a Ana está com o PC e até quando; a conta `joao` continua desativada.
13. Na conta do dono do app no PC B (outra sessão do Windows, ou depois de a Ana sair), abra `C:\Users\ana`.
    Esperado: lê os arquivos (a leitura do dono é do serviço), mas não consegue gravar.
14. **Prazo:** encerre a sessão da Ana (`end` com `manager-ended`) e reserve de novo com
    `"startWithinMs":600000,"sessionMs":360000` (6 minutos). Entre pelo PC A.
    Esperado: cerca de 1 minuto depois da entrada aparece o aviso "termina em 1 minuto(s)"; no fim a sessão é
    **encerrada** (não apenas desconectada); entrar de novo mostra o erro genérico de autenticação; o arquivo
    que ela deixou em `C:\Users\Public` sumiu.
15. **Troca de aluno:** reserve para a Ana, entre, e depois `end` com `manager-handover` e `reserve` para o João.
    Esperado: a Ana recebe o aviso e é desconectada; o João recebe uma senha nova; a senha da Ana não entra
    mais; a Ana não lê a pasta do João e o João não lê a da Ana.
16. **Reinício no meio:** reserve (60 min), entre, e reinicie o PC B.
    Esperado: depois que o PC B volta, o serviço está rodando, a reserva continua (`status`) e o aluno consegue
    entrar de novo com a mesma senha até o prazo; no prazo o serviço encerra e desativa a conta.
17. **Pipe fechado a outras contas:** numa conta comum diferente da do app, rode `node scripts/lab-pipe.js status`.
    Esperado: erro `unauthorized`.
18. `node scripts/lab-pipe.js student-delete '{"account":"joao"}'` e, depois, **Desabilitar** nas Configurações
    (primeiro com uma reserva ativa, depois sem). Esperado: a conta, a pasta e a entrada de cota do `joao`
    somem; desabilitar é recusado com reserva ativa; sem reserva o UAC abre, o serviço é removido e as contas
    que restaram ficam desativadas, com os dados.

Anote o que a cota e o `student-delete` fizeram de verdade (o Windows não tem um comando para apagar a entrada
de cota de um usuário), e o conteúdo de `C:\ProgramData\OpenPortal\lab\service.log` se algo falhar.

Fecha: G16-T2, G16-I9 e G16-I11 (passos 1 a 7) e G17-T2 (passos 8 a 18); o passo 8, com a opção de rede escolhida, fecha também o G16-D1.

## Fora desta bateria

- **GOALS 3** precisa de três logins Tailscale diferentes e dois PCs.
- **GOALS 6, R1 a R4 e C1 a C4:** só entram se algum caso do bloco 3 falhar. Aí
  a causa é investigada com os traces gerados no próprio teste.
