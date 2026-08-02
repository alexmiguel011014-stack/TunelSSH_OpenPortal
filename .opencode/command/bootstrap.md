---
description: Run environment setup and generate codebase graph.
---

Execute o bootstrap do ambiente:

1. Windows: rode `powershell -File bootstrap.ps1`. Linux/mac: rode `bash bootstrap.sh`.
2. O script já verifica/instala as ferramentas globais (gh, graphify, repomix, biome, typescript) e gera `repomix-output.xml` + `graphify-out/` no projeto atual.
3. Se algo falhar, reporte o erro exato e a ferramenta que faltou.
4. Ao final, responda APENAS: ferramentas já existentes vs instaladas + status dos artefatos gerados.

$ARGUMENTS
