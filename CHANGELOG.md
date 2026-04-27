# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-04-26

This is a substantive correctness and security release driven by the 2026-04-26
Codex review of `agent-link-mcp`. The architecture now centralizes child-process
lifecycle in a single `ProcessSession` module that fixes several classes of bugs
flagged in that review.

### Added
- New `wait_agent` tool. Waits for the next event (question or close) from a
  running agent without writing to its stdin. Use this after a `reply` timeout
  to observe the next `[QUESTION]` or process exit without sending duplicate
  input.
- `spawn_agents` response now includes `waitingAgents: string[]` listing the
  `agentId`s of any batch entries that paused on `[QUESTION]`.
- `get_status` now reports `outputBytes` (total bytes seen) and `truncated`
  (whether the in-memory buffer was capped at 8 MB).
- Per-agent `flagMap` in agent configs maps known logical options
  (`model`, `thinking`) to the per-CLI flag names. Replaces the previous
  blanket `--model` / `--thinking` flag injection.
- Per-agent `env` field accepts `"passthrough"` or a string array allowlist.
  Subprocess env now defaults to a small allowlist
  (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `SHELL`); `PATH` is always
  included.
- Cross-platform absolute-path validation for `cwd` (POSIX and Windows).
- User config (`~/.agent-link/config.json`) is now Zod-validated; config load
  errors are surfaced to stderr.
- `spawn_agents` is bounded to between 1 and 10 entries per call.

### Changed
- **Breaking:** `get_status` field rename — `outputLines` → `outputChunks`.
  MCP hosts that parse the older field name must update.
- **Breaking:** `spawn_agents` response shape — added `waitingAgents` array.
- **Breaking:** Unknown-agent `reply` / `wait_agent` errors return
  `agentId: null` instead of the literal string `""`.
- Session IDs are now 16 hex characters (64 bits of entropy) — up from 24
  bits previously.
- The agent-name prefix in the `agentId` is lowercased
  (`spawn_agent({ agent: "Claude" })` produces `claude-…`).
- Terminal sessions (`done`/`error`/`killed`) are now evicted from the
  in-memory store after 5 minutes (TTL timers are unref'd so they don't
  hold the event loop open).
- `[QUESTION]` is now parsed line-by-line via `readline` (CRLF tolerated).
  Cross-chunk markers and mid-line `[QUESTION]` substrings no longer cause
  spurious or missed detections.
- Output buffer is byte-capped at 8 MB by default with drop-oldest semantics
  (previously: unbounded chunk array).
- `kill_agent` returns truthful `signaled` and `finalState` fields and
  refuses to claim it killed an already terminal session.
- Cross-platform command lookup via the `which` v4 npm package, replacing
  the prior `execFileSync("which", …)` shell-out.
- User config keys are normalized to lowercase at load time. A
  user-config entry whose lowercased key matches a built-in default (e.g.
  `"Claude"` vs built-in `claude`) overrides the default.

### Fixed (post-review hardening — 2026-04-26)
- HIGH: `kill_agent` called `waitNext()` with no timeout after sending the
  kill signal. A child that ignores SIGTERM would hang the tool call
  indefinitely. Now waits up to 30 seconds.
- HIGH: `model` flag accepted arbitrary strings (including `--flag` values
  that a child CLI could interpret as its own flags). Now validated with
  `^[a-zA-Z0-9_][a-zA-Z0-9_.\-:/@]*$`, max 128 chars.
- MEDIUM: `timeoutMs` on `spawn_agent` accepted `0`, negative, and
  non-integer values. Now bounded to `int ∈ [1000, 86400000]`.
- MEDIUM: `kill()` set `terminationReason = "user"` after `proc.kill()`,
  creating a theoretical race with the `'close'` event handler. Now set
  before the signal is sent.
- MEDIUM: `currentRun` and waiter `buffered` accumulators were unbounded;
  now capped at `maxOutputBytes`.
- MEDIUM: `LC_*` env allowlist only included `LC_ALL`/`LC_CTYPE`. Now
  includes all standard locale categories.
- MEDIUM: `spawn_agents` tool schema did not enforce the 1..10 batch cap;
  `.min(1).max(10)` now applied at the schema level.
- LOW: `env` array entries accepted arbitrary strings (including `=`).
  Now validated as legal env var names (`^[a-zA-Z_][a-zA-Z0-9_]*$`).
- LOW: No concurrent session limit. Session store now enforces max 50.
- Removed dead `parseQuestion()` export from `spawn-agent.ts`.

### Fixed (v2.0.0 initial release)
- HIGH: `[QUESTION]` parser previously did chunk-substring matching; markers
  split across `data` events were missed and mid-line matches falsely fired.
- HIGH: `reply` previously registered a second stdout listener for the
  duration of the call, which double-pushed bytes into the session buffer
  and could race with the spawn-side listener on a subsequent `[QUESTION]`.
- HIGH: `reply` previously mutated session state before validating that
  stdin was writable.
- MEDIUM: Overall timeout was cleared as soon as the first question fired,
  letting a misbehaving child outlive the deadline.
- MEDIUM: `'close'` could overwrite a prior `error` status (e.g. set by
  the timeout branch), turning a timed-out run into `done`.
- MEDIUM: `kill_agent` flipped `killed: true` before the child actually
  exited.
- MEDIUM: After a `reply` timeout the session state was restored to
  `waiting_for_reply`, allowing the caller to send duplicate input.
