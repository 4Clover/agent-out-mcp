# agent-link-mcp

MCP server that spawns CLI coding agents (Claude, Codex, Gemini, Aider, or
custom) as subprocesses with bidirectional communication. An MCP host calls
`spawn_agent`, gets results back, and can exchange follow-ups via the
`[QUESTION]` protocol.

## Commands

- Install: `just install` (or `pnpm install`)
- Build: `just build` (tsc → dist/)
- Typecheck: `just check` (or `npx tsc --noEmit`)
- Test all: `just test`
- Test single: `just test-file <name>` (e.g. `just test-file spawn-agent`)
- Test watch: `just test-watch`
- CI (typecheck + test): `just ci`
- Dev: `just dev` (Node 22+ required — uses `--experimental-strip-types`)
- Start: `just start` (builds first, then runs dist/index.js)
- Clean: `just clean` (removes dist/)
- Register (compiled): `claude mcp add agent-link node /absolute/path/to/dist/index.js`
- Register (source): `claude mcp add agent-link node --experimental-strip-types /absolute/path/to/src/index.ts`

## Architecture

Five source files in `src/`:

- **index.ts** — MCP server entry point. Registers six tools (spawn_agent,
  spawn_agents, reply, kill_agent, list_agents, get_status) on a stdio
  transport using `@modelcontextprotocol/sdk`.
- **agents.ts** — `AgentConfig` type and `DEFAULT_AGENTS` map (claude, codex,
  gemini, aider). Each config specifies the CLI command, static args, and
  whether the prompt uses a flag (`promptFlag`) or positional arg.
- **schemas.ts** — Zod schemas for tool inputs and the `SpawnOptions` type.
  Update schemas here, not in index.ts or spawn-agent.ts.
- **spawn-agent.ts** — Core spawning logic. Loads user overrides from
  `~/.agent-link/config.json` (or `AGENT_LINK_CONFIG` env var), merges with
  defaults, builds the prompt (injecting context fields), spawns the child
  process, and monitors stdout for the `[QUESTION]` protocol marker.
- **session-store.ts** — In-memory `Map<string, AgentSession>` keyed by
  agentId. Sessions are intentionally ephemeral — lost on server restart
  because MCP hosts spawn a fresh server process per session.

## Bidirectional Protocol

When a subprocess prints `[QUESTION] <text>` to stdout, spawnAgent resolves
immediately with `{ status: "waiting_for_reply", question }`. The subprocess
stays alive. The host calls `reply(agentId, message)` which writes to stdin
and waits for the next `[QUESTION]` or process exit.

- 30-second silence timeout in `reply` returns partial output without killing
  the process.
- 1-hour default timeout for the overall spawn (configurable via `timeoutMs`).

## Custom Agents

Users add agents in `~/.agent-link/config.json` under an `agents` key. The
config shape matches `AgentConfig` from `agents.ts`. Custom entries merge with
and can override defaults. Override the config path with the
`AGENT_LINK_CONFIG` environment variable.

## Conventions

- ESM throughout (`"type": "module"` in package.json, Node16 module resolution).
- All imports use `.js` extensions (required for ESM + tsc).
- `strict: true` in tsconfig.

## Testing

- Framework: vitest (config in `vitest.config.ts`)
- Tests live in `src/__tests__/` and are excluded from the tsc build.
- Three test files: `server.test.ts`, `session-store.test.ts`, `spawn-agent.test.ts`.
- Zod schemas and the `SpawnOptions` type live in `schemas.ts` — update
  there, not in index.ts or spawn-agent.ts.

## Constraints

- The built-in agent configs use permissive flags on purpose (claude:
  `--dangerously-skip-permissions`, codex: `--full-auto`, aider:
  `--yes-always`). These are not a security issue to fix — they are required
  for non-interactive subprocess operation.
- Sessions are ephemeral by design. Do not add persistence — the MCP host
  spawns a fresh server process per session.
- The `[QUESTION]` protocol marker must be exactly `[QUESTION] ` (with a
  trailing space) at the start of a stdout line. Do not change the format
  without updating all detection logic in both spawn-agent.ts and index.ts.
- Do not add interactive prompts or TTY detection — the server communicates
  only via MCP stdio transport.
- The server uses a single stdio transport (`StdioServerTransport`). Do not
  add HTTP or SSE transports without a flag to select between them.

## Gotchas

- Dev mode (`just dev`) requires Node 22+ for `--experimental-strip-types`.
  The build (`just build`) works on any Node that supports ES2022.
- `isCommandAvailable` in spawn-agent.ts spawns and immediately kills a
  process to check PATH availability — it is not a reliable check for all CLIs.
- The `[QUESTION]` detection splits on `[QUESTION]` anywhere in a stdout
  chunk, not just at line boundaries. If an agent's normal output contains
  this exact string, it will trigger a false positive.
