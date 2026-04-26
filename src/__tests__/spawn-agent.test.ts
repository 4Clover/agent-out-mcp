import { describe, it, expect } from "vitest";
import { resolveAgentConfig, spawnAgent } from "../spawn-agent.js";

describe("resolveAgentConfig", () => {
  it("returns config for built-in agents", async () => {
    const cfg = await resolveAgentConfig("claude");
    expect(cfg).toMatchObject({
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
    expect(result.agentId).toBeNull();
  });
});
