# Configurar alertas do Telegram (opcional)

Alerta extra, por push, quando uma sessão termina numa máquina configurada
para reportar atividade (ver "Painel de Atividade" em
`docs/ARQUITETURA_CONEXAO.md`). Desligado por padrão — o painel in-app já
funciona sem isso.

## 1. Criar o bot

1. No Telegram, procure **@BotFather** e inicie uma conversa.
2. Envie `/newbot`, escolha um nome e um username (precisa terminar em `bot`).
3. O BotFather devolve um **token** (ex.: `123456:ABC-DEF...`) — guarde-o.

## 2. Descobrir o chat id de destino

1. Envie qualquer mensagem para o bot recém-criado (ou adicione-o a um grupo).
2. Abra `https://api.telegram.org/bot<SEU_TOKEN>/getUpdates` no navegador.
3. Procure `"chat":{"id": ...}` na resposta — esse número é o **chat id**.

## 3. Instalar a dependência

```bash
npm install telegraf
```

Sem esse passo, o app inteiro continua funcionando normalmente (painel
in-app, push entre máquinas) — só o envio real ao Telegram falha e fica
registrado no log, sem afetar mais nada.

## 4. Habilitar no app

Em **Configurações**, na seção "Alertas do Telegram (opcional)":

1. Ative o alerta.
2. Cole o token e o chat id.
3. Clique em "Salvar Telegram".

A partir daí, toda sessão desta máquina que já está na lista "Reportar
atividade para" também envia um resumo por Telegram. Falha de envio (token
errado, rede fora, dependência não instalada) só fica registrada no log —
nunca afeta a sessão remota em si nem o painel in-app, que continuam
funcionando normalmente.
