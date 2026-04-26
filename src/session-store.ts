import { TERMINAL_KINDS, type ProcessSession } from "./process-session.js";

const TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 50;

const sessions = new Map<string, ProcessSession>();
const timers = new Map<string, NodeJS.Timeout>();

function scheduleEviction(agentId: string): void {
  if (timers.has(agentId)) return;
  const t = setTimeout(() => {
    sessions.delete(agentId);
    timers.delete(agentId);
  }, TTL_MS);
  if (typeof t.unref === "function") t.unref();
  timers.set(agentId, t);
}

function activeCount(): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (!TERMINAL_KINDS.has(s.state.kind)) n++;
  }
  return n;
}

export function registerSession(session: ProcessSession): void {
  if (activeCount() >= MAX_SESSIONS) {
    throw new Error(`Session limit reached (${MAX_SESSIONS} active sessions)`);
  }
  sessions.set(session.agentId, session);
  // If somehow registered after the process is already terminal, evict.
  if (TERMINAL_KINDS.has(session.state.kind)) {
    scheduleEviction(session.agentId);
    return;
  }
  session.on("close", () => scheduleEviction(session.agentId));
}

export function getSession(agentId: string): ProcessSession | undefined {
  return sessions.get(agentId);
}

export function listSessions(): ProcessSession[] {
  return Array.from(sessions.values());
}

export function deleteSession(agentId: string): void {
  const t = timers.get(agentId);
  if (t) {
    clearTimeout(t);
    timers.delete(agentId);
  }
  sessions.delete(agentId);
}
