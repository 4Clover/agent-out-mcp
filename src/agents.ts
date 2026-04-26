// Known CLI agents and their invocation config.
// Extend this or override via ~/.agent-link/config.json

export interface AgentConfig {
  command: string;
  args: string[];
  promptFlag: string | null;
}

export const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  claude: {
    command: "claude",
    args: ["--print", "--dangerously-skip-permissions"],
    promptFlag: null,
  },
  codex: {
    command: "codex",
    args: ["--full-auto"],
    promptFlag: null,
  },
  gemini: {
    command: "gemini",
    args: [],
    promptFlag: null,
  },
  aider: {
    command: "aider",
    args: ["--yes-always", "--no-pretty"],
    promptFlag: "--message",
  },
};
