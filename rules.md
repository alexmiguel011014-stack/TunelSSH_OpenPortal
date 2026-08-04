# OPERATIONAL RULES

## Token Economy
- **Reading:** NEVER read `external/` or `node_modules/` fully.
- **Context:** Use `graphify-out/` or `repomix-output.xml` for codebase mapping.
- **Edits:** Provide ONLY modified code blocks (Caveman mode). NEVER rewrite entire files.

## Workflow Execution
1. Plan changes with `@architect`.
2. Apply surgical edits with `@coder`.
3. Validate and run linter/tests with `@reviewer`.

## Self-Correction
- Run project test/typecheck commands after edits (`npx tsc`, `biome check`, etc.).
- Fix failures before delivering final response.
- Always respond in the language used by the user in their prompt.

## Git & GitHub Deploy
- **Commit & push a cada mudança:** Após cada tarefa implementada e validada (build/teste passando), fazer `git add` dos arquivos relevantes, `git commit` com mensagem concisa e `git push` para o branch remoto para a pessoa testar nos dois PCs.
- **Release (bump de versão + instalador + upload) SOMENTE sob ordem explícita da pessoa.** Nunca criar novo release/`latest.yml`/asset sem que o usuário ordene.
- Inspecionar `git status`, `git diff` e `git log --oneline` antes de commitar; nunca commitar segredos (tokens/PATs).
- Mensagens de commit no estilo do repositório, curtas e descritivas da mudança.

## GLOBAL ENVIRONMENT & TOOLING REQUERIMENTS
- **Environment Dependency:** This environment relies on global CLI tools installed on the host machine (`gh`, `graphify`, `repomix`, `biome`).
- **Initialization Check:** If `graphify-out/` or `repomix-output.xml` are missing in a new project, ALWAYS instruct the user to run `/bootstrap` or execute `.\bootstrap.ps1` in PowerShell.
- **Enforced Workflows:**
  - Code formatting MUST use global Biome (`biome check --write .`).
  - Codebase analysis MUST read `graphify-out/` before full-file scans.
  - Pull requests and Git management MUST use GitHub CLI (`gh pr create`).
