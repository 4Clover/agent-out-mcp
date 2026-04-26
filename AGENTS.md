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
- Test single: `just test-file <name>` (e.g. `just test-file process-session`)
- Test watch: `just test-watch`
- CI (typecheck + test): `just ci`
- Dev: `just dev` (Node 22+ required — uses `--experimental-strip-types`)
- Start: `just start` (builds first, then runs dist/index.js)
- Clean: `just clean` (removes dist/)
- Register (compiled): `claude mcp add agent-link node /absolute/path/to/dist/index.js`
- Register (source): `claude mcp add agent-link node --experimental-strip-types /absolute/path/to/src/index.ts`

## Architecture

Six source files in `src/`:

- **index.ts** — MCP server entry point; registers seven tools on stdio.
- **agents.ts** — `AgentConfig` type and `DEFAULT_AGENTS` map (claude, codex,
  gemini, aider) with per-CLI `flagMap` and env settings.
- **schemas.ts** — Zod schemas for all tool inputs and config validation.
  Update schemas here, not in index.ts or spawn-agent.ts.
- **process-session.ts** — Lifecycle owner for a child process. State machine
  with terminal-state guarantee, byte-capped output buffer (8 MB,
  drop-oldest), and FIFO waiter queue powering `waitNext`.
- **spawn-agent.ts** — Loads user config from `~/.agent-link/config.json`
  (or `AGENT_LINK_CONFIG`), Zod-validates, builds args via `flagMap`,
  resolves env, and creates a `ProcessSession`.
- **session-store.ts** — In-memory `Map<string, ProcessSession>` with
  5-minute eviction timer for terminal sessions.

## Bidirectional Protocol

A subprocess line starting with `[QUESTION] <text>` transitions the session
to `waiting_for_reply`. The host calls `reply(agentId, message)` which
writes to stdin and waits for the next event:

- Next `[QUESTION]` → `{ status: "waiting_for_reply", question, partial }`.
- Process close → `{ status: "done"|"error"|"killed", result, error? }`.
- 30-second silence → `{ status: "running", partial }`. The host should
  call `wait_agent` to await the next event without writing duplicate input.

The marker must be exactly `[QUESTION] ` (with trailing space) at the
**start of a line**. Mid-line substrings do not trigger.

The spawn timeout (default 1 hour) survives question events — a runaway
child still terminates at the deadline. After timeout-triggered kill, a
late `'close 0'` is **not** treated as `done` (terminal-state guarantee).

## Custom Agents

Users add agents in `~/.agent-link/config.json` under an `agents` key:

```json
{
  "agents": {
    "mytool": {
      "command": "mytool",
      "args": ["--non-interactive"],
      "promptFlag": "--prompt",
      "flagMap": { "model": "--model", "thinking": "--effort" },
      "env": ["MYTOOL_TOKEN"]
    }
  }
}
```

- Config is Zod-validated; typos surface as stderr warnings.
- `flagMap` keys: `model`, `thinking` only.
- `env` defaults to a safe allowlist; `PATH` is always present. Set
  `"passthrough"` to inherit the full parent env.
- Keys are lowercased; a user entry matching a built-in name overrides it.
- Override the config path with `AGENT_LINK_CONFIG` env var.

## Conventions

- ESM throughout; all imports use `.js` extensions (required for ESM + tsc).
- `cwd` in `spawn_agent` must be an absolute path (POSIX or Windows).
- Output is byte-capped at 8 MB per session (drop-oldest).
- Maximum 50 concurrent sessions enforced by session-store.

## MCP wire surfaces

- New in v2.0.0: `wait_agent` tool.
- Renamed in v2.0.0: `outputLines` → `outputChunks` on `get_status`.
- New in v2.0.0: `waitingAgents: string[]` on `spawn_agents` response.
- Unknown-agent error responses use `agentId: null` (not the literal `""`).

See [`CHANGELOG.md`](./CHANGELOG.md) for the full v2.0.0 migration notes.

## Testing

- Framework: vitest (config in `vitest.config.ts`)
- Tests live in `src/__tests__/` and are excluded from the tsc build.
- Six test files: `server.test.ts`, `session-store.test.ts`,
  `spawn-agent.test.ts`, `schemas.test.ts`, `process-session.test.ts`,
  `config-loading.test.ts`.

## Constraints

- The built-in agent configs use permissive flags on purpose (claude:
  `--dangerously-skip-permissions`, codex: `--full-auto`, aider:
  `--yes-always`). These are not a security issue to fix — they are required
  for non-interactive subprocess operation.
- Sessions are ephemeral by design. Terminal sessions auto-expire from the
  in-memory store after 5 minutes; restart of the MCP server process
  also clears them. Do not add persistence — the MCP host spawns a fresh
  server process per session.
- The `[QUESTION]` protocol marker must be exactly `[QUESTION] ` (with a
  trailing space) at the **start of a line**. Do not change the format
  without updating the line regex in `process-session.ts`.
- Do not add interactive prompts or TTY detection — the server communicates
  only via MCP stdio transport.
- The server uses a single stdio transport (`StdioServerTransport`). Do not
  add HTTP or SSE transports without a flag to select between them.

## Gotchas

- Dev mode (`just dev`) requires Node 22+ for `--experimental-strip-types`.
  The build (`just build`) works on any Node that supports ES2022.
- `isCommandAvailable` in spawn-agent.ts uses the `which` v4 npm package.
  It does not exec the target — it only verifies PATH resolution.
- Listener order in `process-session.ts` is intentional: the raw-byte
  output buffer subscribes to `proc.stdout` *before* `readline` is created,
  so `waitNext` callers see the full chunk that contains a `[QUESTION]`
  line in their captured output (not just the lines preceding it).
