#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnAgentSchema, spawnAgentsBatchSchema } from "./schemas.js";
import { spawnAgent, listAvailableAgents } from "./spawn-agent.js";
import { getSession, listSessions, deleteSession } from "./session-store.js";
import { TERMINAL_KINDS } from "./process-session.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "agent-link-mcp",
    version: "2.0.0",
  });

  registerTools(server);
  return server;
}

function textResult(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], isError };
}

function statusOf(kind: string): string {
  if (kind === "killing") return "running";
  return kind;
}

function registerTools(server: McpServer): void {

server.tool(
  "spawn_agent",
  "Spawn a CLI agent (claude, codex, gemini, aider, or custom) as a subprocess. " +
    "Returns immediately with status 'done', 'waiting_for_reply', or 'error'. " +
    "If status is 'waiting_for_reply', call reply() with the returned agentId.",
  spawnAgentSchema,
  async (input) => {
    const result = await spawnAgent(input);

    const response: Record<string, unknown> = {
      agentId: result.agentId,
      status: result.status,
    };

    if (result.status === "done") response.result = result.result;
    if (result.status === "waiting_for_reply") response.question = result.question;
    if (result.status === "error") response.error = result.error;

    return textResult(response, result.status === "error");
  }
);

server.tool(
  "spawn_agents",
  "Spawn multiple agents in parallel. All agents run concurrently. " +
    "Returns aggregated results including a summary of successes and failures.",
  {
    agents: z
      .array(z.object(spawnAgentSchema))
      .describe("Array of agent spawn configs to run in parallel (1..10)"),
  },
  async ({ agents }) => {
    const parsed = spawnAgentsBatchSchema.safeParse(agents);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return textResult(
        { error: `Invalid spawn_agents.agents: ${issue?.message ?? "must contain 1 to 10 entries"}` },
        true
      );
    }
    const results = await Promise.allSettled(
      parsed.data.map((a) => spawnAgent(a))
    );

    const formatted = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { agent: parsed.data[i].agent, status: "error", error: r.reason?.message ?? "Unknown error" };
    });

    const summary = {
      total: formatted.length,
      succeeded: formatted.filter((r) => r.status === "done").length,
      failed: formatted.filter((r) => r.status === "error").length,
      waiting: formatted.filter((r) => r.status === "waiting_for_reply").length,
    };

    const waitingAgents: string[] = [];
    for (const r of formatted) {
      if (r.status === "waiting_for_reply" && "agentId" in r && typeof r.agentId === "string") {
        waitingAgents.push(r.agentId);
      }
    }

    const hasFailures = summary.failed > 0;
    return textResult({ summary, results: formatted, waitingAgents }, hasFailures);
  }
);

server.tool(
  "reply",
  "Send a reply to an agent that paused with a [QUESTION]. " +
    "Writes the reply to the agent's stdin and waits for the next result or question.",
  {
    agentId: z.string().describe("The agentId returned by spawn_agent"),
    message: z.string().describe("Your reply to the agent's question"),
  },
  async ({ agentId, message }) => {
    const session = getSession(agentId);
    if (!session) {
      return textResult(
        { agentId: null, error: `No session found for agentId: ${agentId}` },
        true
      );
    }

    if (session.state.kind !== "waiting_for_reply") {
      return textResult(
        {
          agentId,
          error: `Session ${agentId} is not waiting for a reply (status: ${statusOf(session.state.kind)})`,
        },
        true
      );
    }

    if (!session.write(`${message}\n`)) {
      return textResult({ agentId, error: `Agent ${agentId} stdin is closed` }, true);
    }

    const r = await session.waitNext({ timeoutMs: 30_000 });
    if (r.kind === "question") {
      return textResult({
        agentId,
        status: "waiting_for_reply",
        question: r.question,
        partial: r.output,
      });
    }
    if (r.kind === "close") {
      const state = r.state;
      const result = "result" in state ? state.result.trim() : "";
      const status = statusOf(state.kind);
      const payload: Record<string, unknown> = { agentId, status, result };
      if (state.kind === "error") payload.error = state.error;
      return textResult(payload);
    }
    // timeout: state remains running; caller can use wait_agent to await next event
    return textResult({ agentId, status: "running", partial: r.output });
  }
);

server.tool(
  "wait_agent",
  "Wait for the next event (question or close) from a running agent without writing to its stdin. " +
    "Use this after a reply timeout to observe the next [QUESTION] or process exit.",
  {
    agentId: z.string().describe("The agentId returned by spawn_agent"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(3_600_000)
      .optional()
      .describe("How long to wait before returning timeout status (default: 30000)"),
  },
  async ({ agentId, timeoutMs }) => {
    const session = getSession(agentId);
    if (!session) {
      return textResult(
        { agentId: null, error: `No session found for agentId: ${agentId}` },
        true
      );
    }
    const r = await session.waitNext({ timeoutMs: timeoutMs ?? 30_000 });
    if (r.kind === "question") {
      return textResult({
        agentId,
        status: "waiting_for_reply",
        question: r.question,
        partial: r.output,
      });
    }
    if (r.kind === "close") {
      const state = r.state;
      const result = "result" in state ? state.result.trim() : "";
      const status = statusOf(state.kind);
      const payload: Record<string, unknown> = { agentId, status, result };
      if (state.kind === "error") payload.error = state.error;
      return textResult(payload);
    }
    return textResult({ agentId, status: "running", partial: r.output });
  }
);

server.tool(
  "kill_agent",
  "Abort a running agent session by its agentId.",
  {
    agentId: z.string(),
    signal: z
      .enum(["SIGTERM", "SIGKILL"])
      .optional()
      .default("SIGTERM")
      .describe("Signal to send (default: SIGTERM)"),
  },
  async ({ agentId, signal }) => {
    const session = getSession(agentId);
    if (!session) {
      return textResult({ agentId: null, error: `Session not found: ${agentId}` }, true);
    }
    const wasTerminal = TERMINAL_KINDS.has(session.state.kind);
    const signaled = session.kill(signal);
    if (wasTerminal) {
      return textResult({
        agentId,
        killed: false,
        signaled: false,
        reason: "already terminal",
        state: session.state.kind,
        signal,
      });
    }
    // Wait for the close to fire so finalState is accurate
    await session.waitNext();
    return textResult({
      agentId,
      killed: signaled,
      signaled,
      finalState: session.state.kind,
      signal,
    });
  }
);

server.tool(
  "list_agents",
  "List all CLI agents that are installed and available on the current system.",
  {},
  async () => {
    const available = await listAvailableAgents();
    return textResult({ available, count: available.length });
  }
);

server.tool(
  "get_status",
  "Get status of all active agent sessions.",
  {},
  async () => {
    const sessions = listSessions().map((s) => {
      const state = s.state;
      const pendingQuestion =
        state.kind === "waiting_for_reply" ? state.question : undefined;
      return {
        agentId: s.agentId,
        agent: s.agent,
        task: s.task.slice(0, 80) + (s.task.length > 80 ? "…" : ""),
        status: statusOf(state.kind),
        pendingQuestion,
        startedAt: s.startedAt.toISOString(),
        outputChunks: s.outputChunks,
        outputBytes: s.outputBytes,
        truncated: s.truncated,
      };
    });
    return textResult({ sessions, count: sessions.length });
  }
);

} // end registerTools

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const isMain = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);

  // Graceful shutdown of any open child processes when the server exits
  const cleanup = () => {
    for (const s of listSessions()) {
      try { s.kill(); } catch { /* best-effort */ }
      deleteSession(s.agentId);
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// Re-export TERMINAL_KINDS for downstream consumers checking session state
export { TERMINAL_KINDS };
