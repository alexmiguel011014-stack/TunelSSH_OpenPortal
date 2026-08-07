# Quick Test — Testar Tudo em 30 Segundos

## O Jeito Rápido

Quer testar aprovação/rejeição/senha **SEM** subir para GitHub? 👇

### Terminal

```bash
cd d:\ProjetosVS\TunelSSH
OPENPORTAL_MOCK=true npm run dev
```

### Espere aparecer a janela Electron

Quando o app abrir:

1. **Vá para Configurações** (⚙️ botão no canto)
2. **Procure o painel roxo** (Mock Server)
3. **Você verá 3 botões:**
   - ✓ Sempre Aprovar (verde)
   - ✗ Sempre Rejeitar (vermelho)
   - ⇄ Alternar (amarelo)

---

## Teste 1: Aprovar (30 segundos)

```
1. Em Configurações, clique "Sempre Aprovar"
2. Volte para Dashboard (← botão ou clique em PC)
3. Veja um PC remoto na lista (ou crie em Config)
4. Configure IP para: 127.0.0.1
5. Clique Conectar
   ↓
   Você verá: "Conexão aprovada por..."
   ↓
   VNC tentará conectar
   ↓
   (Vai falhar porque não tem TightVNC rodando, mas a lógica de aprovação funciona!)
```

---

## Teste 2: Rejeitar (30 segundos)

```
1. Em Configurações, clique "Sempre Rejeitar"
2. Volte ao Dashboard
3. Clique Conectar no mesmo PC
   ↓
   Você verá: "Conexão recusada pelo PC remoto"
   ↓
   Perfeitooo! A lógica de rejeição está clara.
```

---

## Teste 3: Rejeitar + Senha (30 segundos)

```
1. Em Configurações, configure uma senha (ex: "123456")
2. Mude para "Sempre Rejeitar"
3. Volte ao Dashboard
4. Clique Conectar
   ↓
   Agora a lógica tenta usar a senha!
   ↓
   Console mostra: "[vnc] Server requires password"
                   "[vnc] Sending configured password..."
   ↓
   (Vai falhar porque mock server não valida, mas prova que o fallback funciona!)
```

---

## Teste 4: Alternar (60 segundos)

```
1. Em Configurações, clique "Alternar"
2. Dashboard → Conectar
   ↓
   Primeira conexão: APROVADO ✓
3. Dashboard → Reconectar
   ↓
   Segunda conexão: REJEITADO ✗
3. Dashboard → Reconectar
   ↓
   Terceira conexão: APROVADO ✓
   
Perfeito para testar os dois fluxos em sequência!
```

---

## O Que Verificar nos Logs

Abra **F12 → Console** e procure por:

### Se aprovado:
```
[app] Connecting to PC Local (127.0.0.1:5900) with fromIp=
[app] Connection approved, tunnel session: 123abc...
[mock] Recebeu connect-request: { fromName: '...', capability: 'vnc' }
[mock] Enviando resposta: { ..., approved: true, rejected: false }
```

### Se rejeitado:
```
[app] Connecting to PC Local (127.0.0.1:5900) with fromIp=
[app] Connection explicitly rejected by user
[mock] Recebeu connect-request: { fromName: '...', capability: 'vnc' }
[mock] Enviando resposta: { ..., approved: false, rejected: true }
```

---

## Troubleshooting

### "Mock Server desativo"
- Você rodou sem `OPENPORTAL_MOCK=true`
- **Solução:** Mate o processo e rode com a flag

```bash
# Errado:
npm run dev

# Correto:
OPENPORTAL_MOCK=true npm run dev
```

### MockPanel não aparece
- Procure em **Configurações** (⚙️ ícone)
- Deve ser um painel roxo no topo

### "Cannot find property 'mockSetMode'"
- Build desatualizado
- **Solução:** 
```bash
npm run build
OPENPORTAL_MOCK=true npm run dev
```

### Conexão não responde
- TightVNC não está rodando (esperado)
- Mock server só simula a **aprovação**, não o VNC
- Você vai ver os logs de aprovação/rejeição, mas VNC falhará
- É normal! O objetivo é testar a lógica de diálogo.

---

## Checklist de Funcionalidades

- [ ] Mock Server está ativo (painel roxo em Configurações)
- [ ] "Sempre Aprovar" conecta sem erro de rejeição
- [ ] "Sempre Rejeitar" mostra "Conexão recusada"
- [ ] Com senha + Rejeitar, tenta usar a senha
- [ ] "Alternar" funciona nas múltiplas conexões
- [ ] Logs em F12 Console mostram `[mock]` e `[app]`
- [ ] Reconectar funciona

---

## Próximo Passo

Quando quiser testar com VNC real:

1. Use um PC remoto na rede local (Solução 2 em TESTE_LOCAL.md)
2. Ou rode TightVNC em loopback (complexo)
3. Ou faça push para GitHub e teste em outro PC

Mas para 90% dos testes de lógica, **Mock Server é suficiente!** 🚀

---

*Última atualização: 2026-08-07*
