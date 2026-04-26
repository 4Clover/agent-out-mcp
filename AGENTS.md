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

- **index.ts** — MCP server entry point. Registers seven tools (spawn_agent,
  spawn_agents, reply, wait_agent, kill_agent, list_agents, get_status) on a
  stdio transport using `@modelcontextprotocol/sdk`.
- **agents.ts** — `AgentConfig` type and `DEFAULT_AGENTS` map (claude, codex,
  gemini, aider). Each config specifies the CLI command, static args, and
  whether the prompt uses a flag (`promptFlag`) or positional arg, plus a
  `flagMap` of known logical options (`model`, `thinking`) to per-CLI flag
  names, plus an optional `env` setting.
- **schemas.ts** — Zod schemas for tool inputs, agent config, user config,
  and the `SpawnOptions` type. Cross-platform absolute-path validation lives
  here. Update schemas here, not in index.ts or spawn-agent.ts.
- **process-session.ts** — Lifecycle owner for a child process. Single
  readline-based stdout/stderr listener, byte-capped output buffer
  (default 8 MB, drop-oldest), discriminated-union state machine with
  terminal-state guarantee (`done`/`error`/`killed` cannot be downgraded),
  and a FIFO waiter queue that powers `waitNext`. Other modules go through
  this; nothing else touches `ChildProcess` listeners directly.
- **spawn-agent.ts** — Loads user overrides from `~/.agent-link/config.json`
  (or `AGENT_LINK_CONFIG` env var), Zod-validates them, normalizes keys to
  lowercase, builds the prompt and args (applying per-agent `flagMap`),
  resolves the env (allowlist or passthrough), and creates a
  `ProcessSession`. Surfaces config load errors to stderr.
- **session-store.ts** — In-memory `Map<string, ProcessSession>` keyed by
  `agentId`. Subscribes to each session's `'close'` event to schedule a
  5-minute eviction timer (unref'd) for terminal sessions. `deleteSession`
  cancels the pending timer.

## Bidirectional Protocol

When a subprocess prints a complete line starting with `[QUESTION] <text>`
to stdout, the session transitions to `waiting_for_reply` and the host call
resolves with `{ status: "waiting_for_reply", question }`. The subprocess
stays alive. The host calls `reply(agentId, message)` which writes to stdin
and waits for the next event:

- Next `[QUESTION]` → `{ status: "waiting_for_reply", question, partial }`.
- Process close → `{ status: "done"|"error"|"killed", result, error? }`.
- 30-second silence → `{ status: "running", partial }`. The session state
  stays `running` (it does **not** revert to `waiting_for_reply`); the host
  should call `wait_agent(agentId, timeoutMs?)` to await the next event
  without writing duplicate input.

The marker is parsed line-by-line via `readline` with `crlfDelay: Infinity`,
so cross-chunk `[QUESTI` / `ON] foo\n` markers are detected. CRLF endings
are tolerated. Mid-line `[QUESTION]` substrings do **not** trigger.

The overall spawn timeout (default 1 hour, configurable via `timeoutMs`)
survives the first question event — a runaway child still terminates at
the deadline. After a timeout-triggered termination, a late `'close 0'` is
**not** treated as `done` — the terminal-state guarantee keeps it `error`.

## Custom Agents

Users add agents in `~/.agent-link/config.json` under an `agents` key. The
config shape matches `agentConfigSchema` from `schemas.ts`:

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

- The config is Zod-validated. A typo (e.g. `flagMap: { modle: "..." }`)
  surfaces as a stderr warning naming the offending key path.
- `flagMap` keys are restricted to known logical options (`model`,
  `thinking`).
- `env` defaults to a small allowlist
  (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `SHELL`); `PATH` is
  always present even when `env: []`. Set `env: "passthrough"` to inherit
  the full parent process env, or supply a string array to extend the
  allowlist with named variables.
- Keys are lowercased at load time. A user-config entry whose lowercased
  key matches a built-in default (e.g. `"Claude"` vs built-in `claude`)
  **overrides** the default; the original casing is not independently
  reachable.

Override the config path with the `AGENT_LINK_CONFIG` environment variable.

## Conventions

- ESM throughout (`"type": "module"` in package.json, Node16 module resolution).
- All imports use `.js` extensions (required for ESM + tsc).
- `strict: true` in tsconfig.
- `cwd` in `spawn_agent` must be an absolute path on either POSIX or Windows;
  cross-platform validation lives in `schemas.ts`.
- Session IDs are 16 hex characters of cryptographic randomness, prefixed
  with the lowercased agent name (e.g. `claude-1a2b3c4d5e6f7890`).
- Output is byte-capped at 8 MB per session and reported via
  `outputBytes` / `outputChunks` / `truncated` on `get_status`.

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
