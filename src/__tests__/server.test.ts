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
    execFileSync: vi.fn(() => Buffer.from("/usr/bin/mock")),
  };
});

const { spawn, execFileSync } = vi.mocked(child_process);

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
    it("registers exactly 6 tools", async () => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
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
    it("returns error for nonexistent session", async () => {
      const result = await client.callTool({
        name: "reply",
        arguments: { agentId: "ghost-123", message: "hello" },
      });
      const data = parseResult(result as any);
      expect(data.error).toMatch(/No session found/);
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
      vi.mocked(execFileSync).mockReturnValue(Buffer.from("/usr/bin/mock"));
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
      expect(session).toHaveProperty("outputLines");
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
});
