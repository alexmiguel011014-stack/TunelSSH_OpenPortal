# Teste Local — 3 Estratégias Sem Subir para GitHub

Você pode testar TUDO no mesmo PC SEM precisar fazer push/pull do GitHub.

---

## Solução 1: Loopback (RECOMENDADO) ⭐

**Como funciona:** Simular cliente e servidor no mesmo PC via loopback.

```
┌─────────────────────────────────────┐
│        PC Local (único)              │
│                                     │
│  Janela 1: App rodando              │
│  (porta 5173 + Electron)            │
│                                     │
│  Janela 2: App OUTRA INSTÂNCIA      │
│  (configurar para conectar em       │
│   127.0.0.1 ou localhost)           │
│                                     │
│  Resultado: Ambas rodam, uma        │
│  conecta na outra via loopback      │
└─────────────────────────────────────┘
```

### Passo-a-Passo

**Terminal 1: Rodas a primeira instância**
```bash
cd d:\ProjetosVS\TunelSSH
npm run dev
# Espera aparecer a janela do Electron
# Deixe rodando
```

**Terminal 2: Roda segunda instância (simultaneamente)**
```bash
cd d:\ProjetosVS\TunelSSH
# Use um PORT diferente para Vite
cross-env VITE_PORT=5174 npm run dev
# Ou rode o Electron diretamente apontando para porta 5174
```

### Configurar Conexão

**Na segunda instância:**
1. Vá para **Configurações**
2. Adicione/configure um PC remoto:
   - **Nome:** "PC Local (teste)"
   - **IP:** `127.0.0.1` (localhost)
   - **Porta:** `5900` (TightVNC padrão)
   - **Senha VNC:** (deixe em branco por enquanto)
3. Clique **Testar conexão**
   - Deve falhar (TightVNC não está rodando em loopback)

### Problema com TightVNC

O TightVNC só funciona **aceitar conexões**, não rodar dois em paralelo.

**Solução:** Use um servidor VNC alternativo ou teste só o diálogo de aprovação (sem VNC).

---

## Solução 2: Dois PCs na Mesma Rede (IDEAL) ⭐⭐

**Como funciona:** PC A conecta em PC B via rede local (sem internet, sem Tailscale).

```
┌──────────────────────────────────────────┐
│  PC Local A (Seu notebook)               │
│  IP: 192.168.1.100                       │
│  ┌────────────────────────────────┐     │
│  │ App OpenPortal rodando         │     │
│  │ Conectar em: 192.168.1.101     │ ←── │
│  └────────────────────────────────┘     │
│           ↓ (rede local)                  │
│           ↓ (WiFi/Ethernet)              │
│  ┌────────────────────────────────────┐  │
│  │ PC Local B (Outro PC disponível)   │  │
│  │ IP: 192.168.1.101                  │  │
│  │ ┌──────────────────────────────┐   │  │
│  │ │ App OpenPortal rodando       │   │  │
│  │ │ + TightVNC rodando           │   │  │
│  │ └──────────────────────────────┘   │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

### Vantagens

✅ Testa tudo: aprovação, VNC, arquivos  
✅ Testa rede real (não loopback)  
✅ Mais realista que loopback  
✅ Sem precisar de GitHub

### Desvantagens

❌ Precisa de 2 PCs  
❌ Precisa configurar rede

### Passo-a-Passo

**PC B (Remoto):**
1. Instale TightVNC Server
2. Configure sem senha (ou com a senha que você vai usar)
3. Abra o app OpenPortal Remote
4. Deixe rodando aguardando conexões

**PC A (Local):**
1. Abra terminal
2. Descubra seu IP: `ipconfig` (procure "IPv4 Address")
3. Abra o app OpenPortal Remote
4. Vá para Configurações
5. Adicione PC B:
   - **Nome:** "PC B (teste local)"
   - **IP:** `192.168.1.101` (IP do PC B)
   - **Porta:** `5900`
   - **Senha VNC:** (deixe em branco)
6. Clique **Testar conexão**
   - Deve aparecer ✓ Acessível em Xms
7. Clique **Conectar**
   - Será pedida aprovação em PC B
   - Clique Aceitar
   - VNC deve conectar

---

## Solução 3: Dois Processos Electron no Mesmo PC (AVANÇADO) ⚡

**Como funciona:** Rodar dois Electrons simultaneamente, cada um com sua janela.

```
PC Local
├─ Electron #1 (porta 5173)
│  └─ App Cliente
│
└─ Electron #2 (porta 5174)
   └─ App Servidor (aguardando conexões)
```

### Setup

**Terminal 1:**
```bash
cd d:\ProjetosVS\TunelSSH
npm run dev
# App 1 abre em 127.0.0.1:5173
```

**Terminal 2:**
```bash
cd d:\ProjetosVS\TunelSSH
# Rodar Vite em porta diferente
npm run dev:renderer &
wait-on http://127.0.0.1:5174
cross-env NODE_ENV=development VITE_PORT=5174 electron .
```

### Problema

Ambas vão tentar usar porta 18902 (ConnectionRequestServer).

**Solução:** Modificar código para usar porta dinâmica se já estiver em uso.

```javascript
// Em main.js, linha ~305
const SIGNAL_PORT = findFreePort(18902);  // Procura porta livre

function findFreePort(startPort) {
  // Lógica para encontrar porta disponível
}
```

**Complexidade:** 🔴 Média (requer modificação de código)

---

## Solução 4: Usar Docker (HARDCORE) 🐳

**Como funciona:** Rodar duas instâncias em containers Docker no mesmo PC.

```bash
docker run -p 5900:5900 openportal:latest  # Servidor
docker run -p 5901:5900 openportal:latest  # Cliente
```

**Vantagens:**
✅ Testa em ambiente isolado  
✅ Muito realista

**Desvantagens:**
❌ Requer Docker instalado  
❌ Requer Dockerfile  
❌ Complexo

**Recomendação:** Só se você já usa Docker regularmente.

---

## Solução 5: Modo "Mock" (MAIS RÁPIDO) 🚀

**Como funciona:** Simular o servidor remoto sem realmente rodá-lo.

### Criar Mock Server

**Arquivo: `src/main/mock-server.js`**

```javascript
const net = require('net');

class MockRemoteServer {
  constructor(port = 18902) {
    this.port = port;
    this.shouldApprove = true; // Toggle entre aprovar/rejeitar
  }

  start() {
    const server = net.createServer((socket) => {
      console.log('[mock] Conexão recebida');
      
      socket.on('data', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log('[mock] Recebeu:', msg);
          
          // Simular resposta
          const response = {
            type: 'connect-response',
            requestId: msg.requestId,
            approved: this.shouldApprove,
            rejected: !this.shouldApprove,
            message: this.shouldApprove ? 'Aprovado!' : 'Rejeitado!'
          };
          
          socket.write(JSON.stringify(response));
          socket.end();
        } catch (err) {
          console.error('[mock] Erro:', err);
          socket.end();
        }
      });
    });

    server.listen(this.port, '127.0.0.1', () => {
      console.log(`[mock] Servidor rodando em porta ${this.port}`);
    });

    return server;
  }

  setApprovalMode(approve) {
    this.shouldApprove = approve;
    console.log(`[mock] Modo: ${approve ? 'APROVAR' : 'REJEITAR'}`);
  }
}

module.exports = { MockRemoteServer };
```

### Usar em Dev

**Em main.js:**

```javascript
const isDev = process.env.NODE_ENV === 'development';
const useMockServer = process.env.OPENPORTAL_MOCK === 'true';

if (isDev && useMockServer) {
  const { MockRemoteServer } = require('./mock-server');
  const mockServer = new MockRemoteServer(18903); // porta diferente
  mockServer.start();
  
  // Expor via IPC para mudar modo
  ipcMain.handle('mock:setApprovalMode', (_, approve) => {
    mockServer.setApprovalMode(approve);
  });
}
```

### Rodar com Mock

```bash
OPENPORTAL_MOCK=true npm run dev
```

### Na UI

Você pode adicionar botões para alternar entre Aprovar/Rejeitar:

```javascript
// Em App.jsx
const toggleMockApproval = async (approve) => {
  await window.electronAPI?.mockSetApprovalMode?.(approve);
};
```

---

## Comparação das Soluções

| Solução | Setup | Realismo | Velocidade | Recomendação |
|---------|-------|----------|-----------|--------------|
| **Loopback** | 5 min | 30% | Muito rápido | ❌ Limitado |
| **Dois PCs Local** | 10 min | 95% | Rápido | ✅ IDEAL |
| **Dois Electron** | 20 min | 100% | Rápido | ⚠️ Complexo |
| **Docker** | 30 min | 100% | Médio | ❌ Overhead |
| **Mock Server** | 15 min | 70% | Muito rápido | ✅ BOM |

---

## Recomendação: Solução Híbrida 🏆

**Combine 2 estratégias:**

1. **Desenvolvimento rápido:** Use **Mock Server**
   - Testa diálogos, UX, logs
   - Alterna entre Aprovar/Rejeitar com 1 clique
   - Sem precisar de rede/outro PC

2. **Teste final:** Use **Dois PCs Local**
   - Testa tudo end-to-end
   - Antes de fazer push no GitHub

---

## Setup Recomendado (Meu Voto)

### Para Hoje (Teste Rápido)

```bash
# Terminal 1
npm run dev

# Terminal 2 (após alguns segundos)
OPENPORTAL_MOCK=true npm run dev
```

**Resultado:**
- App 1: Cliente normal
- App 2: Cliente + Mock Server respondendo
- Você testa aprovação/rejeição/senha em 1 minuto

### Para Amanhã (Teste Real)

Use o PC remoto que você tem + TightVNC.

---

## Próximos Passos

1. **Quer que eu implemente o Mock Server?**
   ```bash
   Sim → Faço em 10 min
   ```

2. **Quer um script que rode os 2 Electrons?**
   ```bash
   Sim → Faço em 15 min
   ```

3. **Quer documentação de como testar cada feature?**
   ```bash
   Sim → Faço em 20 min
   ```

---

*Última atualização: 2026-08-07*
