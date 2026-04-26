import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export type SessionState =
  | { kind: "running" }
  | { kind: "waiting_for_reply"; question: string }
  | { kind: "killing"; reason: "user" | "timeout" }
  | { kind: "done"; exitCode: number; result: string }
  | { kind: "error"; error: string; result: string }
  | { kind: "killed"; signal: NodeJS.Signals | null; result: string };

export const TERMINAL_KINDS = new Set<SessionState["kind"]>([
  "done",
  "error",
  "killed",
]);

export type WaitResult =
  | { kind: "question"; question: string; output: string }
  | { kind: "close"; state: SessionState }
  | { kind: "timeout"; output: string };

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
  readonly outputBytes: number;
  readonly outputChunks: number;
  readonly truncated: boolean;
  collectOutput(): string;
  write(input: string): boolean;
  on<K extends keyof ProcessSessionEvents>(
    event: K,
    listener: ProcessSessionEvents[K]
  ): () => void;
  waitNext(opts?: { timeoutMs?: number }): Promise<WaitResult>;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CreateProcessSessionOptions {
  agentId: string;
  agent: string;
  task: string;
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  spawnImpl?: typeof nodeSpawn;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface PendingWaiter {
  buffered: string;
  resolve: (r: WaitResult) => void;
  timer?: NodeJS.Timeout;
}

export function createProcessSession(
  opts: CreateProcessSessionOptions
): ProcessSession {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = new Date();

  const proc = spawnImpl(opts.command, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env,
  });

  const emitter = new EventEmitter();
  const waiters: PendingWaiter[] = [];

  let state: SessionState = { kind: "running" };
  let terminationReason: "user" | "timeout" | null = null;

  // Output buffer: live chunks + total counters
  const liveChunks: string[] = [];
  let liveBytes = 0;
  let outputBytes = 0;
  let outputChunks = 0;
  let truncated = false;

  // Output captured since last boundary (write or fast-path question consume)
  let currentRun = "";

  function setState(next: SessionState): void {
    if (TERMINAL_KINDS.has(state.kind)) return;
    state = next;
  }

  function appendOutput(chunk: string, source: "stdout" | "stderr"): void {
    const tagged = source === "stderr" ? `[stderr] ${chunk}` : chunk;
    const bytes = Buffer.byteLength(tagged);
    outputBytes += bytes;
    outputChunks += 1;
    liveChunks.push(tagged);
    liveBytes += bytes;
    while (liveBytes > maxBytes && liveChunks.length > 1) {
      const dropped = liveChunks.shift()!;
      liveBytes -= Buffer.byteLength(dropped);
      truncated = true;
    }
    currentRun += tagged;
    for (const w of waiters) w.buffered += tagged;
    emitter.emit("output", tagged, source);
  }

  function collectOutput(): string {
    return liveChunks.join("");
  }

  function resolveTerminal(final: SessionState): void {
    setState(final);
    const pending = waiters.splice(0);
    for (const w of pending) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve({ kind: "close", state: final });
    }
    emitter.emit("close", final);
  }

  function onQuestion(question: string): void {
    if (TERMINAL_KINDS.has(state.kind) || state.kind === "killing") return;
    setState({ kind: "waiting_for_reply", question });
    emitter.emit("question", question);
    if (waiters.length > 0) {
      const w = waiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      const out = w.buffered;
      currentRun = "";
      w.resolve({ kind: "question", question, output: out });
    }
  }

  // Stdout: byte buffering must precede line parsing so waiters see the
  // chunk that contains the [QUESTION] marker before the question fires.
  proc.stdout!.on("data", (chunk: Buffer | string) => {
    appendOutput(chunk.toString(), "stdout");
  });
  proc.stderr!.on("data", (chunk: Buffer | string) => {
    appendOutput(chunk.toString(), "stderr");
  });
  const stdoutRl = createInterface({
    input: proc.stdout!,
    crlfDelay: Infinity,
  });
  stdoutRl.on("line", (line) => {
    const match = /^\[QUESTION\] (.+)$/.exec(line);
    if (match) onQuestion(match[1]);
  });

  // Overall timeout
  const timeoutHandle = setTimeout(() => {
    if (TERMINAL_KINDS.has(state.kind)) return;
    terminationReason = "timeout";
    setState({ kind: "killing", reason: "timeout" });
    try {
      proc.kill("SIGTERM");
    } catch {
      // best-effort
    }
  }, opts.timeoutMs);
  if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();

  proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    clearTimeout(timeoutHandle);
    if (TERMINAL_KINDS.has(state.kind)) return;
    const result = collectOutput();
    let final: SessionState;
    if (terminationReason === "timeout") {
      final = { kind: "error", error: "Agent timed out", result };
    } else if (terminationReason === "user") {
      final = { kind: "killed", signal, result };
    } else if (code === 0) {
      final = { kind: "done", exitCode: 0, result };
    } else {
      final = {
        kind: "error",
        error: `Agent exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
        result,
      };
    }
    resolveTerminal(final);
  });

  proc.on("error", (err: Error) => {
    clearTimeout(timeoutHandle);
    if (TERMINAL_KINDS.has(state.kind)) return;
    if (state.kind === "killing") {
      // Expected error from a kill signal — the 'close' event will finalize.
      return;
    }
    resolveTerminal({
      kind: "error",
      error: err.message,
      result: collectOutput(),
    });
  });

  function write(input: string): boolean {
    if (state.kind !== "waiting_for_reply") return false;
    const prev = state;
    state = { kind: "running" };
    const savedRun = currentRun;
    currentRun = "";
    try {
      const stdin = proc.stdin;
      if (!stdin || stdin.writableEnded || stdin.destroyed) {
        throw new Error("stdin not writable");
      }
      stdin.write(input);
      return true;
    } catch {
      state = prev;
      currentRun = savedRun;
      return false;
    }
  }

  function kill(signal?: NodeJS.Signals): boolean {
    if (TERMINAL_KINDS.has(state.kind)) return false;
    const wasKilling = state.kind === "killing";
    let signaled = false;
    try {
      signaled = proc.kill(signal);
    } catch {
      signaled = false;
    }
    if (!signaled) {
      resolveTerminal({
        kind: "killed",
        signal: null,
        result: collectOutput(),
      });
      return false;
    }
    if (!wasKilling) {
      terminationReason = "user";
      setState({ kind: "killing", reason: "user" });
    }
    return true;
  }

  function waitNext(waitOpts?: { timeoutMs?: number }): Promise<WaitResult> {
    if (TERMINAL_KINDS.has(state.kind)) {
      return Promise.resolve({ kind: "close", state });
    }
    if (state.kind === "waiting_for_reply") {
      const out = currentRun;
      currentRun = "";
      return Promise.resolve({
        kind: "question",
        question: state.question,
        output: out,
      });
    }
    return new Promise<WaitResult>((resolve) => {
      const w: PendingWaiter = { buffered: "", resolve };
      if (waitOpts?.timeoutMs !== undefined) {
        w.timer = setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            resolve({ kind: "timeout", output: w.buffered });
          }
        }, waitOpts.timeoutMs);
        if (typeof w.timer.unref === "function") w.timer.unref();
      }
      waiters.push(w);
    });
  }

  function on<K extends keyof ProcessSessionEvents>(
    event: K,
    listener: ProcessSessionEvents[K]
  ): () => void {
    emitter.on(event, listener as (...args: unknown[]) => void);
    return () => {
      emitter.off(event, listener as (...args: unknown[]) => void);
    };
  }

  const session: ProcessSession = {
    agentId: opts.agentId,
    agent: opts.agent,
    task: opts.task,
    startedAt,
    get state() {
      return state;
    },
    get outputBytes() {
      return outputBytes;
    },
    get outputChunks() {
      return outputChunks;
    },
    get truncated() {
      return truncated;
    },
    collectOutput,
    write,
    on,
    waitNext,
    kill,
  };

  return session;
}
