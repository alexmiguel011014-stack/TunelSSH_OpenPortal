# Resumo — Estratégias de Teste

## Antes vs Depois

### ❌ ANTES (Seu workflow anterior)

```
1. Fazer mudança no código (5 min)
2. git add + git commit (2 min)
3. git push origin master (1 min)
4. Esperar GitHub Actions builda .exe (5-10 min)
5. Ir para outro PC
6. Baixar .exe novo (2-5 min)
7. Testar a mudança (5 min)
8. Se quebrou: volta ao passo 1

TEMPO TOTAL POR CICLO: 25-35 minutos 🐌
```

### ✅ DEPOIS (Com Mock Server)

```
1. Fazer mudança no código (5 min)
2. OPENPORTAL_MOCK=true npm run dev (10 sec)
3. Testar em Configurações (30 sec)
4. Ver resultado imediato (segundos)

SE QUEBROU: Corrige e repete passo 2-3 (< 1 min)

TEMPO TOTAL POR CICLO: < 1 minuto 🚀
```

**Ganho: 24-34 minutos por ciclo!**

---

## 5 Estratégias de Teste

### 1️⃣ **Mock Server** (MAIS RÁPIDO) ⚡⚡⚡

```bash
OPENPORTAL_MOCK=true npm run dev
```

**Quando usar:** Desenvolvimento diário, testes de lógica  
**Tempo setup:** 10 segundos  
**Realismo:** 70% (testa diálogo, não testa VNC)  
**Ciclo:** < 1 minuto  

✅ Pros:
- Testa em mesmo PC
- Sem dependências externas
- Feedback instantâneo
- Fácil alternar entre modes

❌ Contras:
- Não testa VNC real
- Não testa rede

---

### 2️⃣ **Dois PCs Local** (MAIS REALISTA) 🎯

```
PC A (seu notebook)          PC B (outro PC)
    ↓ Conecta em               ↑ Aguarda
127.0.0.1:5900
```

**Quando usar:** Teste final, antes de push GitHub  
**Tempo setup:** 10 minutos (configurar rede)  
**Realismo:** 95% (end-to-end)  
**Ciclo:** 2-3 minutos  

✅ Pros:
- Testa rede real
- Testa VNC real
- Testa arquivo real
- Muito realista

❌ Contras:
- Precisa 2 PCs
- Configuração mais complexa

---

### 3️⃣ **GitHub + GitHub Actions** (PADRÃO) 📦

```bash
git push origin master
# Espera 5-10 min
# Baixa .exe em outro PC
```

**Quando usar:** Releases, testes em CI/CD  
**Tempo setup:** 0 (já configurado)  
**Realismo:** 100% (exe real)  
**Ciclo:** 15-25 minutos  

✅ Pros:
- Testa build real
- CI/CD automatizado
- Gera release

❌ Contras:
- Lento
- Ciclos longos
- Não bom para desenvolvimento

---

### 4️⃣ **Docker** (ISOLADO) 🐳

```bash
docker run -e OPENPORTAL_MOCK=true openportal:latest
```

**Quando usar:** Testes em ambiente isolado  
**Tempo setup:** 20 minutos (criar Dockerfile)  
**Realismo:** 100% (ambiente separado)  
**Ciclo:** 2-3 minutos  

✅ Pros:
- Ambiente isolado
- Reproduzível
- CI/CD friendly

❌ Contras:
- Complexo
- Requer Docker

---

### 5️⃣ **Dois Electron Simultaneously** (HARDCORE) ⚡⚡⚡⚡⚡

```bash
Terminal 1: npm run dev
Terminal 2: npm run dev (porta diferente)
```

**Quando usar:** Testes avançados de sincronização  
**Tempo setup:** 20 minutos (modificar código)  
**Realismo:** 100% (dois apps reais)  
**Ciclo:** 2-3 minutos  

✅ Pros:
- Dois Electrons reais
- Testa sincronização
- Muito realista

❌ Contras:
- Complexo
- Requer modificações de código

---

## Matriz de Decisão

| Cenário | Estratégia Recomendada |
|---------|------------------------|
| Desenvolvendo nova feature | Mock Server ⚡ |
| Testando diálogo de aprovação | Mock Server ⚡ |
| Testando modo offline | Mock Server ⚡ |
| Testando com rede real | Dois PCs Local 🎯 |
| Testando VNC + Arquivos e2e | Dois PCs Local 🎯 |
| Testando sincronização | Dois Electron ⚡⚡⚡⚡ |
| Release para produção | GitHub + Actions 📦 |
| Teste em staging isolado | Docker 🐳 |

---

## Recomendação: Abordagem Híbrida

### **Desenvolvimento (dia-a-dia)**

```
1. Mock Server (OPENPORTAL_MOCK=true npm run dev)
   → Testa lógica rapidamente
   → < 1 min por ciclo

2. Quando pronto → Dois PCs Local
   → Testa e2e
   → Antes de fazer push
```

### **Release**

```
1. Dois PCs Local → Teste final ✓
2. git commit + git push
3. Espera GitHub Actions builda
4. Baixa .exe em outro PC remoto
5. Teste final em produção
```

---

## Como Começar Agora

### Passo 1: Testar Mock Server (5 minutos)

```bash
cd d:\ProjetosVS\TunelSSH
OPENPORTAL_MOCK=true npm run dev
# Vá para Configurações, procure painel roxo
# Clique "Sempre Aprovar"
# Dashboard → Conectar em 127.0.0.1
# Verá: "Conexão aprovada"
```

### Passo 2: Testar Rejeição (5 minutos)

```bash
# Mesmo app já rodando, clique "Sempre Rejeitar"
# Dashboard → Reconectar
# Verá: "Conexão recusada"
```

### Passo 3: Testar com Senha (5 minutos)

```bash
# Configurações → Configure senha "123"
# Clique "Sempre Rejeitar"
# Dashboard → Conectar
# Console mostra: "[vnc] Sending configured password..."
```

**Total: 15 minutos de testes. Pronto para usar!** 🚀

---

## Status Atual

✅ **Mock Server implementado**
- ✅ 3 modos (approve, reject, toggle)
- ✅ IPC handlers expostos
- ✅ Painel de controle na UI
- ✅ Documentação

✅ **Dois PCs Local (manual)**
- Usa rede local, sem GitHub
- Guia em TESTE_LOCAL.md

✅ **GitHub Actions (existente)**
- Já automatizado
- AGENTS.md documenta

---

## Arquivos de Documentação

| Arquivo | Propósito |
|---------|-----------|
| **QUICK_TEST.md** | 30 seg test tutorial (start here!) 🚀 |
| **TESTE_LOCAL.md** | Todas as 5 estratégias explicadas |
| **RESUMO_TESTES.md** | Este arquivo (visão geral) |
| **APROVACAO_VS_REJEICAO.md** | Como funciona a lógica |
| **ARQUITETURA_CONEXAO.md** | OpenPortal vs AnyDesk |

---

## Próximos Passos

1. **Tente o Mock Server agora:**
   ```bash
   OPENPORTAL_MOCK=true npm run dev
   ```

2. **Leia QUICK_TEST.md** para detalhes

3. **Se quiser testar com rede real:**
   - Leia TESTE_LOCAL.md → Solução 2

4. **Quando pronto para produção:**
   - `git push origin master`
   - Teste .exe em outro PC

---

**Você agora tem:**
- ✅ Testes ultra-rápidos (Mock Server)
- ✅ Testes realistas (Dois PCs)
- ✅ Testes de produção (GitHub Actions)
- ✅ Documentação completa

**Ciclo de desenvolvimento: 25+ min → <1 min** 🚀🚀🚀

*Última atualização: 2026-08-07*
