#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnAgentSchema } from "./schemas.js";
import { spawnAgent, listAvailableAgents, parseQuestion } from "./spawn-agent.js";
import { getSession, listSessions, deleteSession } from "./session-store.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "agent-link-mcp",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

function textResult(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], isError };
}

function registerTools(server: McpServer): void {

// ── spawn_agent ───────────────────────────────────────────────────────────────

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

// ── spawn_agents (parallel) ───────────────────────────────────────────────────

server.tool(
  "spawn_agents",
  "Spawn multiple agents in parallel. All agents run concurrently. " +
    "Returns aggregated results including a summary of successes and failures.",
  {
    agents: z
      .array(z.object(spawnAgentSchema))
      .describe("Array of agent spawn configs to run in parallel"),
  },
  async ({ agents }) => {
    const results = await Promise.allSettled(
      agents.map((a) => spawnAgent(a))
    );

    const formatted = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { agent: agents[i].agent, status: "error", error: r.reason?.message ?? "Unknown error" };
    });

    const summary = {
      total: formatted.length,
      succeeded: formatted.filter((r) => r.status === "done").length,
      failed: formatted.filter((r) => r.status === "error").length,
      waiting: formatted.filter((r) => r.status === "waiting_for_reply").length,
    };

    const hasFailures = summary.failed > 0;
    return textResult({ summary, results: formatted }, hasFailures);
  }
);

// ── reply ─────────────────────────────────────────────────────────────────────

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
      return textResult({ error: `No session found for agentId: ${agentId}` }, true);
    }

    if (session.status !== "waiting_for_reply") {
      return textResult(
        { error: `Session ${agentId} is not waiting for a reply (status: ${session.status})` },
        true
      );
    }

    session.status = "running";
    session.pendingQuestion = undefined;
    const outputStart = session.output.length;

    if (!session.process.stdin?.writable) {
      return textResult({ error: `Agent ${agentId} stdin is closed` }, true);
    }
    session.process.stdin.write(`${message}\n`);

    const result = await new Promise<Record<string, unknown>>((resolve) => {
      let resolved = false;

      const stdout = session.process.stdout!;

      const cleanup = () => {
        stdout.off("data", onData);
        session.process.off("close", onClose);
        clearTimeout(timer);
      };

      const collectOutput = () =>
        session.output.slice(outputStart).join("").trim();

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        session.output.push(text);

        if (text.includes("[QUESTION]")) {
          const question = parseQuestion(text);
          session.status = "waiting_for_reply";
          session.pendingQuestion = question;
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({ agentId, status: "waiting_for_reply", question });
          }
        }
      };

      const onClose = (code: number | null) => {
        session.status = code === 0 ? "done" : "error";
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ agentId, status: session.status, result: collectOutput() });
        }
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ agentId, status: "running", partial: collectOutput() });
        }
      }, 30_000);

      stdout.on("data", onData);
      session.process.on("close", onClose);
    });

    return textResult(result);
  }
);

// ── kill_agent ────────────────────────────────────────────────────────────────

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
      return textResult({ error: `Session not found: ${agentId}` }, true);
    }
    session.process.kill(signal);
    deleteSession(agentId);
    return textResult({ agentId, killed: true, signal });
  }
);

// ── list_agents ───────────────────────────────────────────────────────────────

server.tool(
  "list_agents",
  "List all CLI agents that are installed and available on the current system.",
  {},
  async () => {
    const available = await listAvailableAgents();
    return textResult({ available, count: available.length });
  }
);

// ── get_status ────────────────────────────────────────────────────────────────

server.tool(
  "get_status",
  "Get status of all active agent sessions.",
  {},
  async () => {
    const sessions = listSessions().map((s) => ({
      agentId: s.agentId,
      agent: s.agent,
      task: s.task.slice(0, 80) + (s.task.length > 80 ? "…" : ""),
      status: s.status,
      pendingQuestion: s.pendingQuestion,
      startedAt: s.startedAt.toISOString(),
      outputLines: s.output.length,
    }));
    return textResult({ sessions, count: sessions.length });
  }
);

} // end registerTools

// ── Start server (only when run directly) ────────────────────────────────────

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const isMain = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}
