import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AgentConfig, DEFAULT_AGENTS } from "./agents.js";
import { SpawnOptions, userConfigSchema } from "./schemas.js";
import { createProcessSession } from "./process-session.js";
import { registerSession } from "./session-store.js";

export function parseQuestion(text: string): string {
  return text.split("[QUESTION]")[1]?.split("\n")[0]?.trim() ?? text.trim();
}

// ── Config loading ────────────────────────────────────────────────────────────

interface UserConfig {
  agents?: Record<string, AgentConfig>;
}

async function loadUserConfig(): Promise<UserConfig> {
  const configPath =
    process.env.AGENT_LINK_CONFIG ??
    join(homedir(), ".agent-link", "config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = userConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    return { agents: parsed.data.agents };
  } catch {
    return {};
  }
}

export async function resolveAgentConfig(
  agentName: string
): Promise<AgentConfig | null> {
  const userConfig = await loadUserConfig();
  const merged = { ...DEFAULT_AGENTS, ...(userConfig.agents ?? {}) };
  return merged[agentName.toLowerCase()] ?? null;
}

export async function listAvailableAgents(): Promise<string[]> {
  const userConfig = await loadUserConfig();
  const merged = { ...DEFAULT_AGENTS, ...(userConfig.agents ?? {}) };
  const available: string[] = [];
  for (const [name, cfg] of Object.entries(merged)) {
    if (isCommandAvailable(cfg.command)) available.push(name);
  }
  return available;
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

export interface SpawnResult {
  agentId: string | null;
  status: "done" | "waiting_for_reply" | "error";
  result?: string;
  question?: string;
  error?: string;
}

export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const cfg = await resolveAgentConfig(opts.agent);
  if (!cfg) {
    return { agentId: null, status: "error", error: `Unknown agent: ${opts.agent}` };
  }

  const prompt = buildPrompt(opts);
  const args = buildArgs(cfg, prompt, opts);
  const agentId = `${opts.agent.toLowerCase()}-${randomBytes(8).toString("hex")}`;

  const session = createProcessSession({
    agentId,
    agent: opts.agent,
    task: opts.task,
    command: cfg.command,
    args,
    cwd: opts.cwd,
    env: process.env,
    timeoutMs: opts.timeoutMs ?? 3_600_000,
  });
  registerSession(session);

  const result = await session.waitNext();
  if (result.kind === "question") {
    return { agentId, status: "waiting_for_reply", question: result.question };
  }
  if (result.kind !== "close") {
    return { agentId, status: "error", error: `Unexpected wait result: ${result.kind}` };
  }
  const state = result.state;
  const text = "result" in state ? state.result.trim() : "";
  if (state.kind === "done") {
    return { agentId, status: "done", result: text };
  }
  if (state.kind === "killed") {
    return {
      agentId,
      status: "error",
      error: `Agent killed${state.signal ? ` (${state.signal})` : ""}`,
      result: text,
    };
  }
  if (state.kind === "error") {
    return { agentId, status: "error", error: state.error, result: text };
  }
  return { agentId, status: "error", error: `Unexpected state: ${state.kind}` };
}

function buildPrompt(opts: SpawnOptions): string {
  let prompt = opts.task;

  if (opts.context?.intent) {
    prompt = `Intent: ${opts.context.intent}\n\n${prompt}`;
  }
  if (opts.context?.error) {
    prompt += `\n\nError context:\n${opts.context.error}`;
  }
  if (opts.context?.files?.length) {
    prompt += `\n\nRelevant files: ${opts.context.files.join(", ")}`;
  }

  return prompt;
}

function buildArgs(cfg: AgentConfig, prompt: string, opts: SpawnOptions): string[] {
  const args = [...cfg.args];

  if (opts.model && cfg.flagMap.model) args.push(cfg.flagMap.model, opts.model);
  if (opts.thinking && cfg.flagMap.thinking) args.push(cfg.flagMap.thinking, opts.thinking);

  if (cfg.promptFlag) {
    args.push(cfg.promptFlag, prompt);
  } else {
    args.push(prompt);
  }

  return args;
}
