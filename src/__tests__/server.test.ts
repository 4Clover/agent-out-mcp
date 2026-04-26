import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../index.js";
import { listSessions, deleteSession } from "../session-store.js";
import * as child_process from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

// ── Mock child_process to prevent spawning real CLIs ─────────────────────────

interface FakeProcOpts {
  stdout?: string;
  exitCode?: number;
  question?: string;
  emitError?: Error;
  splitQuestion?: boolean;
}

function createFakeProcess(opts?: FakeProcOpts) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };

  proc.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = 9999;
  proc.kill = vi.fn(() => {
    queueMicrotask(() => {
      stdout.end();
      stderr.end();
      proc.emit("close", null, "SIGTERM");
    });
    return true;
  });

  queueMicrotask(() => {
    if (opts?.emitError) {
      proc.emit("error", opts.emitError);
      return;
    }
    if (opts?.question) {
      if (opts.splitQuestion) {
        // Split [QUESTION] across two chunks to exercise the cross-chunk parser
        stdout.write("[QUESTI");
        queueMicrotask(() => {
          stdout.write(`ON] ${opts.question}\n`);
        });
      } else {
        stdout.write(`[QUESTION] ${opts.question}\n`);
      }
    } else if (opts?.stdout !== undefined) {
      stdout.write(opts.stdout);
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        proc.emit("close", opts?.exitCode ?? 0, null);
      });
    } else {
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        proc.emit("close", opts?.exitCode ?? 0, null);
      });
    }
  });

  return proc;
}

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof child_process>();
  return {
    ...original,
    spawn: vi.fn(() => createFakeProcess({ stdout: "mock output\n", exitCode: 0 })),
  };
});

vi.mock("which", () => ({
  default: vi.fn(async () => "/usr/bin/mock"),
}));

const { spawn } = vi.mocked(child_process);

interface InteractiveCtrl {
  proc: EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  stdinChunks: string[];
  sendQuestion: (q: string) => void;
  sendOutput: (text: string) => void;
  close: (code: number, signal?: NodeJS.Signals | null) => void;
}

function createInteractive(opts: { killReturns?: boolean } = {}): InteractiveCtrl {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinChunks: string[] = [];
  const proc = new EventEmitter() as InteractiveCtrl["proc"];
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = 1234;
  proc.kill = vi.fn(() => {
    if (opts.killReturns === false) return false;
    queueMicrotask(() => {
      stdout.end();
      stderr.end();
      proc.emit("close", null, "SIGTERM");
    });
    return true;
  });
  return {
    proc,
    stdinChunks,
    sendQuestion: (q) => stdout.write(`[QUESTION] ${q}\n`),
    sendOutput: (t) => stdout.write(t),
    close: (code, signal = null) => {
      stdout.end();
      stderr.end();
      proc.emit("close", code, signal);
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseResult(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content[0];
  if (text.type === "text" && text.text) return JSON.parse(text.text);
  throw new Error("unexpected content type");
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("MCP server tools", () => {
  let client: Client;
  let serverCleanup: () => Promise<void>;

  beforeAll(async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    serverCleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    for (const s of listSessions()) {
      try { s.kill(); } catch { /* best-effort cleanup */ }
      deleteSession(s.agentId);
    }
    await serverCleanup();
  });

  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.agentId);
    vi.mocked(spawn).mockImplementation(() =>
      createFakeProcess({ stdout: "mock output\n", exitCode: 0 }) as unknown as child_process.ChildProcess
    );
  });

  describe("tool listing", () => {
    it("registers exactly 7 tools", async () => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
    });

    it("registers all expected tool names", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "get_status",
        "kill_agent",
        "list_agents",
        "reply",
        "spawn_agent",
        "spawn_agents",
        "wait_agent",
      ]);
    });

    it("each tool has a description and inputSchema", async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  describe("spawn_agent", () => {
    it("spawns an agent and returns done status", async () => {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "say hello" },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("done");
      expect(data.agentId).toMatch(/^claude-[0-9a-f]{16}$/);
      expect(data.result).toBe("mock output");
    });

    it("uses lowercased agent name in agentId even when input is uppercase", async () => {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "Claude", task: "hi" },
      });
      const data = parseResult(result as any);
      expect(data.agentId).toMatch(/^claude-[0-9a-f]{16}$/);
    });

    it("returns error for unknown agent", async () => {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "nonexistent", task: "x" },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("error");
      expect(data.error).toMatch(/Unknown agent/);
      expect(result.isError).toBe(true);
    });

    it("returns error when process exits non-zero", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ exitCode: 1 }) as unknown as child_process.ChildProcess
      );
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "fail" },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("error");
      expect(data.error).toMatch(/exited with code 1/);
    });

    it("returns waiting_for_reply when process asks a question", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ question: "What file should I edit?" }) as unknown as child_process.ChildProcess
      );
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "edit something" },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("waiting_for_reply");
      expect(data.question).toBe("What file should I edit?");
    });

    it("detects [QUESTION] split across stdout chunks", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ question: "Cross-chunk question?", splitQuestion: true }) as unknown as child_process.ChildProcess
      );
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "split test" },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("waiting_for_reply");
      expect(data.question).toBe("Cross-chunk question?");
    });

    it("returns error when spawn itself fails", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ emitError: new Error("ENOENT") }) as unknown as child_process.ChildProcess
      );
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "boom" },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("error");
      expect(data.error).toBe("ENOENT");
    });

    it("passes optional context, model, and thinking params via flagMap", async () => {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: {
          agent: "claude",
          task: "analyze code",
          context: { files: ["src/index.ts"], intent: "review" },
          model: "sonnet",
          thinking: "high",
        },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("done");
      expect(spawn).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls.at(-1)!;
      const args = spawnArgs[1] as string[];
      expect(args).toContain("--model");
      expect(args).toContain("sonnet");
      expect(args).toContain("--thinking");
      expect(args).toContain("high");
    });
  });

  describe("spawn_agents", () => {
    it("spawns multiple agents in parallel", async () => {
      const result = await client.callTool({
        name: "spawn_agents",
        arguments: {
          agents: [
            { agent: "claude", task: "task one" },
            { agent: "claude", task: "task two" },
          ],
        },
      });
      const data = parseResult(result as any);
      expect(data.summary.total).toBe(2);
      expect(data.summary.succeeded).toBe(2);
      expect(data.results).toHaveLength(2);
    });

    it("reports mixed results correctly", async () => {
      let callCount = 0;
      vi.mocked(spawn).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return createFakeProcess({ stdout: "ok\n", exitCode: 0 }) as unknown as child_process.ChildProcess;
        return createFakeProcess({ exitCode: 1 }) as unknown as child_process.ChildProcess;
      });

      const result = await client.callTool({
        name: "spawn_agents",
        arguments: {
          agents: [
            { agent: "claude", task: "success" },
            { agent: "claude", task: "failure" },
          ],
        },
      });
      const data = parseResult(result as any);
      expect(data.summary.succeeded).toBe(1);
      expect(data.summary.failed).toBe(1);
      expect(result.isError).toBe(true);
    });

    it("handles unknown agents in the batch", async () => {
      const result = await client.callTool({
        name: "spawn_agents",
        arguments: {
          agents: [
            { agent: "nonexistent", task: "x" },
          ],
        },
      });
      const data = parseResult(result as any);
      expect(data.summary.failed).toBe(1);
      expect(data.results[0].error).toMatch(/Unknown agent/);
    });
  });

  describe("reply", () => {
    it("returns error with agentId: null for nonexistent session", async () => {
      const result = await client.callTool({
        name: "reply",
        arguments: { agentId: "ghost-123", message: "hello" },
      });
      const data = parseResult(result as any);
      expect(data.error).toMatch(/No session found/);
      expect(data.agentId).toBeNull();
      expect(result.isError).toBe(true);
    });

    it("returns error when session is not waiting_for_reply", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ stdout: "done\n", exitCode: 0 }) as unknown as child_process.ChildProcess
      );
      const spawnResult = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "done task" },
      });
      const { agentId } = parseResult(spawnResult as any);

      const result = await client.callTool({
        name: "reply",
        arguments: { agentId, message: "reply to done" },
      });
      const data = parseResult(result as any);
      expect(data.error).toMatch(/not waiting for a reply/);
    });
  });

  describe("kill_agent", () => {
    it("returns error for nonexistent session", async () => {
      const result = await client.callTool({
        name: "kill_agent",
        arguments: { agentId: "nope-abc" },
      });
      const data = parseResult(result as any);
      expect(data.error).toMatch(/Session not found/);
      expect(result.isError).toBe(true);
    });

    it("kills a running session", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ question: "waiting?" }) as unknown as child_process.ChildProcess
      );
      const spawnResult = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "long task" },
      });
      const { agentId } = parseResult(spawnResult as any);

      const result = await client.callTool({
        name: "kill_agent",
        arguments: { agentId },
      });
      const data = parseResult(result as any);
      expect(data.killed).toBe(true);
      expect(data.signal).toBe("SIGTERM");
    });

    it("accepts SIGKILL signal", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ question: "?" }) as unknown as child_process.ChildProcess
      );
      const spawnResult = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "stuck" },
      });
      const { agentId } = parseResult(spawnResult as any);

      const result = await client.callTool({
        name: "kill_agent",
        arguments: { agentId, signal: "SIGKILL" },
      });
      const data = parseResult(result as any);
      expect(data.signal).toBe("SIGKILL");
    });
  });

  describe("list_agents", () => {
    it("returns a list of available agents", async () => {
      const result = await client.callTool({
        name: "list_agents",
        arguments: {},
      });
      const data = parseResult(result as any);
      expect(data.available).toBeInstanceOf(Array);
      expect(data.count).toBe(data.available.length);
    });

    it("includes all defaults when all commands are on PATH", async () => {
      const result = await client.callTool({
        name: "list_agents",
        arguments: {},
      });
      const data = parseResult(result as any);
      expect(data.available).toContain("claude");
      expect(data.available).toContain("codex");
      expect(data.available).toContain("gemini");
      expect(data.available).toContain("aider");
    });
  });

  describe("get_status", () => {
    it("returns empty when no sessions exist", async () => {
      const result = await client.callTool({
        name: "get_status",
        arguments: {},
      });
      const data = parseResult(result as any);
      expect(data.sessions).toEqual([]);
      expect(data.count).toBe(0);
    });

    it("returns active sessions with expected shape", async () => {
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ question: "??" }) as unknown as child_process.ChildProcess
      );
      await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "status test task" },
      });

      const result = await client.callTool({
        name: "get_status",
        arguments: {},
      });
      const data = parseResult(result as any);
      expect(data.count).toBe(1);
      const session = data.sessions[0];
      expect(session).toHaveProperty("agentId");
      expect(session).toHaveProperty("agent", "claude");
      expect(session).toHaveProperty("status", "waiting_for_reply");
      expect(session).toHaveProperty("startedAt");
      expect(session).toHaveProperty("outputChunks");
      expect(session).toHaveProperty("outputBytes");
      expect(session).toHaveProperty("truncated");
      expect(session).not.toHaveProperty("outputLines");
      expect(session.task).toContain("status test task");
    });

    it("truncates long tasks to 80 chars", async () => {
      const longTask = "x".repeat(120);
      vi.mocked(spawn).mockImplementation(() =>
        createFakeProcess({ stdout: "ok\n", exitCode: 0 }) as unknown as child_process.ChildProcess
      );
      await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: longTask },
      });

      const result = await client.callTool({
        name: "get_status",
        arguments: {},
      });
      const data = parseResult(result as any);
      if (data.count > 0) {
        expect(data.sessions[0].task.length).toBeLessThanOrEqual(81);
      }
    });
  });

  describe("schema validation", () => {
    it("returns error for spawn_agent without required agent field", async () => {
      const result = await client.callTool({ name: "spawn_agent", arguments: { task: "hello" } });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/invalid/i);
    });

    it("returns error for spawn_agent without required task field", async () => {
      const result = await client.callTool({ name: "spawn_agent", arguments: { agent: "claude" } });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/invalid/i);
    });

    it("returns error for spawn_agent with invalid thinking value", async () => {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "x", thinking: "extreme" },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/invalid/i);
    });

    it("returns error for kill_agent with invalid signal", async () => {
      const result = await client.callTool({
        name: "kill_agent",
        arguments: { agentId: "x", signal: "SIGFOO" },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/invalid/i);
    });

    it("returns error for reply without message", async () => {
      const result = await client.callTool({ name: "reply", arguments: { agentId: "x" } });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/invalid/i);
    });

    it("returns error for spawn_agents with non-array agents", async () => {
      const result = await client.callTool({
        name: "spawn_agents",
        arguments: { agents: "not an array" },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/invalid/i);
    });
  });

  describe("response shape", () => {
    it("all tools return content array with text type", async () => {
      const tools = ["list_agents", "get_status"];
      for (const name of tools) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.content).toBeInstanceOf(Array);
        expect(result.content.length).toBeGreaterThan(0);
        expect((result.content[0] as any).type).toBe("text");
        expect(() => JSON.parse((result.content[0] as any).text)).not.toThrow();
      }
    });

    it("error results have isError set to true", async () => {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "nonexistent", task: "x" },
      });
      expect(result.isError).toBe(true);
    });

    it("success results do not have isError true", async () => {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "ok" },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ── Step 4: reply / kill / wait_agent contracts ──────────────────────────

  describe("reply round-trip and timeout (Step 4)", () => {
    it("reply forwards stdin and returns the next question with exact captured output", async () => {
      const ctrl = createInteractive();
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => ctrl.sendQuestion("first?"));
        return ctrl.proc as unknown as child_process.ChildProcess;
      });
      const spawnRes = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "interactive" },
      });
      const { agentId } = parseResult(spawnRes as any);

      const replyPromise = client.callTool({
        name: "reply",
        arguments: { agentId, message: "answer1" },
      });
      // Drive the next question after the reply has written stdin
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      ctrl.sendOutput("interim\n");
      ctrl.sendQuestion("second?");
      const replyResult = await replyPromise;
      const data = parseResult(replyResult as any);
      expect(data.status).toBe("waiting_for_reply");
      expect(data.question).toBe("second?");
      expect(data.partial).toBe("interim\n[QUESTION] second?\n");
      expect(ctrl.stdinChunks.join("")).toBe("answer1\n");
    });

    it("reply against unknown agentId returns agentId: null and isError", async () => {
      const result = await client.callTool({
        name: "reply",
        arguments: { agentId: "ghost-xyz", message: "hi" },
      });
      const data = parseResult(result as any);
      expect(data.agentId).toBeNull();
      expect(result.isError).toBe(true);
    });

    it("reply timeout returns running and a follow-up reply fails because state is no longer waiting", async () => {
      vi.useFakeTimers();
      try {
        const ctrl = createInteractive();
        vi.mocked(spawn).mockImplementationOnce(() => {
          queueMicrotask(() => ctrl.sendQuestion("q1"));
          return ctrl.proc as unknown as child_process.ChildProcess;
        });
        const spawnRes = await client.callTool({
          name: "spawn_agent",
          arguments: { agent: "claude", task: "interactive" },
        });
        const { agentId } = parseResult(spawnRes as any);

        const replyPromise = client.callTool({
          name: "reply",
          arguments: { agentId, message: "answer" },
        });
        await vi.advanceTimersByTimeAsync(31_000);
        const replyResult = await replyPromise;
        const data = parseResult(replyResult as any);
        expect(data.status).toBe("running");

        // A second reply must fail because state did not flip back to waiting_for_reply
        const second = await client.callTool({
          name: "reply",
          arguments: { agentId, message: "another" },
        });
        const secondData = parseResult(second as any);
        expect(secondData.error).toMatch(/not waiting for a reply/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("wait_agent (Step 4)", () => {
    it("returns immediately for a terminal session", async () => {
      vi.mocked(spawn).mockImplementationOnce(() =>
        createFakeProcess({ stdout: "ok\n", exitCode: 0 }) as unknown as child_process.ChildProcess
      );
      const spawnRes = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "quick" },
      });
      const { agentId } = parseResult(spawnRes as any);

      const result = await client.callTool({
        name: "wait_agent",
        arguments: { agentId },
      });
      const data = parseResult(result as any);
      expect(data.status).toBe("done");
      expect(data.result).toBe("ok");
    });

    it("returns error for unknown agentId with agentId: null", async () => {
      const result = await client.callTool({
        name: "wait_agent",
        arguments: { agentId: "ghost-xyz" },
      });
      const data = parseResult(result as any);
      expect(data.agentId).toBeNull();
      expect(result.isError).toBe(true);
    });

    it("resumes after a reply timeout and observes the next question", async () => {
      vi.useFakeTimers();
      try {
        const ctrl = createInteractive();
        vi.mocked(spawn).mockImplementationOnce(() => {
          queueMicrotask(() => ctrl.sendQuestion("q1"));
          return ctrl.proc as unknown as child_process.ChildProcess;
        });
        const spawnRes = await client.callTool({
          name: "spawn_agent",
          arguments: { agent: "claude", task: "long" },
        });
        const { agentId } = parseResult(spawnRes as any);

        // Trigger reply timeout
        const replyP = client.callTool({
          name: "reply",
          arguments: { agentId, message: "ans" },
        });
        await vi.advanceTimersByTimeAsync(31_000);
        await replyP;

        // wait_agent should still pick up the next question
        const waitP = client.callTool({
          name: "wait_agent",
          arguments: { agentId, timeoutMs: 5_000 },
        });
        // Send the late question
        await vi.advanceTimersByTimeAsync(10);
        ctrl.sendQuestion("q2");
        const result = await waitP;
        const data = parseResult(result as any);
        expect(data.status).toBe("waiting_for_reply");
        expect(data.question).toBe("q2");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Step 6: spawn_agents batch limits + waitingAgents", () => {
    it("rejects empty batch (zero agents)", async () => {
      const result = await client.callTool({
        name: "spawn_agents",
        arguments: { agents: [] },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/invalid|at least|min/i);
    });

    it("rejects batch larger than 10 with a max-count message", async () => {
      const agents = Array(11).fill({ agent: "claude", task: "x" });
      const result = await client.callTool({
        name: "spawn_agents",
        arguments: { agents },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/10|max/i);
    });

    it("response includes waitingAgents array listing only the paused agentIds", async () => {
      let n = 0;
      vi.mocked(spawn).mockImplementation(() => {
        n++;
        if (n === 1) {
          return createFakeProcess({ stdout: "ok\n", exitCode: 0 }) as unknown as child_process.ChildProcess;
        }
        return createFakeProcess({ question: "?" }) as unknown as child_process.ChildProcess;
      });
      const result = await client.callTool({
        name: "spawn_agents",
        arguments: {
          agents: [
            { agent: "claude", task: "fast" },
            { agent: "claude", task: "pause" },
            { agent: "claude", task: "pause2" },
          ],
        },
      });
      const data = parseResult(result as any);
      expect(Array.isArray(data.waitingAgents)).toBe(true);
      expect(data.waitingAgents).toHaveLength(2);
      for (const id of data.waitingAgents) {
        expect(id).toMatch(/^claude-[0-9a-f]{16}$/);
      }
    });
  });

  describe("Step 6: get_status output reporting", () => {
    it("reports outputBytes for accumulated output", async () => {
      vi.mocked(spawn).mockImplementationOnce(() =>
        createFakeProcess({ question: "?" }) as unknown as child_process.ChildProcess
      );
      await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "byte test" },
      });
      const result = await client.callTool({
        name: "get_status",
        arguments: {},
      });
      const data = parseResult(result as any);
      const session = data.sessions[0];
      expect(typeof session.outputBytes).toBe("number");
      expect(session.outputBytes).toBeGreaterThan(0);
      expect(session.truncated).toBe(false);
    });
  });

  describe("kill_agent contract (Step 4)", () => {
    it("kill of a still-running session returns killed: true and signaled: true", async () => {
      const ctrl = createInteractive();
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => ctrl.sendQuestion("?"));
        return ctrl.proc as unknown as child_process.ChildProcess;
      });
      const spawnRes = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "long" },
      });
      const { agentId } = parseResult(spawnRes as any);

      const killRes = await client.callTool({
        name: "kill_agent",
        arguments: { agentId },
      });
      const data = parseResult(killRes as any);
      expect(data.killed).toBe(true);
      expect(data.signaled).toBe(true);
      expect(data.signal).toBe("SIGTERM");
    });

    it("kill of an already-done session returns killed: false with reason: already terminal", async () => {
      vi.mocked(spawn).mockImplementationOnce(() =>
        createFakeProcess({ stdout: "ok\n", exitCode: 0 }) as unknown as child_process.ChildProcess
      );
      const spawnRes = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "fast" },
      });
      const { agentId } = parseResult(spawnRes as any);
      // Session is now done
      const killRes = await client.callTool({
        name: "kill_agent",
        arguments: { agentId },
      });
      const data = parseResult(killRes as any);
      expect(data.killed).toBe(false);
      expect(data.reason).toBe("already terminal");
      expect(data.state).toBe("done");
    });

    it("kill where proc.kill returns false reports killed: false, signaled: false", async () => {
      const ctrl = createInteractive({ killReturns: false });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => ctrl.sendQuestion("?"));
        return ctrl.proc as unknown as child_process.ChildProcess;
      });
      const spawnRes = await client.callTool({
        name: "spawn_agent",
        arguments: { agent: "claude", task: "ghost" },
      });
      const { agentId } = parseResult(spawnRes as any);

      const killRes = await client.callTool({
        name: "kill_agent",
        arguments: { agentId },
      });
      const data = parseResult(killRes as any);
      expect(data.killed).toBe(false);
      expect(data.signaled).toBe(false);
    });
  });
});
