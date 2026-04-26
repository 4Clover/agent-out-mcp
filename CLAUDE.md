# CLAUDE.md

See @AGENTS.md for project context, commands, architecture, and constraints.

## Claude-specific

- No `.claude/` directory, hooks, or slash commands are configured.
- Verify changes by building (`just build`) and running tests (`just test`).
  Typecheck separately with `just check`.
- Zod schemas and the `SpawnOptions` type live in `schemas.ts` — update
  there, not in index.ts or spawn-agent.ts.

## AI Context (codesight)

- Full context map: `.codesight/CODESIGHT.md`
- Wiki index: `.codesight/wiki/index.md`
- Start with wiki for orientation, then read source files.
- Use `codesight_get_blast_radius` before modifying high-impact files.
