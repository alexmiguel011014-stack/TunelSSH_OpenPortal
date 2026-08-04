# Base Project Index
- Active automation and token-saving rules.
- Follow directives in `rules.md`.
- Available sub-agents in `.opencode/agent/`:
  - `@architect`: Architecture, analysis, and planning (read-only).
  - `@coder`: Code implementation and refactoring.
  - `@reviewer`: Testing, validation, and git commits.
- Run `/bootstrap` to initialize the project environment.

## Workflow (importante)
- Após cada mudança implementada e validada: **comitar e dar push** para você testar nos dois PCs.
- **NÃO** criar release nova (bump de versão + instalador + `latest.yml`) a menos que você ordene explicitamente.
