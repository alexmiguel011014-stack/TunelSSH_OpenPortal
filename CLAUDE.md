# Base Project Index
- Active automation and token-saving rules.
- Follow directives in `rules.md`.
- Conferir esses arquivos ao iniciar um contexto novo.

## Início automático (ao abrir contexto)
- Leia `rules.md` e `eco_tokens/rules.md` antes de qualquer edição.
- Antes de varrer arquivos, leia o mapa do projeto em `graphify-out/` (ou `repomix-output.xml`).
- Se `graphify-out/` ou `repomix-output.xml` estiverem ausentes, rode `/bootstrap` (ou `.\bootstrap.ps1`) uma vez.
- Mapeie a estrutura geral de `eco_tokens/` e os sub-agentes de `.opencode/agent/`.

## Fluxo de trabalho recomendado
- Planeje antes de editar: analise o mapa do projeto e defina um plano curto de 3 a 5 passos.
- Implemente com edições cirúrgicas e precisas.
- Ao final, valide: rode linter/testes/typecheck e revise o que foi alterado.

## Organização
- Mantenha o projeto organizado (sem código morto, sem duplicação).
- Entregue apenas blocos modificados (modo "caveman"), nunca arquivos inteiros.
- Sempre valide com linter/testes/typecheck ao final de cada mudança.