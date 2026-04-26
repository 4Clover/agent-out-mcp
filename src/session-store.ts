import type { ProcessSession } from "./process-session.js";

const sessions = new Map<string, ProcessSession>();

export function registerSession(session: ProcessSession): void {
  sessions.set(session.agentId, session);
}

export function getSession(agentId: string): ProcessSession | undefined {
  return sessions.get(agentId);
}

export function listSessions(): ProcessSession[] {
  return Array.from(sessions.values());
}

export function deleteSession(agentId: string): void {
  sessions.delete(agentId);
}
