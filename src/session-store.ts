import { ChildProcess } from "node:child_process";

export interface AgentSession {
  agentId: string;
  agent: string;
  task: string;
  process: ChildProcess;
  status: "running" | "waiting_for_reply" | "done" | "error";
  pendingQuestion?: string;
  output: string[];
  startedAt: Date;
}

// In-memory session store (lives for the duration of the MCP server process)
const sessions = new Map<string, AgentSession>();

export function createSession(partial: Omit<AgentSession, "output" | "startedAt">): AgentSession {
  const session: AgentSession = {
    ...partial,
    output: [],
    startedAt: new Date(),
  };
  sessions.set(session.agentId, session);
  return session;
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
