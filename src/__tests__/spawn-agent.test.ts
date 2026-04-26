import { describe, it, expect } from "vitest";
import { parseQuestion, resolveAgentConfig, spawnAgent } from "../spawn-agent.js";

describe("parseQuestion", () => {
  it("extracts question text after [QUESTION] marker", () => {
    expect(parseQuestion("some output [QUESTION] What file?\nmore")).toBe("What file?");
  });

  it("handles [QUESTION] at start of string", () => {
    expect(parseQuestion("[QUESTION] Are you sure?")).toBe("Are you sure?");
  });

  it("returns trimmed input when no text after marker", () => {
    expect(parseQuestion("[QUESTION] ")).toBe("");
  });

  it("returns trimmed full text when marker has no split content", () => {
    expect(parseQuestion("no marker here")).toBe("no marker here");
  });
});

describe("resolveAgentConfig", () => {
  it("returns config for built-in agents", async () => {
    const cfg = await resolveAgentConfig("claude");
    expect(cfg).toEqual({
      command: "claude",
      args: ["--print", "--dangerously-skip-permissions"],
      promptFlag: null,
    });
  });

  it("is case-insensitive", async () => {
    const cfg = await resolveAgentConfig("CLAUDE");
    expect(cfg).not.toBeNull();
    expect(cfg!.command).toBe("claude");
  });

  it("returns null for unknown agent", async () => {
    expect(await resolveAgentConfig("nonexistent-agent-xyz")).toBeNull();
  });

  it("returns config for aider with promptFlag", async () => {
    const cfg = await resolveAgentConfig("aider");
    expect(cfg).toMatchObject({ command: "aider", promptFlag: "--message" });
  });
});

describe("spawnAgent", () => {
  it("returns error for unknown agent without spawning", async () => {
    const result = await spawnAgent({ agent: "nonexistent", task: "hello" });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Unknown agent/);
    expect(result.agentId).toBe("");
  });
});
