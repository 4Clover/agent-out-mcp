// Known CLI agents and their invocation config.
// Extend this or override via ~/.agent-link/config.json

import { agentConfigSchema, AgentConfigSchema } from "./schemas.js";

export type AgentConfig = AgentConfigSchema;

export const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  claude: agentConfigSchema.parse({
    command: "claude",
    args: ["--print", "--dangerously-skip-permissions"],
    promptFlag: null,
    flagMap: { model: "--model", thinking: "--thinking" },
  }),
  codex: agentConfigSchema.parse({
    command: "codex",
    args: ["--full-auto"],
    promptFlag: null,
  }),
  gemini: agentConfigSchema.parse({
    command: "gemini",
    args: [],
    promptFlag: null,
  }),
  aider: agentConfigSchema.parse({
    command: "aider",
    args: ["--yes-always", "--no-pretty"],
    promptFlag: "--message",
  }),
};
