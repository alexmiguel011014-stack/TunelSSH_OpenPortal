# VNC Password Authentication — Modo de Dois Níveis

## O Modelo de Autenticação

OpenPortal Remote usa um sistema de **aprovação + senha opcional**:

```
Tentativa de Conexão
       ↓
┌─────────────────────────────────────┐
│ PC REMOTO pede Aprovação (diálogo)  │
└─────────────────────────────────────┘
       ↓
   ┌───┴───┐
   ↓       ↓
[Aceitar] [Rejeitar]
   ↓       ↓
   │       └─→ VNC pede Senha (se configurada)
   │           └─→ Usa a senha do Config como fallback
   │
   └─→ Conecta direto (sem pedir senha)
```

## Como Configurar

### 1. Adicione a Senha VNC no Config

1. Clique em **⚙️ Configurações** no app
2. Encontre o PC remoto na lista
3. Preencha o campo **"Senha VNC (opcional)"**
4. Clique **"Salvar configuração"**

A senha é **salva localmente** no `config.json` do app.

### 2. Garanta que o TightVNC está Configurado Corretamente

**Opção A: Remover a senha do TightVNC (recomendado)**
- No PC remoto, abra **TightVNC Server → Admin Properties**
- Deixe o campo **Password** vazio
- Clique OK

**Opção B: Manter a senha (use apenas se necessário)**
- No PC remoto, configure a mesma senha no TightVNC Server
- Configure a mesma senha no OpenPortal Remote (Config)

## Fluxo de Conexão

### Cenário 1: Usuário Aceita a Aprovação

```
User clica em "Conectar"
    ↓
PC Remoto mostra: "User@IP quer se conectar?"
    ↓
User clica "Aceitar"
    ↓
VNC conecta SEM pedir senha ✓
```

→ A aprovação é a trava de acesso

### Cenário 2: Usuário Rejeita a Aprovação

```
User clica em "Conectar"
    ↓
PC Remoto mostra: "User@IP quer se conectar?"
    ↓
User clica "Rejeitar" (ou deixa timeout)
    ↓
VNC pede senha
    ↓
App envia a senha configurada no Config (fallback)
    ↓
Se a senha estiver correta → Conecta ✓
Se a senha estiver errada → Erro (tente novamente)
```

→ A senha é uma camada extra de segurança

### Cenário 3: Nenhuma Senha Configurada

```
User clica em "Conectar"
    ↓
PC Remoto mostra: "User@IP quer se conectar?"
    ↓
User clica "Rejeitar"
    ↓
VNC pede senha
    ↓
App não tem senha configurada → Erro "VNC server requires password"
```

→ Solução: Configure a senha no app OU remova do TightVNC

## Segurança

### ✅ O que é Seguro

- A aprovação remota é **sempre pedida** (não fica salva)
- Cada conexão requer aprovação manual
- A senha é **apenas um fallback** (camada extra)
- Senhas não são transmitidas pela rede (apenas via túnel criptografado)

### ⚠️ O que NÃO é Seguro

- **Não** armazene senhas em ambiente público
- A senha é salva no `config.json` localmente — **proteja este arquivo**
- Se o PC remoto tiver a senha, e você a salvar no Config, qualquer pessoa com acesso ao Config poderá usar

## Troubleshooting

### "VNC server requires a password"

1. **Verifique**: O TightVNC tem senha configurada?
   - Sim → Adicione a mesma senha no Config do app
   - Não → Deixe o campo vazio no app (deixe em branco)

2. **Teste a conexão**: Vá para Configurações → Clique "Testar conexão"
   - ✓ Acessível → Problema está na autenticação do VNC
   - ✗ Falhou → Problema está na rede/Tailscale

3. **Se ainda não funcionar**:
   - Abra **F12 → Console** e tente conectar novamente
   - Procure por logs `[vnc] Server requires password`
   - Compartilhe os logs

---

*Última atualização: 2026-08-07*
