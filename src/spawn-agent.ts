import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import which from "which";
import { AgentConfig, DEFAULT_AGENTS } from "./agents.js";
import { SpawnOptions, userConfigSchema } from "./schemas.js";
import { createProcessSession } from "./process-session.js";
import { registerSession } from "./session-store.js";

// ── Config loading ────────────────────────────────────────────────────────────

interface UserConfig {
  agents?: Record<string, AgentConfig>;
}

function configPath(): string {
  return (
    process.env.AGENT_LINK_CONFIG ??
    join(homedir(), ".agent-link", "config.json")
  );
}

async function loadUserConfig(): Promise<UserConfig> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `[agent-link] Failed to load config at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
    return {};
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[agent-link] Failed to load config at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return {};
  }

  const parsed = userConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const keyPath = issue?.path.join(".") ?? "";
    process.stderr.write(
      `[agent-link] Failed to load config at ${path}: ${keyPath} ${
        issue?.message ?? "invalid"
      }\n`
    );
    return {};
  }

  if (!parsed.data.agents) return {};
  const agents = Object.fromEntries(
    Object.entries(parsed.data.agents).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { agents };
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
  const entries = Object.entries(merged);
  const flags = await Promise.all(
    entries.map(([, cfg]) => isCommandAvailable(cfg.command))
  );
  return entries.filter((_, i) => flags[i]).map(([name]) => name);
}

async function isCommandAvailable(cmd: string): Promise<boolean> {
  return (await which(cmd, { nothrow: true })) !== null;
}

const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "TERM",
  "SHELL",
] as const;

export function resolveEnv(
  cfg: Pick<AgentConfig, "env">,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (cfg.env === "passthrough") return { ...base };
  const allowlist = new Set<string>(DEFAULT_ENV_ALLOWLIST);
  if (Array.isArray(cfg.env)) for (const k of cfg.env) allowlist.add(k);
  // PATH is always included even if base lacks it (caller supplies)
  allowlist.add("PATH");
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (base[key] !== undefined) out[key] = base[key];
  }
  return out;
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
    env: resolveEnv(cfg),
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
