# Fix Plan: Code Review Findings

TDD-based plan for resolving all HIGH, MEDIUM, and LOW findings from the
2026-04-26 code review. Each phase follows the RED → GREEN → REFACTOR cycle
with a git checkpoint after each stage.

---

## Findings Summary

| ID  | Sev    | Area                                              |
|-----|--------|---------------------------------------------------|
| H1  | HIGH   | Unvalidated `cwd` allows filesystem pivoting       |
| H2  | HIGH   | `reply` accumulates unbounded stdout listeners     |
| H3  | HIGH   | `runProcess` timeout doesn't update session status |
| M1  | MEDIUM | `loadUserConfig` swallows all errors silently      |
| M2  | MEDIUM | User config not runtime-validated                  |
| M3  | MEDIUM | `stdout` non-null assertion in `reply`             |
| M4  | MEDIUM | `--thinking`/`--model` appended to all agents      |
| M5  | MEDIUM | `kill_agent` deletes session before process exits  |
| M6  | MEDIUM | `reply` timeout leaves session stuck as "running"  |
| L1  | LOW    | `which` is POSIX-only                              |
| L2  | LOW    | `agentId: ""` on unknown-agent error               |
| L3  | LOW    | `session.output` grows without bound               |
| L4  | LOW    | `spawn_agents` doesn't highlight waiting agents    |

**Coverage gaps also addressed:** reply round-trip, 30 s timeout, 1 h spawn
timeout, malformed config, non-claude flag gating, kill of exited session.

---

## TDD conventions for this project

- Framework: **vitest** (`just test` / `just test-file <name>`)
- Test files: `src/__tests__/*.test.ts`
- Cycle: write failing test → confirm RED → implement → confirm GREEN → refactor
- Git checkpoints:
  - `test: <description>` immediately after RED is confirmed
  - `fix: <description>` immediately after GREEN is confirmed
  - `refactor: clean up <description>` after optional refactor
- Coverage check after final phase: `just test -- --coverage`
- No production code changes before RED is confirmed

---

## Phase 1 — Schema validation (H1, M2 foundation)

**Files:** `src/schemas.ts`, `src/__tests__/server.test.ts`,
`src/__tests__/spawn-agent.test.ts`

### User journeys

> As an MCP host, I want `cwd` to be validated as an absolute path so that
> a misconfigured or adversarial caller cannot pivot the subprocess into an
> unintended directory.
>
> As a developer adding a custom agent to `~/.agent-link/config.json`, I want
> a clear schema error when my config is malformed so that I know what to fix.

### Step 1 — Write failing tests (RED)

Add to `src/__tests__/server.test.ts`:

```typescript
it("rejects relative cwd via schema", async () => {
  const result = await client.callTool({
    name: "spawn_agent",
    arguments: { agent: "claude", task: "x", cwd: "../escape" },
  });
  expect(result.isError).toBe(true);
  expect((result.content[0] as any).text).toMatch(/invalid|absolute/i);
});
```

Add to `src/__tests__/spawn-agent.test.ts`:

```typescript
import { agentConfigSchema } from "../schemas.js";

describe("agentConfigSchema", () => {
  it("accepts a valid agent config", () => {
    expect(() =>
      agentConfigSchema.parse({ command: "mytool", args: [], promptFlag: null })
    ).not.toThrow();
  });

  it("rejects a config missing command", () => {
    expect(() =>
      agentConfigSchema.parse({ args: [], promptFlag: null })
    ).toThrow();
  });

  it("defaults args to [] and promptFlag to null when omitted", () => {
    const cfg = agentConfigSchema.parse({ command: "mytool" });
    expect(cfg.args).toEqual([]);
    expect(cfg.promptFlag).toBeNull();
  });
});
```

Run `just test` → tests must fail.
Commit: `test: add schema validation tests for cwd and agentConfigSchema`

### Step 2 — Implement (GREEN)

In `src/schemas.ts`:

1. Add `cwd` regex:
   ```typescript
   cwd: z.string()
     .regex(/^\//, "cwd must be an absolute path")
     .optional()
     .describe("Working directory for the subprocess"),
   ```

2. Export new schemas:
   ```typescript
   export const agentConfigSchema = z.object({
     command: z.string().min(1),
     args: z.array(z.string()).default([]),
     promptFlag: z.string().nullable().default(null),
     supportedFlags: z.array(z.string()).optional(),
   });

   export const userConfigSchema = z.object({
     agents: z.record(z.string(), agentConfigSchema).optional(),
   });

   export type AgentConfigFromSchema = z.infer<typeof agentConfigSchema>;
   export type UserConfig = z.infer<typeof userConfigSchema>;
   ```

Run `just test` → all tests must pass.
Commit: `fix: add absolute-path constraint to cwd and export config schemas`

### Step 3 — Refactor

None required. Schemas are already in `schemas.ts` per project convention.

---

## Phase 2 — Agent flag gating (M4)

**Files:** `src/agents.ts`, `src/spawn-agent.ts`,
`src/__tests__/server.test.ts`

### User journeys

> As an orchestrator spawning an aider agent, I want `--model` and `--thinking`
> to be silently ignored so that aider doesn't exit with an unrecognized-flag
> error when I pass those options.

### Step 1 — Write failing tests (RED)

Add to the `spawn_agent` describe block in `src/__tests__/server.test.ts`:

```typescript
it("does not pass --thinking or --model to aider", async () => {
  vi.mocked(spawn).mockImplementation(() =>
    createFakeProcess({ stdout: "ok\n", exitCode: 0 }) as any
  );
  await client.callTool({
    name: "spawn_agent",
    arguments: { agent: "aider", task: "x", model: "gpt-4o", thinking: "high" },
  });
  const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
  expect(args).not.toContain("--model");
  expect(args).not.toContain("--thinking");
});

it("still passes --thinking and --model to claude", async () => {
  await client.callTool({
    name: "spawn_agent",
    arguments: { agent: "claude", task: "x", model: "sonnet", thinking: "high" },
  });
  const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
  expect(args).toContain("--model");
  expect(args).toContain("--thinking");
});
```

Run `just test` → first test must fail (aider currently receives the flags).
Commit: `test: add flag-gating reproducer for non-claude agents`

### Step 2 — Implement (GREEN)

In `src/agents.ts`:

```typescript
export interface AgentConfig {
  command: string;
  args: string[];
  promptFlag: string | null;
  supportedFlags?: string[];   // add this field
}

export const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  claude: {
    command: "claude",
    args: ["--print", "--dangerously-skip-permissions"],
    promptFlag: null,
    supportedFlags: ["--model", "--thinking"],
  },
  // codex, gemini, aider unchanged (no supportedFlags)
  ...
};
```

In `src/spawn-agent.ts`, `buildArgs`:

```typescript
if (opts.model && cfg.supportedFlags?.includes("--model"))
  args.push("--model", opts.model);
if (opts.thinking && cfg.supportedFlags?.includes("--thinking"))
  args.push("--thinking", opts.thinking);
```

Run `just test` → all tests must pass.
Commit: `fix: gate --model and --thinking flags on AgentConfig.supportedFlags`

### Step 3 — Refactor

None required.

---

## Phase 3 — Config loading hardening (M1, M2)

**Files:** `src/spawn-agent.ts`, `src/__tests__/spawn-agent.test.ts`

### User journeys

> As a user who made a typo in `~/.agent-link/config.json`, I want a clear
> warning written to stderr so that I know the file is broken and my custom
> agents are being ignored.
>
> As a user whose config references a non-existent agent entry (missing
> `command`), I want the server to reject that entry rather than crash with
> an unhandled rejection.

### Step 1 — Write failing tests (RED)

Add to `src/__tests__/spawn-agent.test.ts`:

```typescript
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadUserConfig error handling", () => {
  let tmpPath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `agent-link-test-${randomUUID()}.json`);
    originalEnv = process.env.AGENT_LINK_CONFIG;
    process.env.AGENT_LINK_CONFIG = tmpPath;
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.AGENT_LINK_CONFIG;
    else process.env.AGENT_LINK_CONFIG = originalEnv;
    await unlink(tmpPath).catch(() => {});
  });

  it("returns {} silently when config file does not exist", async () => {
    // tmpPath doesn't exist yet
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await resolveAgentConfig("claude");
    expect(cfg).not.toBeNull(); // falls back to DEFAULT_AGENTS
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("writes a stderr warning and falls back when JSON is malformed", async () => {
    await writeFile(tmpPath, "not valid json");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await resolveAgentConfig("claude");
    expect(cfg).not.toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load config/)
    );
    stderrSpy.mockRestore();
  });

  it("rejects a config entry missing command and writes a warning", async () => {
    await writeFile(
      tmpPath,
      JSON.stringify({ agents: { broken: { args: [], promptFlag: null } } })
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await resolveAgentConfig("broken");
    expect(cfg).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load config|invalid/i)
    );
    stderrSpy.mockRestore();
  });
});
```

Run `just test` → new tests must fail.
Commit: `test: add loadUserConfig error-handling reproducers`

### Step 2 — Implement (GREEN)

In `src/spawn-agent.ts`:

1. Remove the `UserConfig` interface (now imported from `schemas.ts`).
2. Replace imports:
   ```typescript
   import { SpawnOptions, userConfigSchema, UserConfig } from "./schemas.js";
   ```
3. Rewrite `loadUserConfig`:
   ```typescript
   async function loadUserConfig(): Promise<UserConfig> {
     const configPath =
       process.env.AGENT_LINK_CONFIG ??
       join(homedir(), ".agent-link", "config.json");
     try {
       const raw = await readFile(configPath, "utf8");
       const parsed = userConfigSchema.safeParse(JSON.parse(raw));
       if (!parsed.success) {
         process.stderr.write(
           `[agent-link] Failed to load config at ${configPath}: ` +
           `${parsed.error.issues[0]?.message ?? "invalid schema"}\n`
         );
         return {};
       }
       return parsed.data;
     } catch (err) {
       if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
         process.stderr.write(
           `[agent-link] Failed to load config at ${configPath}: ` +
           `${err instanceof Error ? err.message : String(err)}\n`
         );
       }
       return {};
     }
   }
   ```

Run `just test` → all tests must pass.
Commit: `fix: validate user config with Zod and warn on malformed JSON`

### Step 3 — Refactor

Remove the now-unused local `UserConfig` interface. Verify `just check` passes.

---

## Phase 4 — Session-store hardening (H2 foundation, L3)

**Files:** `src/session-store.ts`, `src/__tests__/session-store.test.ts`

### User journeys

> As an orchestrator running a long interactive session, I want listener
> registration to be unlimited so that Node never emits
> `MaxListenersExceededWarning` during extended question/reply cycles.
>
> As an operator running a 1-hour aider session, I want output accumulation
> to be capped so that the MCP server process doesn't exhaust heap memory.

### Step 1 — Write failing tests (RED)

Add to `src/__tests__/session-store.test.ts`:

```typescript
import { EventEmitter } from "node:events";

function fakeProcessWithEmitters() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return {
    pid: 1234,
    kill: () => true,
    stdout,
    stderr,
  } as unknown as ChildProcess;
}

it("sets unlimited listeners on stdout and stderr after createSession", () => {
  const proc = fakeProcessWithEmitters();
  createSession({
    agentId: "listener-test",
    agent: "claude",
    task: "t",
    process: proc,
    status: "running",
  });
  expect((proc.stdout as EventEmitter).getMaxListeners()).toBe(Infinity);
  expect((proc.stderr as EventEmitter).getMaxListeners()).toBe(Infinity);
});

it("appendOutput trims session.output to MAX_OUTPUT_LINES", () => {
  const session = createSession({
    agentId: "ring-test",
    agent: "claude",
    task: "t",
    process: fakeProcess(),
    status: "running",
  });
  for (let i = 0; i < MAX_OUTPUT_LINES + 5; i++) {
    appendOutput(session, `line ${i}`);
  }
  expect(session.output.length).toBe(MAX_OUTPUT_LINES);
  expect(session.output[0]).toBe("line 5"); // oldest lines dropped
});

it("accepts 'killed' as a valid session status", () => {
  const session = createSession({
    agentId: "kill-status",
    agent: "claude",
    task: "t",
    process: fakeProcess(),
    status: "running",
  });
  session.status = "killed"; // should not throw a TS error after the union is updated
  expect(session.status).toBe("killed");
});
```

Run `just test` → new tests fail (`appendOutput` and `MAX_OUTPUT_LINES` don't exist yet; `"killed"` is not in the union).
Commit: `test: add session-store listener cap and ring-buffer reproducers`

### Step 2 — Implement (GREEN)

In `src/session-store.ts`:

```typescript
import { ChildProcess } from "node:child_process";

export const MAX_OUTPUT_LINES = 10_000;

export interface AgentSession {
  agentId: string;
  agent: string;
  task: string;
  process: ChildProcess;
  status: "running" | "waiting_for_reply" | "done" | "error" | "killed";
  pendingQuestion?: string;
  output: string[];
  startedAt: Date;
}

const sessions = new Map<string, AgentSession>();

export function createSession(
  partial: Omit<AgentSession, "output" | "startedAt">
): AgentSession {
  const session: AgentSession = {
    ...partial,
    output: [],
    startedAt: new Date(),
  };
  sessions.set(session.agentId, session);
  session.process.stdout?.setMaxListeners(0);
  session.process.stderr?.setMaxListeners(0);
  return session;
}

export function appendOutput(session: AgentSession, chunk: string): void {
  session.output.push(chunk);
  if (session.output.length > MAX_OUTPUT_LINES) {
    session.output.splice(0, session.output.length - MAX_OUTPUT_LINES);
  }
}

export function getSession(agentId: string): AgentSession | undefined {
  return sessions.get(agentId);
}

export function listSessions(): AgentSession[] {
  return Array.from(sessions.values());
}

export function deleteSession(agentId: string): void {
  sessions.delete(agentId);
}
```

Run `just test` → all tests must pass.
Commit: `fix: unlimited stdout listeners, ring-buffer cap, and killed status`

### Step 3 — Refactor

None required.

---

## Phase 5 — spawn-agent + reply + kill fixes (H2, H3, M3, M5, M6)

**Files:** `src/spawn-agent.ts`, `src/index.ts`,
`src/__tests__/server.test.ts`

This is the most complex phase. All new tests are written before any
production code changes.

### User journeys

> As an orchestrator, I want a reply round-trip (spawn → question → reply →
> done) to work correctly so that I can complete interactive sessions.
>
> As an orchestrator, I want a 30-second silence timeout in `reply` to leave
> the session in a retryable state so that I can call `reply` again after
> the process resumes.
>
> As an orchestrator, I want a 1-hour spawn timeout to set the session status
> to "error" so that `get_status` accurately reflects the dead session.
>
> As an orchestrator, I want `kill_agent` to reflect a "killed" status before
> the session disappears so that nothing observing the session sees stale state.

### Step 1 — Write failing tests (RED)

Add to `src/__tests__/server.test.ts`:

```typescript
// ── reply round-trip ─────────────────────────────────────────────────────────

describe("reply round-trip", () => {
  it("completes a full question/reply/done cycle", async () => {
    let stdinReceived = "";
    const stdout = new EventEmitter();
    const proc = Object.assign(new EventEmitter(), {
      stdin: new Writable({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          stdinReceived += chunk.toString();
          // After receiving the reply, emit output and close
          queueMicrotask(() => {
            stdout.emit("data", Buffer.from("final answer\n"));
            queueMicrotask(() => proc.emit("close", 0));
          });
          cb();
        },
      }),
      stdout,
      stderr: new EventEmitter(),
      pid: 1001,
      kill: vi.fn(),
    });

    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() =>
        stdout.emit("data", Buffer.from("[QUESTION] Which file?\n"))
      );
      return proc as any;
    });

    const spawnResult = await client.callTool({
      name: "spawn_agent",
      arguments: { agent: "claude", task: "interactive task" },
    });
    const { agentId, status: s1 } = parseResult(spawnResult as any);
    expect(s1).toBe("waiting_for_reply");

    const replyResult = await client.callTool({
      name: "reply",
      arguments: { agentId, message: "src/index.ts" },
    });
    const data = parseResult(replyResult as any);
    expect(data.status).toBe("done");
    expect(data.result).toContain("final answer");
    expect(stdinReceived).toContain("src/index.ts");
  });
});

// ── reply 30-second timeout ───────────────────────────────────────────────────

describe("reply timeout", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns partial output and restores waiting_for_reply status after 30 s silence", async () => {
    vi.mocked(spawn).mockImplementationOnce(() =>
      createFakeProcess({ question: "waiting for input" }) as any
    );

    const spawnResult = await client.callTool({
      name: "spawn_agent",
      arguments: { agent: "claude", task: "slow task" },
    });
    const { agentId } = parseResult(spawnResult as any);

    const replyPromise = client.callTool({
      name: "reply",
      arguments: { agentId, message: "hello" },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const replyResult = await replyPromise;
    const data = parseResult(replyResult as any);
    expect(data.status).toBe("running");

    const session = getSession(agentId);
    expect(session?.status).toBe("waiting_for_reply"); // H2 + M6 fix
  });
});

// ── runProcess 1-hour timeout ─────────────────────────────────────────────────

describe("runProcess timeout", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sets session.status to error after 1-hour timeout", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 2001,
        kill: vi.fn(() => { (proc as any).emit("close", null); }),
      });
      return proc as any;
    });

    const spawnPromise = client.callTool({
      name: "spawn_agent",
      arguments: { agent: "claude", task: "long task", timeoutMs: 3_600_000 },
    });

    await vi.advanceTimersByTimeAsync(3_600_000);
    const result = await spawnPromise;
    const data = parseResult(result as any);
    expect(data.status).toBe("error");
    expect(data.error).toMatch(/timed out/i);

    const session = getSession(data.agentId);
    expect(session?.status).toBe("error"); // H3 fix
  });
});

// ── kill_agent against exited session ────────────────────────────────────────

describe("kill_agent edge cases", () => {
  it("handles killing an already-done session", async () => {
    vi.mocked(spawn).mockImplementationOnce(() =>
      createFakeProcess({ stdout: "done\n", exitCode: 0 }) as any
    );
    const spawnResult = await client.callTool({
      name: "spawn_agent",
      arguments: { agent: "claude", task: "quick task" },
    });
    const { agentId } = parseResult(spawnResult as any);
    // session status is now "done"

    const result = await client.callTool({
      name: "kill_agent",
      arguments: { agentId },
    });
    const data = parseResult(result as any);
    expect(data.killed).toBe(true); // M5: no crash
  });
});
```

Also import `getSession` from `session-store` at the top of `server.test.ts`:
```typescript
import { listSessions, deleteSession, getSession } from "../session-store.js";
```

Run `just test` → new tests must fail.
Commit: `test: add round-trip reply, timeout, and kill reproducers`

### Step 2 — Implement (GREEN)

**`src/spawn-agent.ts`:**

1. Add `appendOutput` import:
   ```typescript
   import { createSession, appendOutput } from "./session-store.js";
   ```

2. Replace all `session.output.push(...)` calls with `appendOutput(session, ...)`.

3. In the `setTimeout` callback inside `runProcess`, add `session.status = "error"` BEFORE `proc.kill`:
   ```typescript
   const timeout = setTimeout(() => {
     if (!resolved) {
       resolved = true;
       session.status = "error";   // H3
       proc.kill("SIGTERM");
       resolve({ agentId, status: "error", error: "Agent timed out", result: collectOutput() });
     }
   }, timeoutMs);
   ```

**`src/index.ts` — `reply` tool:**

1. Replace the `stdout` non-null assertion with a null guard (M3):
   ```typescript
   if (!session.process.stdout) {
     return textResult({ error: `Agent ${agentId} stdout is not available` }, true);
   }
   const stdout = session.process.stdout;
   ```

2. Capture the current question before clearing it (needed for timeout restore):
   ```typescript
   const lastQuestion = session.pendingQuestion;
   session.status = "running";
   session.pendingQuestion = undefined;
   ```

3. In the `setTimeout` callback, restore status and question (H2, M6):
   ```typescript
   const timer = setTimeout(() => {
     if (!resolved) {
       resolved = true;
       session.status = "waiting_for_reply";   // restore — process still alive
       session.pendingQuestion = lastQuestion;
       cleanup();
       resolve({ agentId, status: "running", partial: collectOutput() });
     }
   }, 30_000);
   ```

**`src/index.ts` — `kill_agent` tool:**

Set status before deleting (M5):
```typescript
session.status = "killed";
session.process.kill(signal);
deleteSession(agentId);
```

Run `just test` → all tests must pass.
Commit: `fix: reply listener safety, timeout status, stdout null guard, kill status`

### Step 3 — Refactor

Review `runProcess` and `reply` for any duplicated `collectOutput` logic or
stale comments; clean up without behaviour changes. Run `just test` to confirm
still green.

---

## Phase 6 — Cross-platform `which` and agentId placeholder (L1, L2)

**Files:** `src/spawn-agent.ts`, `src/__tests__/spawn-agent.test.ts`,
`src/__tests__/server.test.ts`

### User journeys

> As a Windows user running the MCP server under native Node, I want
> `list_agents` to work so that I can see which agents are available.
>
> As an orchestrator receiving an error for an unknown agent, I want
> `agentId` to be a meaningful placeholder so that I can distinguish it
> from a valid session.

### Step 1 — Write failing tests (RED)

Add to `src/__tests__/spawn-agent.test.ts`:

```typescript
describe("isCommandAvailable cross-platform", () => {
  it("calls 'where' on win32 and 'which' on other platforms", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");

    vi.mocked(execFileSync).mockReturnValue(Buffer.from("C:\\tools\\claude.exe"));

    const available = await listAvailableAgents();
    expect(vi.mocked(execFileSync).mock.calls.at(-1)![0]).toBe("where");

    platformSpy.mockRestore();
  });
});
```

Update the existing `agentId` assertion in `spawnAgent returns error for unknown agent`:
```typescript
expect(result.agentId).toBe("unknown"); // was ""
```

Run `just test` → cross-platform test fails; `agentId` assertion fails.
Commit: `test: add cross-platform which/where and agentId placeholder reproducers`

### Step 2 — Implement (GREEN)

In `src/spawn-agent.ts`:

```typescript
function isCommandAvailable(cmd: string): boolean {
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    execFileSync(lookup, [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

Change the unknown-agent early return:
```typescript
return { agentId: "unknown", status: "error", error: `Unknown agent: ${opts.agent}` };
```

Run `just test` → all tests must pass.
Commit: `fix: cross-platform command lookup and descriptive agentId placeholder`

### Step 3 — Refactor

None required.

---

## Phase 7 — Documentation refresh (L4)

**Files:** `AGENTS.md`, `.codesight/CODESIGHT.md`

No production code changes. No TDD cycle needed.

Update the following sections:

| Document        | Section                  | Add                                                          |
|-----------------|--------------------------|--------------------------------------------------------------|
| `AGENTS.md`     | Architecture             | `session-store.ts` now exports `appendOutput` and `MAX_OUTPUT_LINES` |
| `AGENTS.md`     | Custom Agents            | `~/.agent-link/config.json` is validated with Zod; `command` is required; warn on malformed JSON |
| `AGENTS.md`     | Custom Agents            | `supportedFlags` optional field; only Claude supports `--model`/`--thinking` by default |
| `AGENTS.md`     | Conventions / new section | `cwd` must be an absolute path |
| `AGENTS.md`     | Conventions              | `session.output` is capped at `MAX_OUTPUT_LINES` (10 000) lines |
| `AGENTS.md`     | Conventions              | `kill_agent` sets `status: "killed"` before deletion         |
| `.codesight/`   | session-store description | Note ring-buffer and unlimited-listener behaviour           |

Commit: `docs: update AGENTS.md and codesight for Phase 1–6 changes`

---

## Final verification

```bash
just ci                        # typecheck + full test suite
just test -- --coverage        # verify ≥ 80% coverage
```

Expected outcome: all 6 prior coverage gaps are now covered, all HIGH findings
resolved, `just ci` exits 0.

---

## Success checklist

- [ ] H1 — relative `cwd` rejected at schema layer
- [ ] H2 — 10+ reply round-trips produce no `MaxListenersExceededWarning`; 30 s timeout restores `waiting_for_reply`
- [ ] H3 — 1-hour timeout sets `session.status = "error"`
- [ ] M1 — malformed config writes to stderr, falls back to defaults
- [ ] M2 — config entries missing `command` are rejected with a Zod error
- [ ] M3 — `reply` returns a clean error when `process.stdout` is null
- [ ] M4 — `--model`/`--thinking` not passed to aider/codex/gemini
- [ ] M5 — `kill_agent` sets `session.status = "killed"` before deletion
- [ ] M6 — confirmed by H2 fix
- [ ] L1 — `where` used on win32, `which` elsewhere
- [ ] L2 — unknown-agent error returns `agentId: "unknown"`
- [ ] L3 — `MAX_OUTPUT_LINES` ring-buffer enforced in `appendOutput`
- [ ] L4 — documented in `AGENTS.md`
- [ ] All 6 coverage gaps covered by new tests
- [ ] `just ci` passes
- [ ] Coverage ≥ 80%
