import { describe, it, expect } from "vitest";
import {
  spawnOptionsSchema,
  agentConfigSchema,
  userConfigSchema,
  spawnAgentsBatchSchema,
} from "../schemas.js";

describe("spawnOptionsSchema cwd validation", () => {
  it("accepts POSIX absolute cwd", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      cwd: "/tmp/x",
    });
    expect(r.success).toBe(true);
  });

  it("accepts Windows drive-letter absolute cwd", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      cwd: "C:\\tmp\\x",
    });
    expect(r.success).toBe(true);
  });

  it("accepts Windows UNC absolute cwd", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      cwd: "\\\\srv\\sh",
    });
    expect(r.success).toBe(true);
  });

  it("rejects relative cwd with a path-marked Zod issue", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      cwd: "../escape",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.includes("cwd"));
      expect(issue).toBeDefined();
    }
  });

  it("allows omitting cwd", () => {
    const r = spawnOptionsSchema.safeParse({ agent: "claude", task: "hi" });
    expect(r.success).toBe(true);
  });
});

describe("agentConfigSchema", () => {
  it("accepts minimal { command } and applies defaults", () => {
    const r = agentConfigSchema.safeParse({ command: "x" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.command).toBe("x");
      expect(r.data.args).toEqual([]);
      expect(r.data.promptFlag).toBeNull();
      expect(r.data.flagMap).toEqual({});
    }
  });

  it("rejects empty command string", () => {
    const r = agentConfigSchema.safeParse({ command: "" });
    expect(r.success).toBe(false);
  });

  it("accepts a flagMap with known logical options (model, thinking)", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      flagMap: { model: "--model", thinking: "--thinking" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.flagMap.model).toBe("--model");
      expect(r.data.flagMap.thinking).toBe("--thinking");
    }
  });

  it("rejects flagMap with an unknown logical key", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      flagMap: { modle: "--model" },
    });
    expect(r.success).toBe(false);
  });

  it("accepts env: 'passthrough'", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      env: "passthrough",
    });
    expect(r.success).toBe(true);
  });

  it("accepts env as a string array allowlist", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      env: ["EXTRA_VAR_1", "EXTRA_VAR_2"],
    });
    expect(r.success).toBe(true);
  });
});

describe("userConfigSchema", () => {
  it("accepts a valid user config", () => {
    const r = userConfigSchema.safeParse({
      agents: { mytool: { command: "x" } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects malformed agent entry with offending key in path", () => {
    const r = userConfigSchema.safeParse({
      agents: { mytool: { command: "" } },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const flat = r.error.issues.flatMap((i) => i.path);
      expect(flat).toContain("mytool");
    }
  });

  it("accepts an empty config object", () => {
    const r = userConfigSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});

describe("spawnOptionsSchema model validation", () => {
  it("accepts a valid model identifier", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      model: "claude-sonnet-4-6",
    });
    expect(r.success).toBe(true);
  });

  it("accepts model with slashes and colons (registry format)", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      model: "anthropic/claude-sonnet-4-6:latest",
    });
    expect(r.success).toBe(true);
  });

  it("rejects model starting with -- (flag injection)", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      model: "--dangerously-skip-permissions",
    });
    expect(r.success).toBe(false);
  });

  it("rejects model with shell metacharacters", () => {
    for (const bad of ["model; rm -rf /", "model && evil", "$(whoami)", "model|cat"]) {
      const r = spawnOptionsSchema.safeParse({
        agent: "claude",
        task: "hi",
        model: bad,
      });
      expect(r.success).toBe(false);
    }
  });

  it("rejects model longer than 128 characters", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      model: "a".repeat(129),
    });
    expect(r.success).toBe(false);
  });
});

describe("spawnOptionsSchema timeoutMs validation", () => {
  it("accepts a valid timeout", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      timeoutMs: 60_000,
    });
    expect(r.success).toBe(true);
  });

  it("rejects timeoutMs of 0", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      timeoutMs: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative timeoutMs", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      timeoutMs: -1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-integer timeoutMs", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      timeoutMs: 1500.5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects timeoutMs exceeding 24 hours", () => {
    const r = spawnOptionsSchema.safeParse({
      agent: "claude",
      task: "hi",
      timeoutMs: 86_400_001,
    });
    expect(r.success).toBe(false);
  });

  it("accepts minimum 1000ms and maximum 24h", () => {
    expect(
      spawnOptionsSchema.safeParse({ agent: "claude", task: "hi", timeoutMs: 1000 }).success
    ).toBe(true);
    expect(
      spawnOptionsSchema.safeParse({ agent: "claude", task: "hi", timeoutMs: 86_400_000 }).success
    ).toBe(true);
  });
});

describe("agentConfigSchema env entry validation", () => {
  it("rejects env entries containing = (key injection)", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      env: ["PATH=injected:/bin"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects env entries with empty string", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      env: [""],
    });
    expect(r.success).toBe(false);
  });

  it("rejects env entries starting with a digit", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      env: ["1INVALID"],
    });
    expect(r.success).toBe(false);
  });

  it("accepts valid env var names", () => {
    const r = agentConfigSchema.safeParse({
      command: "x",
      env: ["MY_VAR", "ANOTHER_VAR_123", "_UNDERSCORE"],
    });
    expect(r.success).toBe(true);
  });
});

describe("spawnAgentsBatchSchema", () => {
  const valid = { agent: "claude", task: "hi" };

  it("accepts batch sizes between 1 and 10", () => {
    expect(spawnAgentsBatchSchema.safeParse([valid]).success).toBe(true);
    expect(
      spawnAgentsBatchSchema.safeParse(Array(10).fill(valid)).success
    ).toBe(true);
  });

  it("rejects empty batch", () => {
    expect(spawnAgentsBatchSchema.safeParse([]).success).toBe(false);
  });

  it("rejects batch larger than 10", () => {
    expect(
      spawnAgentsBatchSchema.safeParse(Array(11).fill(valid)).success
    ).toBe(false);
  });
});
