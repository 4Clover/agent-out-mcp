# ADR 0001: Extract `ProcessSession` for child-process lifecycle

- **Status:** Accepted
- **Date:** 2026-04-26

## Context

The 2026-04-26 Codex (gpt-5.5, xhigh) review of `agent-link-mcp` identified
a cluster of correctness bugs in the child-process handling that all
shared one root cause: stdout listeners, the `[QUESTION]` parser, the
output buffer, the overall timeout, and `kill()` were spread across both
`spawn-agent.ts::runProcess` and the `reply` / `kill_agent` MCP tools in
`index.ts`.

In particular:

- The `[QUESTION]` detector did a chunk-substring match
  (`text.includes("[QUESTION]")`) so markers split across stdout chunks
  were missed and mid-line substrings could falsely trigger.
- `reply` registered a *second* `proc.stdout.on('data', …)` for the
  duration of its call, which double-pushed output bytes into the session
  buffer and could race with the spawn-side listener on a subsequent
  `[QUESTION]`.
- The overall spawn timeout was cleared as soon as the first question
  fired, leaving a misbehaving child to outlive its deadline.
- The `'close'` handler unconditionally set `session.status` based on the
  exit code, overwriting an `error` set earlier by the timeout branch.
- `kill_agent` flipped `killed: true` synchronously before the child
  actually exited.
- After a `reply` 30-second silence, state was restored to
  `waiting_for_reply`, allowing a caller to send a duplicate input.

A prior `docs/fix-plan.md` proposed in-place patches at each call site.
Those patches papered over symptoms but left the structural foot-gun in
place: anything could still grab a stdout listener, drop a state
mutation, or fail to honor the deadline.

## Decision

Extract a single `ProcessSession` module that owns the entire
child-process lifecycle:

- One `readline.createInterface({ crlfDelay: Infinity })` does line-based
  `[QUESTION]` parsing. The raw-byte buffer subscribes to `proc.stdout`
  *before* `readline` is created so waiters see the full chunk containing
  the question line in their captured output.
- A discriminated-union `SessionState` plus an `assertNever`-style
  transition function refuse to overwrite a state whose `kind` is in
  `TERMINAL_KINDS = { done, error, killed }`. Timeout-then-`close 0`
  stays `error`.
- A FIFO waiter queue powers `waitNext`. Each waiter accumulates only
  the output observed during its own registration window — eliminating
  the duplicate-output bug that came from the second `data` listener.
- `kill()` returns truthful `signaled` and refuses to claim it killed
  an already-terminal session. If `proc.kill()` returns false (PID gone
  before signal delivery) the session synchronously finalizes to
  `killed` so waiters unblock.
- Output is byte-capped (default 8 MB) with drop-oldest semantics and
  surfaced as `outputBytes` / `outputChunks` / `truncated`.
- `reply` keeps state at `running` after a 30-second silence rather
  than reverting to `waiting_for_reply`; a new `wait_agent` MCP tool
  awaits the next event without writing duplicate input.

`spawn-agent.ts` and `index.ts` become thin callers: nothing outside
`process-session.ts` registers a `ChildProcess` listener.

## Alternatives considered

1. **In-place patches per the prior `docs/fix-plan.md`.** Rejected:
   doesn't structurally close the duplicate-listener / terminal-state
   downgrade / kill-ordering bugs; future changes to either call site
   could re-introduce them.
2. **AbortController for both timeout and user kills (one path).**
   Considered but kept disjoint — explicit `proc.kill(signal)` for both
   cases, distinguished by a `terminationReason` field. Simpler to
   reason about under the test seam (`spawnImpl` injection) and matches
   the reality that user kills carry signal semantics that aborts do not.
3. **Stream-piping `proc.stdout` through a transform that emits
   parsed events.** Rejected as more machinery than needed; readline
   already gives us complete-line semantics with CRLF handling.

## Consequences

- One additional source file (`src/process-session.ts`).
- `spawn-agent.ts` shrinks by ~30%.
- The `[QUESTION]` line regex (`/^\[QUESTION\] (.+)$/`) is the single
  point of truth — protocol changes touch one file, not three.
- `kill_agent` now awaits the close before returning, so its response
  takes ~one event-loop turn longer than before in the happy path.
  Acceptable: the response is more truthful.
- Downstream MCP hosts that parse `outputLines` must update to
  `outputChunks` (see CHANGELOG.md). v2.0.0 is a major bump.
