# CLAUDE.md

See @AGENTS.md for project context, commands, architecture, and constraints.

## Claude-specific

- No `.claude/` directory, hooks, or slash commands are configured.
- No test suite — verify changes by building (`npm run build`) and checking
  for type errors (`npx tsc --noEmit`).
- When modifying tool schemas in index.ts, keep the zod schemas and the
  `SpawnOptions` interface in spawn-agent.ts in sync.
