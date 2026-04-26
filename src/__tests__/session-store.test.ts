import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  registerSession,
  getSession,
  listSessions,
  deleteSession,
} from "../session-store.js";
import { createProcessSession, type ProcessSession } from "../process-session.js";

function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    pid: number;
    kill: () => boolean;
  };
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  ee.pid = 1;
  ee.kill = () => true;
  return ee;
}

function makeSession(agentId: string): ProcessSession {
  const child = fakeChild();
  return createProcessSession({
    agentId,
    agent: "claude",
    task: "t",
    command: "x",
    args: [],
    env: {},
    timeoutMs: 60_000,
    spawnImpl: ((_c: string, _a: string[], _o: unknown) => child) as unknown as typeof import("node:child_process").spawn,
  });
}

describe("session-store", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.agentId);
  });

  it("registers and retrieves a session", () => {
    const s = makeSession("test-1");
    registerSession(s);
    expect(getSession("test-1")).toBe(s);
  });

  it("returns undefined for unknown agentId", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("lists all sessions", () => {
    registerSession(makeSession("a"));
    registerSession(makeSession("b"));
    const all = listSessions();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.agentId).sort()).toEqual(["a", "b"]);
  });

  it("deletes a session", () => {
    registerSession(makeSession("del-me"));
    expect(getSession("del-me")).toBeDefined();
    deleteSession("del-me");
    expect(getSession("del-me")).toBeUndefined();
  });

  it("deleting a nonexistent session is a no-op", () => {
    expect(() => deleteSession("ghost")).not.toThrow();
  });
});
