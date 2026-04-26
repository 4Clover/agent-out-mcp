import { describe, it, expect, beforeEach } from "vitest";
import { ChildProcess } from "node:child_process";
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
} from "../session-store.js";

function fakeProcess(): ChildProcess {
  return { pid: 1234, kill: () => true } as unknown as ChildProcess;
}

describe("session-store", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.agentId);
  });

  it("creates and retrieves a session", () => {
    const session = createSession({
      agentId: "test-1",
      agent: "claude",
      task: "hello",
      process: fakeProcess(),
      status: "running",
    });

    expect(session.agentId).toBe("test-1");
    expect(session.output).toEqual([]);
    expect(session.startedAt).toBeInstanceOf(Date);

    const retrieved = getSession("test-1");
    expect(retrieved).toBe(session);
  });

  it("returns undefined for unknown agentId", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("lists all sessions", () => {
    createSession({ agentId: "a", agent: "claude", task: "t1", process: fakeProcess(), status: "running" });
    createSession({ agentId: "b", agent: "codex", task: "t2", process: fakeProcess(), status: "done" });

    const all = listSessions();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.agentId).sort()).toEqual(["a", "b"]);
  });

  it("deletes a session", () => {
    createSession({ agentId: "del-me", agent: "claude", task: "x", process: fakeProcess(), status: "running" });
    expect(getSession("del-me")).toBeDefined();

    deleteSession("del-me");
    expect(getSession("del-me")).toBeUndefined();
  });

  it("deleting a nonexistent session is a no-op", () => {
    expect(() => deleteSession("ghost")).not.toThrow();
  });
});
