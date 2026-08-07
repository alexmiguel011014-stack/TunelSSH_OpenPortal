# Debug do Erro "VNC server requires a password"

## O que acontece?
Você vê "Connection Failed — VNC server requires a password" quando tenta conectar ao PC remoto.

## Por que?
O TightVNC no PC remoto está configurado com uma senha, e o app **não envia senhas** (por design — o diálogo de aprovação é a única trava).

## Solução Rápida (1 min)

### Opção 1: Remover Senha do TightVNC (recomendado)
1. **No PC remoto**, abra o **TightVNC Server** (ícone na bandeja do Windows)
2. Clique em **Admin Properties** (botão com chave/cadeado)
3. Procure o campo **Password** e deixe-o **VAZIO**
4. Clique em **OK** → reinicie o TightVNC
5. Volte ao PC local e tente conectar novamente

### Opção 2: Aceitar sem senha apenas na rede Tailscale
1. **No PC remoto**, abra **TightVNC Server** → **Admin Properties**
2. Na aba **Security**, configure assim:
   - **Access control**: Local machine → WITH password
   - **Incoming connections**: Only allow local loopback (ou desabilitar autenticação remota se houver opção)
3. OK → reinicie

---

## Debug Profundo (Se ainda não funcionar)

### Step 1: Confirme que a conexão TCP passa
1. Na **Configurações** do app:
   - Informe o IP Tailscale do PC remoto
   - Clique **Testar conexão**
   - Deve aparecer ✓ **Acessível em Xms**

**Se falhar:**
- ✗ `ECONNREFUSED` → TightVNC não está rodando (inicie-o)
- ✗ `ENOTFOUND` → IP não existe (verifique no PC remoto: `ipconfig` na prompt)
- ✗ `ETIMEDOUT` → Tailscale não conecta (reinicie Tailscale nos dois PCs)

### Step 2: Abra o Console do App (F12)
1. Pressione **F12** para abrir DevTools
2. Vá para a aba **Console**
3. Tente conectar novamente
4. Procure por linhas assim:

```
[vnc] Connect: { host: "100.x.x.x", port: 5900, proxyWs: "ws://127.0.0.1:18900", password: false }
[proxy] New WebSocket connection: target 100.x.x.x:5900
[proxy] TCP connected to 100.x.x.x:5900
[vnc] Server requires password; app does not store/send passwords
```

**O que procurar:**
- Se aparecer `[proxy] TCP connected`, a conexão até o VNC funcionou
- Se depois aparecer `credentialsrequired`, o VNC está pedindo senha → siga a solução acima

### Step 3: Verifique o TightVNC no PC remoto
1. **Inicie o TightVNC Server** (se não estiver)
2. **Admin Properties** → aba **Security**
3. Veja qual é o campo de **Password** (não pode estar preenchido)
4. Se tiver algo ali, apague e clique OK

### Step 4: Teste direto com netcat/telnet (avançado)
No PC local, abra CMD/PowerShell e tente:
```powershell
Test-NetConnection -ComputerName 100.x.x.x -Port 5900 -InformationLevel Detailed
```

Se retornar `TCP test succeeded`, a porta está aberta. Se falhar, o firewall está bloqueando.

---

## Checklist Final

- [ ] IP Tailscale do PC remoto está correto (ex: 100.x.x.x)?
- [ ] Tailscale está **ativo** nos dois PCs?
- [ ] TightVNC Server está **rodando** no PC remoto?
- [ ] Porta 5900 está **aberta** no firewall do PC remoto?
- [ ] Diálogo de aprovação foi **ACEITO** no PC remoto?
- [ ] TightVNC **NÃO TEM SENHA** configurada?

Se tudo ✓, conecte novamente. Se ainda não funcionar, compartilhe as linhas de erro do **Console (F12)** com o suporte.

---

## Mais Informações
Veja [docs/VNC_TROUBLESHOOTING.md](docs/VNC_TROUBLESHOOTING.md) para instruções detalhadas.

*Última atualização: 2026-08-07*
