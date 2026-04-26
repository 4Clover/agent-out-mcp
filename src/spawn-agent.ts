import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentConfig, DEFAULT_AGENTS } from "./agents.js";
import { createSession } from "./session-store.js";

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
  if (!existsSync(configPath)) return {};
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as UserConfig;
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
  // Check which CLIs are actually on PATH
  const available: string[] = [];
  for (const [name, cfg] of Object.entries(merged)) {
    if (isCommandAvailable(cfg.command)) available.push(name);
  }
  return available;
}

function isCommandAvailable(cmd: string): boolean {
  try {
    const result = spawn(cmd, ["--version"], { stdio: "ignore" });
    result.kill();
    return true;
  } catch {
    return false;
  }
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  agent: string;
  task: string;
  context?: {
    files?: string[];
    error?: string;
    intent?: string;
  };
  model?: string;
  thinking?: "low" | "medium" | "high" | "max";
  timeoutMs?: number;
  cwd?: string;
}

export interface SpawnResult {
  agentId: string;
  status: "done" | "waiting_for_reply" | "error";
  result?: string;
  question?: string;
  error?: string;
}

export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const cfg = await resolveAgentConfig(opts.agent);
  if (!cfg) {
    return { agentId: "", status: "error", error: `Unknown agent: ${opts.agent}` };
  }

  const prompt = buildPrompt(opts);
  const args = buildArgs(cfg, prompt, opts);
  const agentId = `${opts.agent}-${randomUUID().slice(0, 6)}`;

  return await runProcess(agentId, cfg, args, opts);
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

  if (opts.model) args.push("--model", opts.model);

  if (cfg.promptFlag) {
    args.push(cfg.promptFlag, prompt);
  } else {
    args.push(prompt);
  }

  return args;
}

function runProcess(
  agentId: string,
  cfg: AgentConfig,
  args: string[],
  opts: SpawnOptions
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn(cfg.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
    });

    const session = createSession({
      agentId,
      agent: opts.agent,
      task: opts.task,
      process: proc,
      status: "running",
    });

    const timeoutMs = opts.timeoutMs ?? 3_600_000; // 1 hour default
    let resolved = false;
    let outputBuffer = "";

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        resolve({ agentId, status: "error", error: "Agent timed out" });
      }
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      outputBuffer += text;
      session.output.push(text);

      if (text.includes("[QUESTION]")) {
        const question = parseQuestion(text);
        session.status = "waiting_for_reply";
        session.pendingQuestion = question;

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ agentId, status: "waiting_for_reply", question });
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      session.output.push(`[stderr] ${chunk.toString()}`);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      session.status = code === 0 ? "done" : "error";

      if (!resolved) {
        resolved = true;
        if (code === 0) {
          resolve({ agentId, status: "done", result: outputBuffer.trim() });
        } else {
          resolve({
            agentId,
            status: "error",
            error: `Agent exited with code ${code}`,
            result: outputBuffer.trim(),
          });
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      session.status = "error";
      if (!resolved) {
        resolved = true;
        resolve({ agentId, status: "error", error: err.message });
      }
    });
  });
}
