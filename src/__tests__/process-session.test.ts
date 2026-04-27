import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  createProcessSession,
  TERMINAL_KINDS,
  type SessionState,
} from "../process-session.js";

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  killed: boolean;
  pid: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeFakeChild(opts: { killReturns?: boolean } = {}): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  const stdinWrites: string[] = [];
  ee.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinWrites.push(chunk.toString());
      cb();
    },
  });
  (ee as unknown as { stdinWrites: string[] }).stdinWrites = stdinWrites;
  ee.killed = false;
  ee.pid = 1234;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = (_signal?: NodeJS.Signals | number) => {
    if (opts.killReturns === false) return false;
    ee.killed = true;
    return true;
  };
  return ee;
}

function makeSpawnImpl(child: FakeChild) {
  return ((_cmd: string, _args: string[], _options: unknown) => child) as unknown as typeof import("node:child_process").spawn;
}

const baseOpts = {
  agentId: "test-1",
  agent: "claude",
  task: "do work",
  command: "echo",
  args: ["hi"],
  env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
  timeoutMs: 60_000,
};

function close(child: FakeChild, code: number, signal: NodeJS.Signals | null = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.stdout.end();
  child.stderr.end();
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

describe("ProcessSession - basic spawn", () => {
  it("invokes spawnImpl with the supplied command, args, cwd and env", () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);
    createProcessSession({
      ...baseOpts,
      cwd: "/tmp",
      env: { CUSTOM: "1" } as NodeJS.ProcessEnv,
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnImpl.mock.calls[0];
    expect(cmd).toBe("echo");
    expect(args).toEqual(["hi"]);
    const opt = options as { cwd?: string; env: NodeJS.ProcessEnv };
    expect(opt.cwd).toBe("/tmp");
    expect(opt.env).toEqual({ CUSTOM: "1" });
  });

  it("starts in running state", () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    expect(session.state.kind).toBe("running");
  });
});

describe("ProcessSession - [QUESTION] line parser", () => {
  it("emits 'question' event for a complete-line marker", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const seen: string[] = [];
    session.on("question", (q) => seen.push(q));
    child.stdout.write("[QUESTION] foo\n");
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["foo"]);
    expect(session.state.kind).toBe("waiting_for_reply");
  });

  it("triggers exactly one 'question' event when [QUESTION] is split across two chunks", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const seen: string[] = [];
    session.on("question", (q) => seen.push(q));
    child.stdout.write("[QUESTI");
    await new Promise((r) => setImmediate(r));
    child.stdout.write("ON] foo\n");
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["foo"]);
  });

  it("does not trigger when [QUESTION] appears mid-line", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const seen: string[] = [];
    session.on("question", (q) => seen.push(q));
    child.stdout.write("prefix [QUESTION] inline\n");
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([]);
  });

  it("handles CRLF line endings without including CR in the question", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const seen: string[] = [];
    session.on("question", (q) => seen.push(q));
    child.stdout.write("[QUESTION] foo\r\n");
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["foo"]);
  });
});

describe("ProcessSession - waitNext / write round-trips", () => {
  it("question -> write -> question round-trip with FIFO waiters", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });

    const w1 = session.waitNext();
    child.stdout.write("[QUESTION] a\n");
    const r1 = await w1;
    expect(r1.kind).toBe("question");
    if (r1.kind === "question") expect(r1.question).toBe("a");

    expect(session.write("answer\n")).toBe(true);
    expect(session.state.kind).toBe("running");

    const w2 = session.waitNext();
    child.stdout.write("[QUESTION] b\n");
    const r2 = await w2;
    expect(r2.kind).toBe("question");
    if (r2.kind === "question") expect(r2.question).toBe("b");
  });

  it("waitNext fast path: resolves immediately if state is already waiting_for_reply", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    child.stdout.write("[QUESTION] a\n");
    await new Promise((r) => setImmediate(r));
    const r = await session.waitNext();
    expect(r.kind).toBe("question");
    if (r.kind === "question") expect(r.question).toBe("a");
  });

  it("waitNext returns output captured during that call only (no duplicates)", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const p = session.waitNext();
    child.stdout.write("hello\n");
    child.stdout.write("[QUESTION] q1\n");
    const r = await p;
    expect(r.kind).toBe("question");
    if (r.kind === "question") {
      expect(r.output).toBe("hello\n[QUESTION] q1\n");
    }
  });

  it("write rolls back state if stdin throws", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    child.stdout.write("[QUESTION] a\n");
    await new Promise((r) => setImmediate(r));
    expect(session.state.kind).toBe("waiting_for_reply");
    // Destroy stdin so write() throws
    child.stdin.destroy();
    const ok = session.write("answer\n");
    expect(ok).toBe(false);
    expect(session.state.kind).toBe("waiting_for_reply");
  });

  it("waitNext({ timeoutMs }) returns kind: 'timeout' without changing state", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const session = createProcessSession({
        ...baseOpts,
        spawnImpl: makeSpawnImpl(child),
      });
      const p = session.waitNext({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      const r = await p;
      expect(r.kind).toBe("timeout");
      expect(session.state.kind).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProcessSession - byte cap", () => {
  it("truncates oldest chunks once budget is exceeded", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      maxOutputBytes: 100,
      spawnImpl: makeSpawnImpl(child),
    });
    // Write 200 bytes total in two 100-byte chunks
    child.stdout.write("a".repeat(100) + "\n");
    child.stdout.write("b".repeat(100) + "\n");
    await new Promise((r) => setImmediate(r));
    expect(session.outputBytes).toBeGreaterThanOrEqual(200);
    expect(session.truncated).toBe(true);
    expect(session.collectOutput().length).toBeLessThanOrEqual(150);
  });
});

describe("ProcessSession - terminal-state guarantees", () => {
  it("resolves on 'close', not 'exit'", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const p = session.waitNext();
    child.stdout.end();
    child.emit("exit", 0, null);
    // 'close' has not fired yet
    await new Promise((r) => setImmediate(r));
    expect(session.state.kind).toBe("running");
    child.emit("close", 0, null);
    const r = await p;
    expect(r.kind).toBe("close");
    if (r.kind === "close") expect(r.state.kind).toBe("done");
  });

  it("timeout transitions to error and a later close 0 does NOT downgrade to done", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const session = createProcessSession({
        ...baseOpts,
        timeoutMs: 100,
        spawnImpl: makeSpawnImpl(child),
      });
      const p = session.waitNext();
      await vi.advanceTimersByTimeAsync(150);
      // Simulate late close 0 after timeout
      close(child, 0, null);
      const r = await p;
      expect(r.kind).toBe("close");
      expect(session.state.kind).toBe("error");
      if (session.state.kind === "error") {
        expect(session.state.error).toMatch(/time/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("kill while running returns true and finalizes to killed on close", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const p = session.waitNext();
    expect(session.kill("SIGTERM")).toBe(true);
    expect(session.state.kind).toBe("killing");
    close(child, 0, "SIGTERM");
    const r = await p;
    expect(r.kind).toBe("close");
    expect(session.state.kind).toBe("killed");
  });

  it("kill on already-terminal session returns false and does not change state", async () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    close(child, 0, null);
    await new Promise((r) => setImmediate(r));
    expect(session.state.kind).toBe("done");
    expect(session.kill()).toBe(false);
    expect(session.state.kind).toBe("done");
  });

  it("kill of already-exited process (proc.kill returns false) finalizes synchronously to killed", () => {
    const child = makeFakeChild({ killReturns: false });
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    const ok = session.kill();
    expect(ok).toBe(false);
    expect(session.state.kind).toBe("killed");
  });

  it("write returns false once stdin is ended", () => {
    const child = makeFakeChild();
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    child.stdout.write("[QUESTION] q\n");
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        child.stdin.end();
        const ok = session.write("answer\n");
        expect(ok).toBe(false);
        resolve();
      });
    });
  });
});

describe("ProcessSession - kill() ordering", () => {
  it("sets terminationReason before sending the signal", async () => {
    const child = makeFakeChild();
    let stateAtKillTime: SessionState | null = null;
    child.kill = (_signal?: NodeJS.Signals | number) => {
      stateAtKillTime = session.state;
      child.killed = true;
      return true;
    };
    const session = createProcessSession({
      ...baseOpts,
      spawnImpl: makeSpawnImpl(child),
    });
    session.kill("SIGTERM");
    expect(stateAtKillTime).not.toBeNull();
    expect(stateAtKillTime!.kind).toBe("killing");
  });
});

describe("ProcessSession - currentRun cap", () => {
  it("caps currentRun to maxOutputBytes so it does not grow unboundedly", async () => {
    const child = makeFakeChild();
    const maxBytes = 200;
    const session = createProcessSession({
      ...baseOpts,
      maxOutputBytes: maxBytes,
      spawnImpl: makeSpawnImpl(child),
    });
    const p = session.waitNext();
    // Write 500 bytes of output, then a question
    child.stdout.write("x".repeat(500));
    child.stdout.write("\n[QUESTION] q\n");
    const r = await p;
    expect(r.kind).toBe("question");
    if (r.kind === "question") {
      expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(maxBytes + 100);
    }
  });
});

describe("ProcessSession - TERMINAL_KINDS exported", () => {
  it("exports the terminal-kind set", () => {
    expect(TERMINAL_KINDS.has("done")).toBe(true);
    expect(TERMINAL_KINDS.has("error")).toBe(true);
    expect(TERMINAL_KINDS.has("killed")).toBe(true);
    expect(TERMINAL_KINDS.has("running")).toBe(false);
    expect(TERMINAL_KINDS.has("waiting_for_reply")).toBe(false);
    expect(TERMINAL_KINDS.has("killing")).toBe(false);
  });
});
