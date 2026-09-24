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
tela de bloqueio; é só entrar de novo depois.

No PC A, em Configurações, crie a máquina do PC B com Host `100.81.199.56`,
Transporte **RDP (nativo)**, Usuário `openportal-rdp`, a senha copiada no bloco 1
e porta 3389. Em cada caso, conecte e clique em **Aceitar** no PC B.

| # | Como | Esperado |
|---|---|---|
| 3.1 | Exibição **Janela compatível** | Janela separada com a área de trabalho, mouse e teclado funcionando. Desconectar fecha tudo. |
| 3.2 | Exibição **Dentro do app** | A sessão aparece dentro da janela do OpenPortal. Mouse e teclado funcionam. |
| 3.3 | Exibição **App + fallback automático** | Igual a 3.2. Se o modo embutido falhar, abre **uma** janela compatível. |
| 3.4 | Senha RDP errada | Erro de autenticação claro, sem ficar tentando de novo. |
| 3.5 | Porta RDP 3390 (destino que não responde) | Erro de rede antes de abrir o componente RDP. Depois volte para 3389. |
| 3.6 | Clicar em Desconectar enquanto aparece "Conectando" | Para na hora, sem erro falso e sem janela sobrando. |
| 3.7 | Ctrl+R na janela do app durante a conexão | Nenhuma janela RDP "órfã" fica aberta. |
| 3.8 | Aviso de certificado na primeira conexão, se aparecer | A conexão espera você decidir e não dá tempo esgotado enquanto o aviso está aberto. |
| 3.9 | Trocar a máquina de volta para **VNC** e conectar | O VNC funciona normalmente. |
| 3.10 | (Opcional) Escala da tela do PC A em 125% ou 150% | A sessão embutida ocupa a área certa. |

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

## Fora desta bateria

- **GOALS 3** precisa de três logins Tailscale diferentes e dois PCs.
- **GOALS 6, R1 a R4 e C1 a C4:** só entram se algum caso do bloco 3 falhar. Aí
  a causa é investigada com os traces gerados no próprio teste.
