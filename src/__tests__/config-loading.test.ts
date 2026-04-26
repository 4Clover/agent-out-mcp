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

describe("env sandbox (Step 6)", () => {
  it("default allowlist filters out non-allowlisted env vars but keeps PATH", async () => {
    const { resolveEnv } = await import("../spawn-agent.js");
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      SECRET_VAR: "leaked",
      DATABASE_URL: "postgres://...",
    };
    const env = resolveEnv({ command: "x", args: [], promptFlag: null, flagMap: {} }, base);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.SECRET_VAR).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("env: 'passthrough' includes all base env vars", async () => {
    const { resolveEnv } = await import("../spawn-agent.js");
    const base = { PATH: "/usr/bin", SECRET_VAR: "shh" };
    const env = resolveEnv(
      { command: "x", args: [], promptFlag: null, flagMap: {}, env: "passthrough" },
      base
    );
    expect(env.SECRET_VAR).toBe("shh");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("env: ['EXTRA_VAR'] adds the named var to the allowlist", async () => {
    const { resolveEnv } = await import("../spawn-agent.js");
    const base = { PATH: "/usr/bin", EXTRA_VAR: "yes", OTHER: "no" };
    const env = resolveEnv(
      { command: "x", args: [], promptFlag: null, flagMap: {}, env: ["EXTRA_VAR"] },
      base
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.EXTRA_VAR).toBe("yes");
    expect(env.OTHER).toBeUndefined();
  });

  it("PATH is always present even when extras allowlist is empty", async () => {
    const { resolveEnv } = await import("../spawn-agent.js");
    const env = resolveEnv(
      { command: "x", args: [], promptFlag: null, flagMap: {}, env: [] },
      { PATH: "/usr/bin" }
    );
    expect(env.PATH).toBe("/usr/bin");
  });
});
