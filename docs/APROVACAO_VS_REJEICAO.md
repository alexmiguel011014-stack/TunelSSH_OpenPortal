# Aprovação vs Rejeição — Lógica Explícita

## O Problema (Antes)

```
ANTES:
┌─────────────────────────────────────────────────────────────┐
│ User clica "Rejeitar"                                       │
│                                                             │
│ Server:                                                     │
│   └─ Envia: { approved: false }                            │
│   └─ Fecha socket (socket.end())                           │
│                                                             │
│ Client (vnc.html):                                         │
│   └─ Socket fechou, mas não sabe por quê                  │
│   └─ Tenta conectar ao VNC mesmo assim                    │
│   └─ VNC pede senha (autenticação normal)                 │
│   └─ App tenta enviar a senha                             │
│                                                             │
│ RESULTADO: Confuso!                                        │
│   ❌ "Sei que algo deu errado, mas o quê?"                │
│   ❌ É autenticação do VNC ou rejeição da conexão?        │
│   ❌ A senha é fallback ou requisito?                     │
└─────────────────────────────────────────────────────────────┘
```

---

## A Solução (Agora)

```
AGORA:
┌──────────────────────────────────────────────────────────────────┐
│ User clica "Rejeitar"                                            │
│                                                                  │
│ Server (connection-request.js):                                 │
│   └─ Envia: { approved: false, rejected: true }   ← NOVO!       │
│   └─ Fecha socket (socket.end())                               │
│                                                                  │
│ Client (App.jsx):                                              │
│   └─ Recebe: rejected: true                                    │
│   └─ Armazena em: setWasRejected(true)            ← NOVO!      │
│   └─ Passa para RemoteViewer                                   │
│                                                                  │
│ RemoteViewer.jsx:                                              │
│   └─ Monta URL: ...&rejected=true                 ← NOVO!      │
│   └─ Passa para vnc.html via iframe                            │
│                                                                  │
│ vnc.html:                                                       │
│   └─ Lê: wasRejected = true                       ← NOVO!      │
│   └─ NO HANDLER credentialsrequired:                           │
│       • Se wasRejected && !password                            │
│         → Erro claro: "Conexão recusada"                       │
│       • Se wasRejected && password                             │
│         → Tenta enviar a senha (fallback)                      │
│       • Se !wasRejected && password                            │
│         → Tenta enviar a senha (aprovado)                      │
│                                                                  │
│ RESULTADO: Claro!                                              │
│   ✅ "A conexão foi recusada pelo PC remoto"                   │
│   ✅ Se tiver senha → tenta. Se não → mostra erro.             │
│   ✅ Fluxo lógico e previsível                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Fluxos de Conexão Agora

### Cenário 1: Usuário Aceita (sem senha)

```
┌────────────────────────────────────────────┐
│ User: [Conectar]                           │
│ ↓                                           │
│ Server: "User quer conectar?"               │
│ ↓                                           │
│ User: [Aceitar]                             │
│ ↓                                           │
│ Server: { approved: true, rejected: false } │
│ ↓                                           │
│ Client: wasRejected = false                 │
│ ↓                                           │
│ vnc.html: Conecta direto (sem senha) ✓     │
│ ↓                                           │
│ RESULTADO: 🟢 Conectado                    │
└────────────────────────────────────────────┘
```

### Cenário 2: Usuário Rejeita (sem senha)

```
┌────────────────────────────────────────────┐
│ User: [Conectar]                           │
│ ↓                                           │
│ Server: "User quer conectar?"               │
│ ↓                                           │
│ User: [Rejeitar]                            │
│ ↓                                           │
│ Server: { approved: false, rejected: true } │
│ ↓                                           │
│ Client: wasRejected = true                  │
│ ↓                                           │
│ vnc.html: Pede senha                        │
│   - Tem senha? → Tenta                      │
│   - Sem senha? → Erro: "Conexão recusada"  │
│ ↓                                           │
│ RESULTADO: 🔴 Bloqueado (sem senha)        │
└────────────────────────────────────────────┘
```

### Cenário 3: Usuário Aceita (com senha configurada)

```
┌────────────────────────────────────────────┐
│ User: [Conectar]                           │
│ ↓                                           │
│ Server: "User quer conectar?"               │
│ ↓                                           │
│ User: [Aceitar]                             │
│ ↓                                           │
│ Server: { approved: true, rejected: false } │
│ ↓                                           │
│ Client: wasRejected = false                 │
│ ↓                                           │
│ vnc.html: Conecta direto (sem pedir senha)  │
│   (A senha fica só como fallback)           │
│ ↓                                           │
│ RESULTADO: 🟢 Conectado (aprovação venceu) │
└────────────────────────────────────────────┘
```

### Cenário 4: Usuário Rejeita (com senha configurada)

```
┌────────────────────────────────────────────┐
│ User: [Conectar]                           │
│ ↓                                           │
│ Server: "User quer conectar?"               │
│ ↓                                           │
│ User: [Rejeitar]                            │
│ ↓                                           │
│ Server: { approved: false, rejected: true } │
│ ↓                                           │
│ Client: wasRejected = true                  │
│ ↓                                           │
│ vnc.html: Pede senha                        │
│ ↓                                           │
│ App: Envia a senha do config                │
│ ↓                                           │
│ Senha correta?                              │
│   - Sim → Conecta 🟢                        │
│   - Não → Erro "Senha inválida" 🔴          │
│ ↓                                           │
│ RESULTADO: Fallback de segurança ✅        │
└────────────────────────────────────────────┘
```

---

## Implementação Técnica

### 1. Server (connection-request.js)

```javascript
const respond = (payload) => {
  const approved = !!payload.approved;
  // ← NOVO: Marcar explicitamente se foi rejeitado
  const finalPayload = wantsTunnel && approved
    ? { ...payload, tunnel: true }
    : { ...payload, rejected: !approved };  // rejected = true se not approved
  socket.write(JSON.stringify(finalPayload));
  // ...
};
```

### 2. Client (App.jsx)

```javascript
// ← NOVO: State para rastrear rejeição
const [wasRejected, setWasRejected] = useState(false);

// ← NOVO: Detectar rejeição na resposta
if (!res || !res.success) {
  const rejected = res?.rejected === true;  // Lê o flag do server
  if (rejected) {
    setWasRejected(true);
    addLog(`Conexão recusada pelo PC remoto`);
  }
  // ...
}

// ← NOVO: Passar para RemoteViewer
<RemoteViewer 
  machine={activeMachine} 
  wasRejected={wasRejected}  // Passa o flag
/>
```

### 3. RemoteViewer (RemoteViewer.jsx)

```javascript
// ← NOVO: Receber flag
export default function RemoteViewer({ machine, reconnectFlag, wasRejected }) {

// ← NOVO: Adicionar à URL
const rejectedParam = wasRejected ? '&rejected=true' : '';
const viewerUrl = `./noVNC/vnc.html?...${rejectedParam}`;
```

### 4. Client (vnc.html)

```javascript
// ← NOVO: Ler o flag da URL
const wasRejected = params.get('rejected') === 'true';

// ← NOVO: Usar no handler credentialsrequired
rfb.addEventListener('credentialsrequired', () => {
  if (wasRejected && !password) {
    // Rejeição explícita, sem senha → erro claro
    errorMsg.textContent = 'Conexão recusada pelo PC remoto.';
  } else if (password) {
    // Temos senha → tenta usar (aprovado ou rejeitado, não importa)
    rfb.sendCredentials({ password });
  } else {
    // Sem rejeição explícita e sem senha → erro de configuração
    errorMsg.textContent = 'Configure a senha no app.';
  }
});
```

---

## Checklist de Funcionamento

- [ ] User clica "Conectar" → Servidor pede aprovação ✓
- [ ] User clica "Aceitar" → Conecta direto ✓
- [ ] User clica "Rejeitar" sem senha → Erro "Conexão recusada" ✓
- [ ] User clica "Rejeitar" com senha → Tenta usar a senha ✓
- [ ] Console.log mostra `wasRejected` corretamente ✓
- [ ] URL do iframe tem `?rejected=true` quando rejeitado ✓
- [ ] Mensagens de erro são diferentes (rejeição vs autenticação) ✓

---

*Última atualização: 2026-08-07*
