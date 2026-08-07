# VNC Connection Troubleshooting

## Erro: "VNC server requires a password"

### Root Cause
O TightVNC (servidor remoto) está configurado com autenticação por senha. O app **não armazena nem envia senhas** — o diálogo de aprovação (Aceitar/Rejeitar) é a única trava de acesso.

### Solução

**Opção 1: Remover senha do TightVNC (recomendado)**
1. No PC remoto, abra **TightVNC Server**
2. Clique em **Admin Properties** (ícone de chave)
3. Na aba **Security**, deixe o campo de senha **vazio**
4. Clique **OK** e reinicie o TightVNC
5. Tente conectar novamente

**Opção 2: Configurar TightVNC para aceitar sem autenticação na rede privada**
1. No PC remoto, abra **TightVNC Server**
2. Clique em **Admin Properties**
3. Na aba **Security**, configure:
   - Acesso local (controle de tela): COM autenticação
   - Acesso remoto (via Tailscale): SEM autenticação (se a rede Tailscale for confiável)
4. Clique **OK** e reinicie

### Debug

Abra o **DevTools** (F12) e procure na aba **Console** por:
- `[vnc] Connect: { host: "...", port: 5900, proxyWs: "...", password: false }`
- Se vir `credentialsrequired`, significa o servidor VNC está pedindo senha

Na aba **Network**, procure pela conexão WebSocket:
- Deve estar conectada (status 101) à proxy na porta 18900
- Se conectar mas depois desconectar, problema está no TCP → VNC

### Checklist de Conexão

- [ ] Tailscale ativo nos dois PCs
- [ ] IP Tailscale alcançável (tente ping ou netcat)
- [ ] TightVNC Server rodando no PC remoto
- [ ] Porta 5900 aberta (verifique firewall)
- [ ] Diálogo de aprovação foi aceito no PC remoto
- [ ] TightVNC configurado **sem senha** (veja acima)

---

*Última atualização: 2026-08-07*
