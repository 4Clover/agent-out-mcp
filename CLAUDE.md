# CLAUDE.md

See @AGENTS.md for project context, commands, architecture, and constraints.

## AI Context (codesight)

- Full context map: `.codesight/CODESIGHT.md` (libraries, env vars,
  dependency graph, most-imported files).
- Wiki index: `.codesight/wiki/index.md` — start here for orientation,
  then read source files.
- Knowledge map: `.codesight/KNOWLEDGE.md`.
- Use `codesight_get_blast_radius` before modifying high-impact files
  (`spawn-agent.ts`, `process-session.ts`, `session-store.ts`,
  `schemas.ts`).
- Re-run `npx codesight --wiki` after significant structural changes.

## Docs

- @docs/adr/0001-process-session-extraction.md — rationale for the
  ProcessSession extraction and the terminal-state guarantee.

## CI

- `.github/workflows/claude.yml` — `@claude` mention bot on issues, PR
  comments, and reviews.
- `.github/workflows/claude-code-review.yml` — auto code review on PR
  open / synchronize / ready_for_review / reopen.
- No build/test CI is configured.

## Claude-specific

- No `.claude/` directory, hooks, or slash commands are configured.
