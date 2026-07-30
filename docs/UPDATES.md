# Guia de Atualizacao — OpenPortal Remote

## Estrutura

```
updates/
  v1.0.0.md        <- Documentacao da versao 1.0.0
  v1.0.1.md        <- Proxima versao
  ...

docs/
  CHANGELOG.md     <- Indice mestre com todas as versoes
  UPDATES.md       <- Este arquivo (instrucoes)
```

## Fluxo para publicar uma atualizacao

### 1. Pedir para subir versao

Diga para o assistente AI:

> "Sobe versao para X.X.X"

### 2. O assistente vai fazer automaticamente:

1. Alterar a versao no `package.json`
2. Rodar `BUILD.bat` para gerar o novo instalador
3. Criar `updates/vX.X.X.md` com todas as modificacoes
4. Atualizar `docs/CHANGELOG.md` com a nova entrada
5. Commit + push para o GitHub
6. Criar Release no GitHub com os assets do instalador

### 3. No PC alvo

O app instalado detecta a nova versao automaticamente e pergunta:

> "Nova versao X.X.X disponivel. Baixando..."
> "Versao X.X.X baixada. Reiniciar agora?"

### Estrutura do arquivo de update (`updates/vX.X.X.md`)

```markdown
# vX.X.X — Nome da Versao

**Data:** YYYY-MM-DD

## O que foi implementado

- Lista de mudancas
- Novas funcionalidades
- Bugs corrigidos

## Arquivos criados/modificados

| Arquivo | Tipo | Descricao |
|---------|------|-----------|
| `caminho/do/arquivo` | Novo/Modificado | O que mudou |

## Como atualizar

Baixe o instalador na Release do GitHub ou aguarde o auto-update.
```

## Observacoes

- Commits comuns (sem mudanca de versao) nao criam arquivo em `updates/`
- So criar `updates/vX.X.X.md` quando for publicar uma nova versao
- O numero da versao no `updates/` e no `package.json` devem ser iguais
