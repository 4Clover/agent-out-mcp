import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("which", () => ({
  default: vi.fn(async () => "/usr/bin/mock"),
}));

import {
  resolveAgentConfig,
  listAvailableAgents,
} from "../spawn-agent.js";

describe("config loading - case-insensitive keys", () => {
  let tmp: string;
  let configPath: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-link-test-"));
    configPath = join(tmp, "config.json");
    prev = process.env.AGENT_LINK_CONFIG;
    process.env.AGENT_LINK_CONFIG = configPath;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_LINK_CONFIG;
    else process.env.AGENT_LINK_CONFIG = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("matches a mixed-case user key via lowercase lookup", async () => {
    writeFileSync(configPath, JSON.stringify({
      agents: { MyAgent: { command: "x" } },
    }));
    const cfg = await resolveAgentConfig("myagent");
    expect(cfg).not.toBeNull();
    expect(cfg!.command).toBe("x");
  });

  it("matches uppercase input against mixed-case key", async () => {
    writeFileSync(configPath, JSON.stringify({
      agents: { MyAgent: { command: "y" } },
    }));
    const cfg = await resolveAgentConfig("MYAGENT");
    expect(cfg).not.toBeNull();
    expect(cfg!.command).toBe("y");
  });

  it("user-config entry whose lowercased key matches a default overrides the default", async () => {
    writeFileSync(configPath, JSON.stringify({
      agents: { Claude: { command: "claude-override" } },
    }));
    const cfg = await resolveAgentConfig("claude");
    expect(cfg!.command).toBe("claude-override");
  });
});

describe("config loading - error surfacing (M1)", () => {
  let tmp: string;
  let configPath: string;
  let prev: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-link-test-"));
    configPath = join(tmp, "config.json");
    prev = process.env.AGENT_LINK_CONFIG;
    process.env.AGENT_LINK_CONFIG = configPath;
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_LINK_CONFIG;
    else process.env.AGENT_LINK_CONFIG = prev;
    stderrSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a single warning to stderr for invalid JSON, falls back to defaults", async () => {
    writeFileSync(configPath, "{not json");
    const cfg = await resolveAgentConfig("claude");
    expect(cfg).not.toBeNull();
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /^\[agent-link\] Failed to load config/.test(m))).toBe(true);
  });

  it("writes a warning that includes offending key path for schema-invalid entry", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ agents: { broken: { command: "" } } })
    );
    await resolveAgentConfig("claude");
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /broken/.test(m))).toBe(true);
  });

  it("writes nothing for a missing config file (ENOENT)", async () => {
    // configPath does not exist
    await resolveAgentConfig("claude");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("listAvailableAgents - cross-platform via which package", () => {
  it("returns available agents when which resolves", async () => {
    const available = await listAvailableAgents();
    expect(available).toContain("claude");
    expect(available).toContain("codex");
  });
});
