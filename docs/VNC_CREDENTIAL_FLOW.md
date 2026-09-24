# Fluxo VNC: acesso, senha e falhas

## Limites entre as etapas

1. **PC A solicita acesso:** o Dashboard recebe somente o IPv4 Tailscale do PC B. A conexão VNC usa a porta `5900` automaticamente e cria uma sessão temporária; ela não altera um PC salvo nem contém credencial.
2. **PC B aprova ou recusa:** `App.jsx` envia o pedido de aprovação pela porta de sinalização `18902`. Recusa e indisponibilidade terminam a solicitação antes de abrir o visualizador VNC.
3. **A sessão VNC abre:** depois da aprovação, o proxy local encaminha a sessão para a porta VNC configurada do PC B. A abertura não inclui senha.
4. **O servidor decide se exige senha:** somente o evento `credentialsrequired` do noVNC pede uma credencial. PC B sem senha não mostra diálogo; PC B com senha mostra um único diálogo ligado à sessão ativa.

## Credencial e armazenamento

- A senha do TightVNC é configurada no PC B; o aplicativo não a configura remotamente.
- A senha informada para uma conexão direta fica somente na memória da tentativa atual.
- Um PC salvo pode guardar uma senha local opcional, mediante escolha explícita. O processo principal a cifra com `safeStorage` e o renderer recebe apenas `hasVncPassword`.
- A senha nunca entra em URL, pedido de aprovação, histórico de atividade, telemetria ou log.

## Contrato da sessão

Cada iframe noVNC recebe um identificador de tentativa não secreto. O iframe aceita `vnc-credentials`, cancelamento ou desconexão somente da janela pai e somente quando o identificador confere. Mensagens atrasadas ou de outra janela são ignoradas.

O fluxo legado que transportava `machine.password` pela URL e usava `wasRejected` foi removido. Agora, recusa de acesso, solicitação de credencial, senha inválida e perda de transporte possuem estados próprios. Somente `connection-lost` pode receber reconexão automática limitada; senha inválida, cancelamento e recusa nunca entram nesse ciclo.
