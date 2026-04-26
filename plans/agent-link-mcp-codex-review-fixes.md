# Plan: agent-link-mcp Codex Review Fixes

**Objective.** Resolve all HIGH/MEDIUM/LOW findings from the 2026-04-26 Codex
(gpt-5.5, xhigh) review of `agent-link-mcp`, including the items the prior
`docs/fix-plan.md` got wrong (H2, M5, M6) and items it did not cover at all
(line-based `[QUESTION]` parser, byte-based output cap, terminal-state
guarantees, env sandboxing, batch limits, session-ID entropy, ID TTL,
`outputLines` mislabel, case-insensitive config keys).

The architectural spine of this plan is the Codex recommendation:

> Extract an `AgentRunner` / `ProcessSession` module that owns stdout/stderr
> listeners, question parsing, output buffering, waiters, timeouts, and kill
> behavior. `index.ts` and `spawn-agent.ts` become thin callers.

That single extraction structurally fixes the duplicate-listener bug (H2),
the timeout-overwrites-error bug (H3), the kill-status-before-exit bug (M5),
the reply-restores-waiting bug (M6), and the [QUESTION] cross-chunk bug. The
remaining findings hang off it as small, independent steps.

---

## Source-Backed Design Decisions

These choices come out of docs-lookup (Node 22 docs, MCP TS SDK, Zod v3,
vitest 4) and Exa research. Future steps reference them by ID.

| ID  | Decision | Source |
|-----|----------|--------|
| D1  | Use `readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })` for stdout. Single source listener; fan out via `'line'` events. Replaces both the chunk-substring `[QUESTION]` check and the `setMaxListeners(0)` workaround. | Node v22 child_process / readline docs |
| D2  | Resolve final result on `'close'`, not `'exit'`. `'close'` fires after stdio is fully flushed. | Node v22 child_process docs |
| D3  | Cancellation via `AbortController` passed as `spawn(..., { signal })`. Treat the resulting `'error'` with `code === 'ERR_CHILD_PROCESS_KILLED'` as expected. | Node v22 docs |
| D4  | Cross-platform command lookup via the `which` v4 npm package (pure ESM, async, handles Windows `PATHEXT`). Drop `execFileSync('which', …)`. | `which` v4 README |
| D5  | Cross-platform absolute-path validation in Zod via `z.string().refine(p => path.posix.isAbsolute(p) \|\| path.win32.isAbsolute(p), { message, path })`. `path.isAbsolute` alone is platform-dependent (returns `false` for `C:\\…` and `\\\\srv\\…` on Linux), so the test "accepts Windows absolute cwd" cannot pass on Linux CI without explicit posix+win32 acceptance. Drop `/^\//`. | Zod docs §refine; Node v22 path docs |
| D6  | MCP tool input schemas: the `@modelcontextprotocol/sdk` ^1.11 `McpServer.tool(name, desc, paramsSchema, handler)` overload takes a `ZodRawShape` — the `.shape` of a `ZodObject`, **not** a `ZodObject` itself. Keep the existing pattern in `src/index.ts:32` and `src/schemas.ts:28` (`spawnAgentSchema = spawnOptionsSchema.shape`). For the new `wait_agent` tool, pass an inline `ZodRawShape` (e.g. `{ agentId: z.string(), timeoutMs: z.number()… }`), not `z.object({...})`. Tool-level errors return `{ isError: true, content: [...] }`; throw only on protocol-level failures. | MCP TS SDK 1.11 source; existing repo usage |
| D7  | Terminal-state invariants via discriminated union with explicit `isTerminal(state)` guard. Once `error`, `killed`, or `done`, no later event downgrades it. Use `assertNever` in transition function. | XState docs / TS state-machine pattern |
| D8  | Byte-based output cap. Track `bytesConsumed += Buffer.byteLength(chunk)` against an 8 MB budget; drop oldest chunks; surface `truncated: true` and `bytesDropped` in `get_status`. Mirrors Node core `maxBuffer` semantics. | Node docs §maxBuffer |
| D9  | Session IDs: 16 hex chars (64 bits) — collision probability ~10⁻¹² at 10k concurrent sessions. Replace 6-hex slice. | OWASP / nanoid collision calculator |
| D10 | Env passthrough: allowlist by default (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `SHELL`, plus a per-agent extras allowlist). User can opt into full passthrough via `env: "passthrough"` option on the agent config. | Exa research; MCP production guide |
| D11 | Reply timeout: keep session in `running` state (NOT `waiting_for_reply`); add a new `wait_agent` tool to await the next `[QUESTION]` or close without writing. Restoring `waiting_for_reply` after stdin write would let the caller send duplicate input. | Codex review M6 |
| D12 | Kill semantics: introduce `killing` transient state; record whether `kill()` actually signaled (return value). Final state becomes `killed` only after `'close'`. | Node child_process docs |
| D13 | vitest mocks of `node:child_process.spawn` must use the `node:` prefix in `vi.mock()` for ESM projects (`"type": "module"`). | vitest 4 docs |

---

## Step Map (Codex finding → step)

| Finding | Severity | Step |
|---|---|---|
| `[QUESTION]` parser is chunk-substring, misses cross-chunk markers | HIGH | 2 |
| Reply duplicates output via second stdout listener | HIGH | 2, 4 |
| Reply mutates state before validating streams | HIGH | 4 |
| Overall timeout cleared when first question seen | MEDIUM | 2 |
| Timeout status overwritten by `'close'` | MEDIUM | 2 |
| `spawn_agents` has no batch limit | MEDIUM | 6 |
| Session IDs only 24 bits of entropy | MEDIUM | 3 |
| Done/error sessions linger forever | MEDIUM | 6 |
| Full `process.env` forwarded to subprocess | MEDIUM | 6 |
| Custom agent names not truly case-insensitive | LOW | 5 |
| `outputLines` is actually chunk count | LOW | 6 |
| H1 prior fix used Unix-only `/^\//` regex | HIGH | 1 |
| H2 prior fix used `setMaxListeners(0)` | HIGH | 2 |
| H3 prior fix did not gate `'close'` behind `timedOut` flag | HIGH | 2 |
| M3 stdout null guard placement | MEDIUM | 4 |
| M4 `supportedFlags` too crude | MEDIUM | 1 |
| M5 `killed: true` set before exit | MEDIUM | 4 |
| M6 reply restoring `waiting_for_reply` | MEDIUM | 4 |
| L1 `which` POSIX-only | LOW | 5 |
| L2 fake `agentId: ""` placeholder | LOW | 4 |
| L3 line-based output cap on arbitrary chunks | LOW | 2 |
| L4 `waitingAgents` array missing from `spawn_agents` response | LOW | 6 |

Test gaps from the review (cross-chunk marker, exact-output assertions,
byte-based cap, kill returning false, closed stdin/stdout, batch limits,
config key normalization, empty command) are folded into the steps that own
the corresponding code.

---

## Dependency Graph

```
        Step 1 ── Schemas + AgentConfig
            │
            ├─────── Step 2 ── ProcessSession (Opus tier)
            │            │
            │            ├──── Step 3 ── spawn-agent.ts rewrite
            │            │
            │            └──── Step 4 ── reply / kill / wait_agent tools
            │
            └─────── Step 5 ── which package + name normalization (parallel with 2)
                                 │
                                 ▼
                              Step 6 ── Polish: env sandbox, TTL, batch, output reporting
                                 │
                                 ▼
                              Step 7 ── Documentation
```

**Parallelism:**
- Step 5 may run in parallel with Step 2 (different files: `agents.ts`,
  `spawn-agent.ts::isCommandAvailable`, `package.json`).
- Steps 3 and 4 can run in parallel after Step 2 (different files), but they
  must share a clean `ProcessSession` API. Sequence them serially if a single
  agent owns the work; parallelize across two agents if two are available.
- Step 6 must wait for both 3 and 4.

**Model tier:**
- Step 2 (architecture-defining extraction): **Opus / strongest available.**
- All other steps: default tier.

---

## Conventions (apply to every step)

- **Branch:** one branch per step, named `fix/codex-stepN-<slug>`, off `prod`.
- **TDD:** RED test → confirm fail → GREEN implementation → confirm pass →
  optional REFACTOR. Commit at each transition (`test:`, `fix:` or `feat:`,
  `refactor:`). Hooks/signing follow project defaults.
- **Verification per step:** `just check && just test`. Step exit criteria
  always include "all prior tests still pass".
- **PR shape:** one PR per step against `prod`. Title mirrors the step
  name. Description references this plan and lists the Codex findings the
  step closes.
- **Rollback:** every step is independently revertible — no production-data
  migrations, no irreversible config changes. The plan never deletes a tool
  or breaks the wire-format of an existing tool result before adding the
  replacement.
- **No backward-compat shims** beyond what the Codex review already implies:
  `outputLines` is renamed to `outputChunks` (additive — `outputLines` is
  removed in the same step that adds `outputChunks`; consumers see one
  rename, not a soft-deprecation period). This matches the project's
  "no half-finished implementations" rule from CLAUDE.md.
- **MCP wire compatibility:** new tools (`wait_agent`) are additive. Renamed
  fields (`outputLines` → `outputChunks`) are documented in the PR body so a
  downstream MCP host operator sees the change.

---

## Step 1 — Schema + AgentConfig hardening

**Closes:** H1 (cross-platform), M2 (Zod-validated user config), M4 (per-agent
flag map), partial M1 (config error surfacing belongs to Step 6 polish).

### Cold-start context brief

`agent-link-mcp` is an MCP server that spawns CLI subagents (claude, codex,
gemini, aider). Today, `src/schemas.ts` defines the tool-input Zod schema for
`spawn_agent`, and `src/agents.ts` defines `AgentConfig` with a flat
`{ command, args, promptFlag }` shape. User overrides land in
`~/.agent-link/config.json` (or path from `AGENT_LINK_CONFIG`) and are
shallow-merged with `DEFAULT_AGENTS`.

Codex flagged three schema-level issues:

1. `cwd` must be validated as an absolute path on **both** POSIX and Windows.
   The prior `docs/fix-plan.md` proposed `/^\//`, which is Unix-only.
2. `~/.agent-link/config.json` is not Zod-validated. A typo silently disables
   the agent.
3. `--model` and `--thinking` are blasted at every agent. Aider/codex/gemini
   error on unrecognized flags. The prior fix plan added a flat
   `supportedFlags: string[]`, which Codex called "too crude" — different
   agents may use different flag names for the same logical option.

This step lays the schema foundations every later step builds on. **No
runtime behavior changes here** — `spawn-agent.ts` still consumes whatever
the schemas produce.

### Tasks (TDD order)

1. **RED — Zod tests in `src/__tests__/schemas.test.ts`** (new file):
   - Accepts POSIX absolute `cwd: "/tmp/x"`.
   - Accepts Windows absolute `cwd: "C:\\tmp\\x"` and UNC `cwd: "\\\\srv\\sh"`.
   - Rejects relative `cwd: "../escape"` with a path-marked Zod issue.
   - `agentConfigSchema` accepts `{ command: "x" }` and defaults `args` to
     `[]`, `promptFlag` to `null`, `flagMap` to `{}`.
   - `agentConfigSchema` rejects empty `command: ""`.
   - `userConfigSchema` accepts `{ agents: { mytool: { command: "x" } } }`
     and rejects malformed entries with a path that includes the offending
     key.
   - `spawnAgentsBatchSchema` (`z.array(spawnInput).min(1).max(10)`) rejects
     0-element and 11-element arrays.
   - `flagMap` round-trip: each known logical option (`model`, `thinking`)
     maps to a per-agent string or is omitted.
2. Run `just test` → confirm RED. Commit
   `test: schema reproducers for cwd, agentConfig, batch limit, flag map`.
3. **GREEN — implement in `src/schemas.ts`**:
   - Import `path` from `node:path`. Add a reusable
     ```ts
     const absolutePath = z.string().refine(
       (v) => path.posix.isAbsolute(v) || path.win32.isAbsolute(v),
       { message: "cwd must be an absolute path", path: ["cwd"] }
     );
     ```
     and use it for the `cwd` field. (D5) **Do not use `path.isAbsolute`
     directly** — it dispatches to the platform-specific implementation, so
     Linux CI rejects valid Windows paths and vice versa.
   - Export `agentConfigSchema = z.object({ command: z.string().min(1),
     args: z.array(z.string()).default([]),
     promptFlag: z.string().nullable().default(null),
     flagMap: z.object({
       model: z.string().optional(),
       thinking: z.string().optional(),
     }).default({}),
     env: z.union([z.literal("passthrough"),
       z.array(z.string())]).optional() })`.
     `flagMap` keys are restricted to the known logical options (`model`,
     `thinking`) so a user config typo (`flagMap: { modle: "--model" }`)
     surfaces as a Zod error instead of silently doing nothing.
     `env` is consumed in Step 6 — defining its shape here keeps the schema
     stable across the refactor.
   - Export `userConfigSchema = z.object({
     agents: z.record(z.string(), agentConfigSchema).optional() })`.
   - Export `spawnAgentsBatchSchema = z.array(spawnOptionsSchema).min(1).max(10)`.
   - Re-export inferred types `AgentConfigSchema`, `UserConfig`,
     `SpawnAgentsBatchInput`.
4. **GREEN — update `src/agents.ts`**:
   - Replace `AgentConfig` interface with `AgentConfigSchema` from
     `schemas.ts`.
   - In `DEFAULT_AGENTS`, populate `flagMap` only for `claude`:
     `flagMap: { model: "--model", thinking: "--thinking" }`. Other agents
     get the default empty `flagMap`.
   - Drop the prior plan's `supportedFlags` field entirely. (M4 — Codex was
     right that a name-aware mapping is cleaner than a flag-name allowlist.)
5. Run `just test` → confirm GREEN. Commit
   `feat: cross-platform cwd validation, Zod user config, per-agent flag map`.
6. **REFACTOR (optional)** — if `path.isAbsolute` is referenced in tests
   directly, extract a small helper. Skip if unused outside the schema.

### Verification

```bash
just check && just test
```

Schema tests must cover all six bullet points above. No production code in
`spawn-agent.ts` or `index.ts` is touched in this step.

### Exit criteria

- `agentConfigSchema`, `userConfigSchema`, `spawnAgentsBatchSchema`,
  `absolutePath` all exported from `src/schemas.ts`.
- `DEFAULT_AGENTS` updated to use `flagMap` only on the claude entry.
- `just ci` (typecheck + tests) passes.
- No runtime behavior change yet — `spawn-agent.ts` still has its
  `loadUserConfig`/`buildArgs` from `prod`.

### Rollback

`git revert` the single commit. No filesystem or external-system state.

---

## Step 2 — Extract `ProcessSession` (Opus tier)

**Closes:** H2 (single listener), H3 (terminal-state guarantee), HIGH
[QUESTION] cross-chunk parser bug, MEDIUM "timeout cleared" bug, L3 (byte
output cap), groundwork for Steps 3 and 4.

### Cold-start context brief

This is the architectural extraction. We are creating a new module
`src/process-session.ts` that owns **everything** about a child process:
spawn, stdout/stderr listening, line parsing, [QUESTION] detection, output
buffering, waiter dispatch, timeouts, and kill semantics. After this step,
no code outside `process-session.ts` calls `proc.stdout.on('data', …)`,
`setTimeout(...)` for process timeouts, or `proc.kill(...)` directly.

The current code path (in `prod`):

- `spawn-agent.ts::runProcess` registers `stdout.on('data', ...)`,
  substring-checks the chunk for `[QUESTION]`, pushes raw chunks into
  `session.output`, and clears the overall timeout the moment any question
  is seen — leaving a runaway child possible.
- `index.ts::reply` registers a *second* `stdout.on('data', ...)` for the
  duration of the reply call. Per the Codex review, both listeners stay
  active during a reply, so output gets pushed into `session.output` twice
  and any new `[QUESTION]` marker can race between them.
- The `'close'` handler in `runProcess` unconditionally sets
  `session.status = code === 0 ? "done" : "error"`, overwriting a prior
  `error` status set by the timeout branch — the Codex M5/M6/H3 cluster.

The extraction replaces all of that with one parser, one buffer, one
state-machine.

### `ProcessSession` API contract

The module exports:

```ts
// process-session.ts
export type SessionState =
  | { kind: "running" }
  | { kind: "waiting_for_reply"; question: string }
  | { kind: "killing"; reason: "user" | "timeout" }
  | { kind: "done"; exitCode: number; result: string }
  | { kind: "error"; error: string; result: string }
  | { kind: "killed"; signal: NodeJS.Signals | null; result: string };

export const TERMINAL_KINDS = new Set<SessionState["kind"]>([
  "done", "error", "killed",
]);

export interface ProcessSessionEvents {
  question: (text: string) => void;
  close: (final: SessionState) => void;
  output: (chunk: string, source: "stdout" | "stderr") => void;
}

export interface ProcessSession {
  readonly agentId: string;
  readonly agent: string;
  readonly task: string;
  readonly startedAt: Date;
  readonly state: SessionState;
  readonly outputBytes: number;        // total bytes seen, pre-cap
  readonly outputChunks: number;       // chunk count, pre-cap
  readonly truncated: boolean;
  /** Snapshot of the (possibly capped) output buffer. */
  collectOutput(): string;
  /**
   * Write bytes to stdin. Ordering:
   *   1. If `state.kind !== "waiting_for_reply"`, returns false; no
   *      mutation. Caller surfaces "not waiting".
   *   2. Synchronously transitions state to `{ kind: "running" }` and
   *      records a new "since" boundary for the next waiter.
   *   3. Calls `proc.stdin.write(input)`. If the underlying write throws
   *      (stream destroyed/ended after the kind check) the state
   *      transition is rolled back to the captured prior state and the
   *      method returns false.
   *   4. Returns true on success. Backpressure (`stdin.write` returning
   *      false) is handled internally — the method does not block on
   *      drain; bytes are buffered by Node.
   */
  write(input: string): boolean;
  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof ProcessSessionEvents>(
    event: K, listener: ProcessSessionEvents[K]
  ): () => void;
  /**
   * Resolves on next `'question'` or `'close'` event, whichever comes
   * first. Fast paths:
   *   - If state is already terminal, resolves immediately with
   *     { kind: "close", state }.
   *   - If state is already `waiting_for_reply`, resolves immediately with
   *     { kind: "question", question: state.question, output } using the
   *     output captured since the last `waitNext`/`write` boundary. This
   *     prevents `wait_agent` from blocking against an already-paused
   *     session.
   * Waiters are FIFO. A second concurrent `waitNext` call queues behind
   * the first and only sees output produced after its own registration.
   */
  waitNext(opts?: { timeoutMs?: number }): Promise<
    | { kind: "question"; question: string; output: string }
    | { kind: "close"; state: SessionState }
    | { kind: "timeout"; output: string }
  >;
  /**
   * Request termination. Returns whether the kill signal was actually
   * delivered. State transitions:
   *   - If state was already terminal: no transition; returns false.
   *   - If `proc.kill(signal)` returns true: state →
   *     `{ kind: "killing", reason: "user" }`; final `killed` state
   *     lands when `'close'` fires.
   *   - If `proc.kill(signal)` returns false (process gone before signal
   *     could be delivered): synchronously finalize state to
   *     `{ kind: "killed", signal: null, result: collectOutput() }` so
   *     waiters resolve. Returns false.
   */
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CreateProcessSessionOptions {
  agentId: string;
  agent: string;
  task: string;
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;     // pre-resolved by caller (see Step 6)
  timeoutMs: number;
  maxOutputBytes?: number;    // default 8 MB
  /** Optional injection seam for tests. Defaults to spawn from
   *  `node:child_process`. */
  spawnImpl?: typeof import("node:child_process").spawn;
}

export function createProcessSession(
  opts: CreateProcessSessionOptions
): ProcessSession;
```

### Required internal behaviors

- **Single stdout listener via `readline`** (D1):
  ```ts
  const rl = readline.createInterface({
    input: proc.stdout!, crlfDelay: Infinity,
  });
  rl.on("line", handleLine);
  ```
  All `[QUESTION]` detection runs on **complete lines**: regex
  `/^\[QUESTION\] (.+)$/`. No more substring checks on raw chunks. (HIGH
  cross-chunk bug.)
- **Single stderr listener** uses the same line interface or a separate
  `readline` over stderr; both feed the same byte-counted buffer with a
  `[stderr] ` prefix tag.
- **Byte-based output cap** (D8, L3): track `outputBytes` and a chunk array.
  When `outputBytes - droppedBytes > maxOutputBytes`, shift the oldest
  chunks until under budget, set `truncated = true`. `collectOutput()`
  joins the live chunks. Surface `truncated`, `bytesDropped`,
  `outputBytes`, `outputChunks` on the session.
- **Terminal-state guarantee** (D7, H3): every transition runs through
  `setState(next)`, which refuses to overwrite a state whose `kind` is in
  `TERMINAL_KINDS`. The internal timeout handler sets
  `{ kind: "killing", reason: "timeout" }` then calls `proc.kill("SIGTERM")`;
  the `'close'` handler computes the final `error` state with the timeout
  reason — `'close 0'` after a timeout-triggered kill **does not** become
  `done`. Use `assertNever` in the transition switch to catch missed
  variants at compile time.
- **`'close'` not `'exit'`** (D2): only the `'close'` handler resolves
  pending waiters with a final state.
- **AbortController-based deadline** (D3): construct one per session, pass
  to `spawn` via `{ signal }`; the timeout handler calls `ac.abort()`. This
  centralizes cancellation and produces a deterministic
  `'error' { code: 'ERR_CHILD_PROCESS_KILLED' }` followed by `'close'`.
  **Cancellation path is signal-only** — do not also call `proc.kill()`
  from the timeout handler; the abort signal handles SIGTERM. The
  `'error'` handler must distinguish:
  - `err.code === 'ERR_CHILD_PROCESS_KILLED'` and we initiated the abort
    (state is already `killing`) → swallow; the subsequent `'close'`
    finalizes to `killed` or `error` per the recorded reason.
  - Any other `err` (e.g. `ENOENT` on spawn) → finalize to
    `{ kind: "error", error: err.message }` immediately; treat as terminal.
  User-initiated `kill()` (Step 4) calls `proc.kill(signal)` directly and
  does **not** abort the controller, so the two paths stay disjoint.
- **`waitNext` semantics**: each call adds itself to a single waiter queue.
  `'question'` resolves the head of the queue with the question and the
  output captured between this call's start index and now. `'close'`
  resolves all pending waiters with the final state. Per-waiter
  `outputStart` indices avoid the double-output bug in `reply`.
- **No `setMaxListeners(0)`**: the EventEmitter we expose is internal and
  we control listener count. (H2 done correctly.)

### Tasks (TDD order)

1. **RED — `src/__tests__/process-session.test.ts`** (new). Use a
   stub `spawnImpl` that returns a fake `ChildProcess` (an `EventEmitter`
   with `stdout`, `stderr` PassThrough streams and a `stdin` Writable).
   Cover:
   - Spawns with the supplied command, args, cwd, env (env exact, not
     `process.env`).
   - Single complete-line `[QUESTION] foo` triggers `'question'` event with
     `"foo"` and transitions state to `waiting_for_reply`.
   - `[QUESTION]` split across two chunks (`"[QUESTI"` then `"ON] foo\n"`)
     still triggers exactly one `'question'` event with `"foo"`.
   - `[QUESTION]` appearing mid-line (e.g., `"prefix [QUESTION] inline\n"`)
     does **not** trigger — the marker must be at line start.
   - CRLF: `"[QUESTION] foo\r\n"` triggers `"foo"` (no CR in question).
   - Question → write → question round-trip: a `[QUESTION] a\n` triggers
     a `'question'` event; a synchronous `write("answer\n")` transitions
     state back to `running`; a subsequent `[QUESTION] b\n` triggers a
     second `'question'` event. Two `waitNext` callers (one before the
     write, one after) each receive their own question in FIFO order
     without duplicated output.
   - **Fast path**: calling `waitNext` while state is already
     `waiting_for_reply` resolves immediately with the cached question
     and output captured since the last boundary.
   - **Write rollback**: `write()` against a process whose stdin throws
     does not leak the `running` state — the prior `waiting_for_reply`
     is restored and `write` returns false.
   - **Kill of an already-exited process** (proc.kill returns false):
     synchronously finalizes to `killed` with `signal: null`; no
     subsequent `'close'` is required to unblock waiters.
   - `waitNext` resolves with the **output captured during that call only**
     — assert exact string, not `toContain`. Two concurrent `waitNext`
     callers do not see duplicated output.
   - Byte cap: pushing 9 MB worth of chunks at `maxOutputBytes: 8 MB` sets
     `truncated: true`, `outputBytes` reflects total seen, `collectOutput()`
     length ≤ 8 MB.
   - Timeout: a session with `timeoutMs: 100` and no output transitions to
     `error` with `error: /timed out/`. After timeout, simulate a late
     `'close'` with code 0; final state stays `error`, **not** `done`.
   - Kill while running: `kill("SIGTERM")` returns `true`, transitions to
     `killing`, then `'close'` (with `signal: "SIGTERM"`) finalizes to
     `killed`. Final state is `killed`, not `done`.
   - Kill after exit: simulate `'close 0'` first; subsequent `kill()`
     returns `false` and does not change the terminal state.
   - `write(input)` returns `false` once stdin is `.end()`-ed.
   - `waitNext({ timeoutMs: 50 })` resolves to `{ kind: "timeout", output }`
     while leaving session state unchanged at `running` /
     `waiting_for_reply`.
2. Confirm RED. Commit
   `test: ProcessSession spec — line parser, byte cap, terminal states, kill`.
3. **GREEN — implement `src/process-session.ts`** per the API contract and
   internal-behavior bullets above. Internal helpers may include a
   `OutputBuffer` class (push, drop-oldest, snapshot) — keep it private to
   the module.
4. Run `just test` → confirm GREEN. Commit
   `feat: ProcessSession owns lifecycle, line-based parser, byte cap`.
5. **REFACTOR** — extract `OutputBuffer` and the state-transition function
   into helpers if the file approaches the project's 800-line ceiling.

### Verification

```bash
just check && just test
just test-file process-session
```

The new tests must pass without modifying `spawn-agent.ts`, `index.ts`,
or `session-store.ts` — `ProcessSession` is consumed in Step 3.

### Exit criteria

- `src/process-session.ts` exports the listed API.
- All ProcessSession tests pass.
- All prior tests still pass (none should reference `ProcessSession` yet).
- `just check` clean.

### Rollback

Delete the new file and tests; no other code is wired to it yet.

### Size risk — pre-authorized split

Step 2 may exceed ~500 LOC net. If during execution the implementer judges
the diff too large for one PR, split per the Mutation Protocol:

- **Step 2a:** state types (`SessionState`, `TERMINAL_KINDS`, `assertNever`),
  `OutputBuffer` helper, and their unit tests. No spawn integration.
- **Step 2b:** `createProcessSession` integration (readline, AbortController,
  spawn, waiter queue, kill semantics) + remaining tests.

This split is pre-authorized — proceed without further plan-level approval,
but log the split in the Mutation Log section.

---

## Step 3 — Rewire `spawn-agent.ts` and `session-store.ts` onto `ProcessSession`

**Closes:** the spawn side of H2/H3/M5/M6 by routing all spawning through
`ProcessSession`. Bumps session ID entropy (D9, MEDIUM finding).

### Cold-start context brief

Step 2 has produced `ProcessSession`. Now we replace `runProcess` in
`spawn-agent.ts` with a thin wrapper that:

1. Resolves `AgentConfig` from defaults + user config (existing logic
   stays).
2. Builds the prompt and args (existing logic, plus the per-agent
   `flagMap` from Step 1: `if (cfg.flagMap.model && opts.model) args.push(cfg.flagMap.model, opts.model)`).
3. Generates a 16-hex session ID via `randomBytes(8).toString("hex")` (D9).
4. Creates a `ProcessSession`, stores it in the session store, and awaits
   the first `waitNext()` call. Translates the result back to the existing
   `SpawnResult` shape (`{ status: "done" | "waiting_for_reply" | "error", … }`).

`session-store.ts` changes:

- The `AgentSession` interface becomes a thin record `{ session:
  ProcessSession }` plus the few orchestration fields not owned by
  ProcessSession (currently none — `agentId`, `agent`, `task`, `startedAt`,
  `status`, `output`, `pendingQuestion`, `process` are all reachable via
  `ProcessSession`).
- The store becomes a `Map<string, ProcessSession>`.
- Drop `setMaxListeners(0)` — there is no listener pile-up to mitigate (D1).
- TTL/cleanup is deferred to Step 6.

### Tasks (TDD order)

1. **RED** — update `src/__tests__/server.test.ts` and
   `src/__tests__/spawn-agent.test.ts` to reflect new behavior:
   - Existing tests that referenced `session.process.kill` or
     `session.output.push(...)` directly are updated to go through the
     ProcessSession surface (`session.kill(...)`, `session.collectOutput()`).
   - New: `agentId` from `spawnAgent` matches
     `/^[a-z0-9-]+-[0-9a-f]{16}$/`. The agent-name prefix is lowercased
     before composing the ID so an input like `agent: "Claude"` still
     produces `claude-…` (matching the case-insensitive lookup added in
     Step 5).
   - New: `[QUESTION]` cross-chunk integration test through the full
     `spawn_agent` server tool path.
   - New: timeout integration — server-level test that confirms after a
     timeout, `get_status` shows `state.kind === "error"` and a subsequent
     `'close 0'` does **not** flip it to `done`.
   - **Note:** the exact-output replacement of the reply round-trip test
     is owned by Step 4 (which rewrites `reply`). In Step 3, the existing
     reply test stays as-is — Step 3 only rewires the spawn side, so
     touching reply tests here would cross step boundaries. If Step 3 is
     executed before Step 4, expect the reply round-trip test to need a
     trivial adjustment for the new ProcessSession-backed `kill` /
     `output` accessors but its assertion shape is unchanged.
2. Confirm RED. Commit
   `test: server tests assert ProcessSession behavior end-to-end`.
3. **GREEN** —
   - Rewrite `src/spawn-agent.ts::runProcess` to use `createProcessSession`.
     Replace `randomUUID().slice(0, 6)` with
     `randomBytes(8).toString("hex")` (D9). Lowercase `opts.agent` for the
     ID prefix: `${opts.agent.toLowerCase()}-${randomBytes(8).toString("hex")}`.
   - Apply `flagMap` in `buildArgs`:
     ```ts
     if (opts.model && cfg.flagMap.model)
       args.push(cfg.flagMap.model, opts.model);
     if (opts.thinking && cfg.flagMap.thinking)
       args.push(cfg.flagMap.thinking, opts.thinking);
     ```
   - Pass `env: process.env` for now (Step 6 narrows this).
   - Rewrite `src/session-store.ts` to store `ProcessSession` instances.
     Update `getSession`, `listSessions`, `deleteSession`. Add
     `appendOutput` only if Step 6 needs it (otherwise drop — output is
     owned by ProcessSession).
4. Run `just test` → confirm GREEN. Commit
   `refactor: route spawn through ProcessSession; bump session ID entropy`.
5. **REFACTOR** — `runProcess` is now ~30 lines; consider inlining it into
   `spawnAgent` if cleaner. Verify `just check` still clean.

### Verification

```bash
just ci
```

All existing server-tool tests must pass. Round-trip reply test should now
assert exact output (no duplicates).

### Exit criteria

- `spawn-agent.ts` does not import `child_process.spawn` directly (only
  `process-session.ts` does).
- `session-store.ts` stores `ProcessSession` instances; no direct
  `ChildProcess` references.
- `agentId` matches the new 16-hex format.
- `just ci` passes.

### Rollback

Revert this commit. Step 2's `ProcessSession` module remains unused but
harmless.

---

## Step 4 — Rewrite `reply` and `kill_agent`; add `wait_agent`

**Closes:** H2 reply-side, M3 (stream null guard placement), M5 (kill state
ordering), M6 (reply timeout state), L2 (`agentId: ""` placeholder).

### Cold-start context brief

After Step 3, every session is owned by a `ProcessSession`. The `reply` and
`kill_agent` MCP tools currently reach into `session.process` directly and
register their own listeners — this is exactly the duplicate-listener
foot-gun the Codex review flagged.

We rewrite both tools to delegate to `ProcessSession`. We also add a new
`wait_agent` tool, which is the Codex-recommended fix for M6: today's
`reply` returns `{ status: "running" }` after a 30-second silence, leaving
no MCP-callable way to wait for the next event without writing duplicate
input.

### Behavior contracts

**`reply(agentId, message)`:**
1. Look up `ProcessSession` from the store. If missing, return
   `{ isError: true, content: [{ type:"text", text: JSON.stringify({
   agentId: null, error: "No session..." }) }] }` (L2 — use `null`, not
   the literal string `"unknown"` or `""`).
2. If `state.kind !== "waiting_for_reply"`, return error result with the
   current `kind`.
3. Validate streams **before** any state mutation (M3): if
   `session.write(message + "\n")` returns `false`, return error with
   `agentId` and "stdin not writable" — session state stays as-is.
4. After a successful write, the session transitions to `running` (handled
   inside `ProcessSession.write`, which sets state to `running` and clears
   `question` only after stdin succeeds).
5. Await `session.waitNext({ timeoutMs: 30_000 })`:
   - `kind: "question"` → return `{ status: "waiting_for_reply", question,
     partial: <output captured during this call> }`.
   - `kind: "close"` → return `{ status: state.kind, result, error? }`.
   - `kind: "timeout"` → return `{ status: "running", partial: <output> }`.
     **Do not** restore `waiting_for_reply` (M6, D11). Session state stays
     `running`. The MCP host should call `wait_agent` to await the next
     event without writing duplicate input.

**`kill_agent(agentId, signal?)`:**
1. Lookup; missing → error result.
2. Capture `wasTerminal = TERMINAL_KINDS.has(session.state.kind)`.
3. Call `signaled = session.kill(signal)`.
4. If `wasTerminal`, return `{ killed: false, reason: "already terminal",
   state: session.state.kind }`. (M5: do not lie about killing an already
   terminal process.)
5. Otherwise, await `session.waitNext()` and return
   `{ killed: signaled, signaled, finalState: session.state.kind, signal }`.

**`wait_agent(agentId, timeoutMs?)`** (new):
1. Lookup; missing → error result.
2. If `state.kind` is terminal, return `{ status: state.kind, result }`
   immediately.
3. Await `session.waitNext({ timeoutMs: timeoutMs ?? 30_000 })`. Translate
   `'question'` / `'close'` / `'timeout'` to the same shape `reply`
   produces.

### Tasks (TDD order)

1. **RED — `src/__tests__/server.test.ts` additions:**
   - Reply round-trip with **exact** output assertion (no `toContain`).
   - Reply against closed stdin: state stays `waiting_for_reply`, error
     surfaced (M3).
   - Reply against unknown `agentId`: response includes `agentId: null` and
     `isError: true` (L2).
   - Reply timeout: response is `{ status: "running", partial: ... }` and a
     follow-up `reply` to the same agent fails with "not waiting for reply"
     because state is `running` (M6 — duplicate input is impossible).
   - `wait_agent` resumes after a `reply` timeout and ultimately observes
     the next `[QUESTION]` or close.
   - `wait_agent` against terminal session returns immediately.
   - Kill of a still-running session: `killed: true`, `signaled: true`,
     final state `killed`.
   - Kill of an already-`done` session: `killed: false`, reason
     `"already terminal"`, state unchanged.
   - Kill of a process whose `kill()` returns `false` (PID gone before
     signal delivered): `killed: false, signaled: false`. Use the
     `spawnImpl` test seam to drive this.
2. Confirm RED. Commit
   `test: reply / kill / wait_agent contracts via ProcessSession`.
3. **GREEN —**
   - Replace the existing `reply` handler in `src/index.ts` with a thin
     translator over `session.write` + `session.waitNext`.
   - Replace `kill_agent` per the contract above.
   - Register a new `wait_agent` tool. Its `inputSchema` is a `ZodRawShape`
     literal: `{ agentId: z.string(), timeoutMs: z.number().int().min(1)
     .max(3_600_000).optional() }` (D6 — pass the shape, not
     `z.object(...)`, to match the SDK 1.11 `tool()` overload used
     elsewhere in `src/index.ts`). `min(1)` rejects polling-with-zero; if
     a caller wants "is it done now", they call `get_status` instead.
   - In the `spawnAgent` early-error path for unknown agent, return
     `agentId: null` instead of `""` (L2). Update `SpawnResult` to type
     `agentId: string | null`.
4. Run `just test` → confirm GREEN. Commit
   `feat: reply/kill rewritten on ProcessSession; add wait_agent tool`.
5. **REFACTOR** — extract a small `serializeState(state)` helper if all
   three handlers duplicate the same translation.

### Verification

```bash
just ci
```

### Exit criteria

- `index.ts` does not call `session.process.stdout.on(...)`,
  `session.process.stdin.write(...)`, or `session.process.kill(...)`
  directly.
- `wait_agent` tool registered and tested.
- All Codex test-gap items for reply/kill closed.

### Rollback

Revert this commit. The `wait_agent` tool disappears, `reply`/`kill_agent`
return to the Step-3 wiring.

---

## Step 5 — Cross-platform command lookup + agent name normalization + config error surfacing

**Closes:** L1 (POSIX-only `which`), LOW custom-name case-insensitivity, M1
(config load error surfacing).

### Cold-start context brief

`spawn-agent.ts::isCommandAvailable` shells out to `which` via
`execFileSync` — broken on Windows, also unnecessarily synchronous.
Decision D4 says use the `which` v4 npm package (pure ESM, async,
PATHEXT-aware).

`resolveAgentConfig` lowercases the user's input but **does not lowercase
the keys of the user config**. So a user who writes `"MyAgent": { … }` in
`~/.agent-link/config.json` and then calls `spawn_agent({ agent: "myagent" })`
gets `null`. Codex flagged this; the fix is to normalize keys at config
load time.

This step is independent of Steps 2–4 and can run in parallel with Step 2
provided two agents own the work (it touches `spawn-agent.ts`,
`agents.ts`, `package.json`).

### Tasks (TDD order)

1. **RED:**
   - `spawn-agent.test.ts`: `listAvailableAgents` calls `which` package
     (mock the module), not `execFileSync`. Returns the merged set when
     PATH lookup succeeds; returns empty when it fails.
   - `spawn-agent.test.ts`: a user config with mixed-case keys
     (`"MyAgent"`) is reachable via `spawnAgent({ agent: "myagent" })` and
     `spawnAgent({ agent: "MYAGENT" })`. The original key casing is also
     reachable.
   - `spawn-agent.test.ts`: a user config that defines an entry with the
     same lowercased key as a `DEFAULT_AGENTS` entry (e.g., `"Claude"`)
     overrides the default. The lookup map only contains the lowercased
     key — original casing is **not** independently reachable. **Document
     this collision behavior in `AGENTS.md` (Step 7)** so users aren't
     surprised when their `"Claude"` entry silently masks the built-in
     `claude` config.
   - `spawn-agent.test.ts` (M1): a malformed `~/.agent-link/config.json`
     (invalid JSON) writes a single warning line to `process.stderr`
     matching `/^\[agent-link\] Failed to load config/` and falls back to
     defaults. A schema-invalid entry (missing `command`) writes a
     warning that includes the offending key path and skips that entry.
     A missing config file (`ENOENT`) writes nothing.
2. Confirm RED. Commit
   `test: cross-platform which lookup; case-insensitive config keys`.
3. **GREEN:**
   - `pnpm add which@^4`. Do **not** add `@types/which` — `which` v4 ships
     its own types. Update `package.json` and lockfile via the project's
     pnpm flow (CLAUDE.md: pnpm only).
   - Replace `isCommandAvailable` with:
     ```ts
     import which from "which";
     async function isCommandAvailable(cmd: string): Promise<boolean> {
       return (await which(cmd, { nothrow: true })) !== null;
     }
     ```
     Make `listAvailableAgents` await it in parallel via
     `Promise.all(...)`.
   - In `loadUserConfig`, after Zod parsing, normalize keys to lowercase
     and surface load errors to stderr (M1):
     ```ts
     try {
       const raw = await readFile(configPath, "utf8");
       const parsed = userConfigSchema.safeParse(JSON.parse(raw));
       if (!parsed.success) {
         const issue = parsed.error.issues[0];
         process.stderr.write(
           `[agent-link] Failed to load config at ${configPath}: ` +
           `${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}\n`
         );
         return { agents: {} };
       }
       const agents = parsed.data.agents
         ? Object.fromEntries(
             Object.entries(parsed.data.agents)
               .map(([k, v]) => [k.toLowerCase(), v]),
           )
         : {};
       return { agents };
     } catch (err) {
       if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
         process.stderr.write(
           `[agent-link] Failed to load config at ${configPath}: ` +
           `${err instanceof Error ? err.message : String(err)}\n`
         );
       }
       return { agents: {} };
     }
     ```
4. Run `just test` → confirm GREEN. Commit
   `feat: cross-platform command lookup; normalize agent config keys`.

### Verification

```bash
just ci
node -e "console.log(require('which/package.json').version)"  # confirm v4
```

### Exit criteria

- `which` v4 in `dependencies`.
- `execFileSync` not referenced in `spawn-agent.ts` for command lookup.
- Config-key normalization tested.

### Rollback

Revert this commit; `pnpm install` restores prior lockfile.

---

## Step 6 — Polish: env sandbox, session TTL, batch limits, output reporting, `waitingAgents`

**Closes:** MEDIUM env passthrough, MEDIUM session-store TTL, MEDIUM
`spawn_agents` no batch limit, LOW `outputLines` mislabel, L4 `waitingAgents`
array.

### Cold-start context brief

After Steps 2–5, the architecture is clean. This step lands the remaining
quality fixes that don't require structural changes.

1. **Env sandbox (D10).** Default the env passed to `ProcessSession` to a
   small allowlist:
   `["PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
   "SHELL"]`. **`PATH` is always included** — even if a user config
   supplies `env: []` (empty extras), PATH is unioned in. Without PATH the
   subprocess fails opaquely. An agent config can opt into full
   passthrough by setting `env: "passthrough"` in
   `~/.agent-link/config.json`, or extend the allowlist with
   `env: ["EXTRA_VAR_1", ...]`. The `env` field is already declared on
   `agentConfigSchema` from Step 1.
2. **Session TTL.** Terminal sessions (`done`/`error`/`killed`) are
   removed from the store after 5 minutes. The TTL **lives in the session
   store, not in `ProcessSession`** — `ProcessSession` is the lifecycle
   owner of an *active* process; the store decides retention. Wire it as:
   when `createSession` registers a `ProcessSession`, also subscribe via
   ```ts
   session.on("close", () => {
     const t = setTimeout(() => deleteSession(id), 300_000);
     t.unref();   // do not keep the Node event loop alive solely for TTL
     timers.set(id, t);
   });
   ```
   storing the timer handle on the store record. **`.unref()` is
   mandatory** — without it, a finished MCP server process hangs for 5
   minutes after the last session closes. `deleteSession` cancels the
   timer (`clearTimeout`) before removing — no leaked timers in tests.
   Expose `getSession` returning `undefined` for expired IDs. Test note:
   `vi.useFakeTimers()` still drives `unref`'d timers, so the existing
   TTL test plan is unaffected.
3. **`spawn_agents` batch limit.** The schema is in place (Step 1's
   `spawnAgentsBatchSchema`). Wire it into `index.ts` so `agents` is parsed
   via the bounded schema (`.min(1).max(10)`). The error result must list
   the bound. Add `waitingAgents: AgentId[]` to the response (L4).
4. **`get_status` output reporting.** Replace `outputLines` with
   `outputChunks: number`, `outputBytes: number`, and `truncated: boolean`
   (D8, LOW finding). Document the rename.
5. **Documentation surfaces touched here.** Step 6 changes the wire format
   of `get_status` and `spawn_agents`; document in PR description and
   downstream notes (Step 7 owns the AGENTS.md writeup).

### Tasks (TDD order)

1. **RED:**
   - Env sandbox: a default-config spawn omits `SECRET_VAR=xyz` from the
     subprocess env. A config with `env: "passthrough"` includes it. A
     config with `env: ["SECRET_VAR"]` includes only that variable beyond
     the allowlist.
   - TTL: a terminal session disappears from `listSessions()` after
     5 minutes (use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`).
   - Batch limit: `spawn_agents` with 11 agents returns `isError: true`
     with a max-count message; with 0 agents returns the same.
   - `waitingAgents`: when 2 of 3 spawned agents pause on `[QUESTION]`,
     the response `waitingAgents` lists exactly those two `agentId`s.
   - `get_status`: response includes `outputChunks`, `outputBytes`,
     `truncated`, **not** `outputLines`. A truncated session reports
     `truncated: true` and `outputBytes` larger than the cap.
2. Confirm RED. Commit
   `test: env sandbox, TTL, batch cap, get_status fields`.
3. **GREEN:**
   - Add `resolveEnv(cfg: AgentConfigSchema): NodeJS.ProcessEnv` in
     `spawn-agent.ts`. Default allowlist constant lives there.
   - Pass the resolved env to `createProcessSession` in Step 3's spawn
     code.
   - Wrap `createProcessSession` inside `session-store.ts`'s
     creation API (or in `spawn-agent.ts`) to register the 5-minute TTL
     timer on the `'close'` event. Clear the timer on `deleteSession`.
   - In `index.ts`, parse `agents` via `spawnAgentsBatchSchema`. Compute
     `waitingAgents = formatted.filter(r => r.status === "waiting_for_reply")
     .map(r => r.agentId).filter(Boolean)`.
   - Update the `get_status` mapping to read `outputChunks`,
     `outputBytes`, `truncated` from the `ProcessSession`. Drop
     `outputLines`.
4. Run `just test` → confirm GREEN. Commit
   `feat: env allowlist, terminal session TTL, batch cap, get_status fields`.
5. **REFACTOR** — none expected; if `resolveEnv` is more than ~30 lines,
   extract to its own file `src/env.ts`.

### Verification

```bash
just ci
just test -- --coverage   # confirm ≥ 80%
```

### Exit criteria

- Default subprocess env is sandboxed; opt-in passthrough works.
- `PATH` is always included in resolved env (test asserts).
- Terminal sessions auto-expire after 5 minutes (configurable later if
  needed); store-level timer is cleared on explicit `deleteSession`.
- `spawn_agents` enforces 1..10 bound; response includes `waitingAgents`.
- `get_status` exposes `outputChunks`/`outputBytes`/`truncated`; no
  `outputLines`.
- **CHANGELOG entry** added under `## [Unreleased]` documenting the
  breaking field rename (`outputLines` → `outputChunks`), the
  `spawn_agents` response shape change (`waitingAgents` added), and the
  new `wait_agent` tool. (CHANGELOG.md is created if it doesn't exist.)
- **Semver bump:** `package.json` `version` is bumped from `1.0.0` to
  `2.0.0` in this same step. The `outputLines` rename and the
  `spawn_agents` response shape change are breaking for any MCP host
  that parses these fields, so a major bump is required. The CHANGELOG
  `[Unreleased]` heading is renamed to `[2.0.0] — YYYY-MM-DD` at the
  same time.
- Coverage ≥ 80%.

### Rollback

Revert this commit. None of these changes alter persisted state.

---

## Step 7 — Documentation refresh

**Closes:** documentation drift from Steps 1–6.

### Cold-start context brief

`AGENTS.md` and `CLAUDE.md` describe the codebase to future agents and
operators. The codesight wiki does the same for AI tooling. After Steps 1–6,
several sections are inaccurate: file count (now 5 → 6 with
`process-session.ts`), the `[QUESTION]` gotcha (no longer a chunk-substring
match), the env passthrough caveat (now allowlisted), `outputLines` (now
`outputChunks`).

This step is documentation-only — no production code, no tests.

### Tasks

1. **AGENTS.md** —
   - Architecture: add `process-session.ts` as the lifecycle owner;
     describe the line-based parser, byte cap, terminal-state guarantee,
     and the waiter queue.
   - Bidirectional Protocol: replace the "[QUESTION] anywhere in chunk"
     description with "complete-line `[QUESTION] <text>` markers; CRLF
     handled".
   - Custom Agents: document the new `flagMap` (per-agent option mapping)
     and `env` (allowlist | "passthrough" | string[]) fields. Note Zod
     validation, default key-lowercasing, and the **collision rule**: a
     user-config entry whose lowercased key matches a built-in default
     (e.g. `"Claude"` vs built-in `claude`) overrides the default; the
     original casing is not independently reachable.
   - Conventions: add `cwd` must be absolute (cross-platform); session IDs
     are 16-hex; output is byte-capped at 8 MB and reported as
     `outputBytes`/`outputChunks`/`truncated`.
   - Add a brief "MCP wire changes" subsection listing tools added
     (`wait_agent`) and field renames (`outputLines` → `outputChunks`).
2. **CLAUDE.md** —
   - Update the "Claude-specific" section: `ProcessSession` is the source
     of truth for runtime state; do not register listeners on
     `ChildProcess` directly.
3. **`.codesight/CODESIGHT.md` and `.codesight/wiki/`** —
   - Run `mcp__codesight__codesight_refresh` to regenerate the wiki and
     blast-radius graph against the new module layout.
   - Spot-check the wiki entry for `process-session.ts`; if missing or
     wrong, add a hand-written addendum.
4. **ADR** —
   - Add `docs/adr/0001-process-session-extraction.md` capturing: context
     (Codex review findings), decision (extract `ProcessSession`),
     alternatives considered (in-place patches per prior fix-plan;
     rejected because they don't structurally fix H2/H3/M5/M6),
     consequences (one new file, ~30% smaller `spawn-agent.ts`, harder to
     bypass lifecycle invariants).
5. **Remove `docs/fix-plan.md`** — superseded by this plan and the ADR.
   At plan-creation time the file is untracked (`??` in git status), so
   "remove" may be `rm docs/fix-plan.md` only; if it has been committed by
   then, use `git rm`. Verify with `git status` before committing.

### Verification

```bash
just check && just test    # nothing should regress; doc-only step
mcp__codesight__codesight_lint_wiki   # if available
```

### Exit criteria

- AGENTS.md and CLAUDE.md reflect new architecture.
- Codesight wiki regenerated.
- ADR-0001 committed.
- `docs/fix-plan.md` removed.

Commit: `docs: refresh AGENTS/CLAUDE/codesight; add ADR-0001`.

### Rollback

Revert this commit.

---

## Final Verification Checklist

After Step 7 lands, the following is true. Each item maps back to a Codex
finding ID.

- [ ] **HIGH — `[QUESTION]` parser** lines only, regex
      `/^\[QUESTION\] (.+)$/`, CRLF tolerated, cross-chunk safe. (Step 2)
- [ ] **HIGH — reply duplicate listeners** impossible: only
      `ProcessSession` listens on stdout. (Steps 2, 4)
- [ ] **HIGH — reply state validation** happens before any mutation; bad
      stdin returns `waiting_for_reply` unchanged. (Step 4)
- [ ] **MEDIUM — overall timeout** survives the first question event;
      runaway children die at the deadline. (Step 2)
- [ ] **MEDIUM — terminal status** never downgrades; timeout-then-`close 0`
      stays `error`. (Step 2)
- [ ] **MEDIUM — `spawn_agents`** capped at 10. (Steps 1, 6)
- [ ] **MEDIUM — session ID** 16 hex chars (64 bits). (Step 3)
- [ ] **MEDIUM — terminal sessions TTL'd** after 5 minutes. (Step 6)
- [ ] **MEDIUM — env sandboxed** by default; opt-in passthrough. (Steps 1, 6)
- [ ] **MEDIUM — `kill_agent`** returns truthful `signaled` flag and
      `killed` only after `'close'`. (Step 4)
- [ ] **MEDIUM — reply timeout** keeps state at `running`; `wait_agent`
      tool exists for follow-up. (Step 4)
- [ ] **LOW — config keys** normalized to lowercase at load. (Step 5)
- [ ] **LOW — `outputLines`** renamed to `outputChunks` with
      `outputBytes`/`truncated`. (Step 6)
- [ ] **HIGH (prior plan H1)** `cwd` validation cross-platform. (Step 1)
- [ ] **HIGH (prior plan H2)** no `setMaxListeners(0)` anywhere. (Step 2)
- [ ] **MEDIUM (prior plan M3)** stream null guard before state mutation.
      (Step 4)
- [ ] **MEDIUM (prior plan M4)** per-agent flag map, not
      `supportedFlags: string[]`. (Steps 1, 3)
- [ ] **LOW (prior plan L1)** `which` v4 npm package, not shell. (Step 5)
- [ ] **LOW (prior plan L2)** unknown-agent error returns `agentId: null`.
      (Step 4)
- [ ] **LOW (prior plan L3)** byte-based output cap with `truncated` flag.
      (Step 2)
- [ ] **LOW (prior plan L4)** `waitingAgents` array in `spawn_agents`
      response. (Step 6)
- [ ] **Test gaps closed**: cross-chunk marker, exact-output assertions,
      kill returning false, closed stdin/stdout, byte-based cap, config
      key normalization, batch limits.
- [ ] `just ci` green; `just test -- --coverage` ≥ 80%.

---

## Plan Mutation Protocol

If during execution a step's design fails review, follow this protocol
rather than improvising:

1. **Split**: if a step is too large (PR > 500 lines net), split off a
   sub-step with a fresh ID (`Step 4a`, `Step 4b`). Update the dependency
   graph at the top.
2. **Insert**: if a missing prerequisite is discovered, insert it as a new
   step before the dependent. Renumber later steps only if the renumber
   improves clarity; otherwise letter-suffix.
3. **Skip**: if a step is no longer necessary (e.g., upstream library fixes
   the issue), strike it through, document why in this file, and reference
   the upstream fix.
4. **Reorder**: only with explicit approval from the user — reordering
   touches the dependency graph and may invalidate exit criteria.
5. **Abandon**: if the architectural premise fails (e.g., the MCP SDK
   evolves to handle long-running tools natively in 1.x), abandon
   downstream steps and produce a new plan. Do not partially execute.

Every mutation appends an entry to the `## Plan Mutation Log` section
below with date, step IDs, and one-line rationale.

---

## Plan Mutation Log

| Date | Step(s) | Rationale |
|------|---------|-----------|
| 2026-04-26 | D5, D6, Step 1, Step 2, Step 3, Step 4, Step 5, Step 6, Step 7 | Code-review pass: corrected D6 (MCP SDK takes `ZodRawShape`, not `ZodObject`), corrected D5 (`path.posix.isAbsolute \|\| path.win32.isAbsolute` for cross-platform tests on Linux CI), specified AbortController-vs-`kill` cancellation paths in Step 2, lowercased agent-name prefix in `agentId` (Step 3), reframed two-question test (Step 2), required `.unref()` on TTL timers (Step 6), removed `@types/which` install (Step 5), added semver `2.0.0` bump in Step 6, documented case-insensitive override collision in Step 5/Step 7, and seeded this log. |
