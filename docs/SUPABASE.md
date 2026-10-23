# Contas com Supabase (GOALS 20 e 21)

O OpenPortal tem uma tela de **Entrar** e **Criar conta** que separa **aluno** e **professor**, e uma
tela **Meu acesso** em que o aluno recebe o PC do laboratório que o professor liberou. As contas ficam
no [Supabase](https://supabase.com) (plano gratuito). Este guia é o passo a passo para ligar isso num
projeto novo. A arquitetura e a confiança estão em `docs/ARQUITETURA_CONEXAO.md` ("Contas" e "Meu
acesso"); o roteiro de teste está no bloco 8 de `docs/BATERIA_DE_TESTES.md`.

**Sem este passo nada quebra.** Um build sem `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` abre sem
login, exatamente como antes das contas; em Configurações o cartão **Conta** diz "Contas indisponíveis
nesta versão do aplicativo".

## O que o papel decide (e o que não decide)

- **Aluno** vê a tela inicial deste PC, **Meu acesso** e Configurações.
- **Professor** vê tudo o que o app já tinha (conectar a PCs, Arquivos, Atividade, Laboratório) e a tela
  **Aprovações**.
- Quem se cadastra como professor fica **pendente** (usa o app como aluno) até outro professor aprovar.
  O primeiro professor é promovido por você, no painel do Supabase (passo 4).
- O papel **não** é a fronteira do laboratório: quem manda nos PCs continua sendo o login do Tailscale e
  a lista de gerentes de cada PC (GOALS 16). O papel escolhe as telas e, por regras do banco (RLS),
  o que cada conta lê e escreve no Supabase.
- Hospedar este PC (portas, aprovações, serviço do laboratório) **nunca** depende de alguém ter entrado.
  Um PC de laboratório que liga sozinho continua funcionando sem ninguém na tela de entrada.

## 1. Criar o projeto (G20-P1)

1. Em supabase.com crie uma conta e um **projeto gratuito**; região **South America (São Paulo)**.
   Confira os limites em supabase.com/pricing: o plano gratuito pausa o projeto depois de uma semana sem
   uso (o passo 6 evita isso), e tem 500 MB de banco e 50.000 usuários ativos por mês.
2. No painel, **Project Settings → API**: copie a **Project URL** (`https://<projeto>.supabase.co`) e a
   chave **publishable** (`sb_publishable_...`).
3. Na raiz do repositório crie o arquivo `.env` (ele já é ignorado pelo git) com:

   ```
   SUPABASE_URL=https://<projeto>.supabase.co
   SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```

4. No GitHub, **Settings → Secrets and variables → Actions → New repository secret**: crie
   `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` com os mesmos valores.

> **A chave publishable é pública por desenho**: ela vai dentro do instalador e a segurança está nas
> regras do banco. A chave **secret** (`sb_secret_...`) ou `service_role` **nunca** entra no app. O
> build falha de propósito se alguém colocar uma delas em `SUPABASE_PUBLISHABLE_KEY`.

## 2. E-mail pelo Brevo (G20-P2)

O e-mail padrão do Supabase só entrega para os membros da sua organização (cerca de 2 por hora, sem
garantia), então ninguém mais receberia o código. Use o SMTP gratuito do [Brevo](https://www.brevo.com)
(300 e-mails por dia):

1. Crie a conta no Brevo e **verifique um remetente** (um e-mail seu). Em **SMTP & API → SMTP**
   crie uma **chave SMTP** e anote o login SMTP.
2. No Supabase, **Authentication → Emails → SMTP Settings** ("Enable custom SMTP"):
   host `smtp-relay.brevo.com`, porta `587`, usuário = o login SMTP do Brevo, senha = a chave SMTP,
   e-mail do remetente = o verificado no Brevo, nome do remetente `OpenPortal`.
3. Ainda em **Authentication**:
   - **Sign In / Providers → Email**: **Confirm email** ligado; tamanho do código (**Email OTP
     length**) **6**; validade (**Email OTP expiration**) **600** segundos; senha mínima **8** com
     letras e números.
   - **Rate Limits**: e-mails por hora em **60** (o suficiente para uma turma se cadastrando junta).
   - **Email Templates**: em **Confirm signup** e **Reset password** cole o HTML de
     `supabase/templates/confirmation.html` e `supabase/templates/recovery.html` e use os assuntos
     "Seu código do OpenPortal" e "Código para criar uma nova senha no OpenPortal". Os modelos mostram
     `{{ .Token }}` (o código); o app não usa links.
4. **Teste:** cadastre um e-mail do Gmail e um do Outlook. O código deve chegar na **caixa de entrada**
   (não no spam) em até 1 minuto. Se cair no spam, o plano B é um remetente num domínio seu, autenticado
   no Brevo (SPF e DKIM).

## 3. Arquivos do Supabase no repositório (G20-P3)

`supabase/config.toml` (espelha as opções acima para a pilha local), `supabase/migrations/` (o banco) e
`supabase/templates/` (os e-mails). A CLI roda sob demanda, sem ser dependência do projeto (o pacote
baixa um binário a cada `npm ci`, e o CI não precisa dele):

```bash
npx supabase --version
```

## 4. Aplicar o banco e promover o primeiro professor (G20-S3)

```bash
npx supabase login
npx supabase link --project-ref <projeto>
npx supabase db push
```

`<projeto>` é a primeira parte da URL (`https://<projeto>.supabase.co`). O `db push` aplica, em ordem:
as contas, o `ping` do passo 6, os acessos do GOALS 21 e o agendamento da limpeza com `pg_cron`. Se a
última recusar `create extension pg_cron`, ligue **pg_cron** em **Database → Extensions** e rode o
`db push` de novo.

Depois, **crie a sua própria conta** pelo app (como aluno) e, no **SQL Editor** do painel, promova-a:

```sql
update public.profiles
   set role = 'professor', teacher_requested_at = null
 where email = 'seu-email@exemplo.com';
```

Em **Advisors → Security Advisor** não deve haver aviso de RLS ou de exposição em `public`.

> **Mudança da Data API do Supabase:** tabelas novas em `public` só aparecem na API com `grant`
> explícito (projetos novos desde 30/05/2026, existentes desde 30/10/2026). Todas as migrations deste
> repositório já escrevem os grants e ligam a RLS.

## 5. Como o endereço entra no app

- **Instalador / build:** `npm run build` roda `scripts/write-auth-config.js`, que lê `SUPABASE_URL` e
  `SUPABASE_PUBLISHABLE_KEY` do ambiente (ou do `.env`) e escreve `src/main/auth/auth-config.json`
  (ignorado pelo git). O nightly do GitHub usa os secrets do passo 1. Sem as duas variáveis o arquivo
  não é criado e o build sai sem contas.
- **Desenvolvimento:** `npm run dev` lê as mesmas variáveis do ambiente ou do `.env`.
- O app instalado só fala com o projeto com que foi gerado: variáveis de ambiente do usuário não valem.

## 6. Manter o projeto acordado (G20-K1)

O plano gratuito pausa o projeto depois de uma semana sem uso. O workflow
`.github/workflows/supabase-keepalive.yml` chama `public.ping()` às segundas e quintas (e quando você
mandar rodar, em **Actions → Supabase keep-alive → Run workflow**). Se ele falhar, o GitHub avisa por
e-mail.

**Se o projeto pausar mesmo assim:** abra o painel do Supabase, **Restore project**, espere alguns
minutos. Enquanto isso o app abre com o último perfil salvo neste PC (por até 7 dias) e mostra "Sem
conexão com o servidor de contas".

## 7. Testes

As regras do banco (quem lê e escreve o quê) são provadas dentro do `npm test`, contra um Postgres de
verdade em memória (PGlite) com as migrations aplicadas: `supabase/tests/accounts.test.js` e
`supabase/tests/handovers.test.js`. Não precisam de Docker nem de rede. O app com o `@supabase/supabase-js`
real é testado contra um servidor local em `src/main/auth/__tests__/real-client.test.js`.

O que nenhum teste automático cobre é o projeto Supabase de verdade e o e-mail: é o roteiro manual
(bloco 8 de `docs/BATERIA_DE_TESTES.md`).

## Solução de problemas

| Sintoma                                         | Causa provável e o que fazer                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| O app abre sem tela de entrada                  | O build não tem `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` (Configurações → Conta diz isso). Passo 1 e 5.       |
| `npm run build` falha com "chave SECRETA"       | Foi colocada a chave `sb_secret_`/`service_role`. Use a **publishable**.                                       |
| O código não chega                              | Verifique o SMTP do passo 2, o spam e o limite de e-mails por hora; "Muitos e-mails enviados" é esse limite.   |
| "Código inválido ou vencido"                    | O código vale 10 minutos e uma vez. Peça outro em "Reenviar código".                                           |
| "Sem conexão com o servidor de contas"          | Sem internet ou projeto pausado (passo 6). O app usa o último perfil por até 7 dias.                           |
| Aluno não vê "Meu acesso" depois de reservado   | O aluno precisa estar **vinculado** (Laboratório → Alunos → Vincular conta) antes da reserva; reserve de novo. |
| Quem se cadastrou como professor continua aluno | Falta um professor aprovar em **Aprovações**; o app confere a aprovação a cada minuto, sem reabrir.            |
