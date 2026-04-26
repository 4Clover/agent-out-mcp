import { z } from "zod";

const spawnOptionsSchema = z.object({
  agent: z
    .string()
    .describe("Agent name: 'claude', 'codex', 'gemini', 'aider', or a custom name from config"),
  task: z.string().describe("The task or prompt to give the agent"),
  context: z
    .object({
      files: z.array(z.string()).optional().describe("File paths to include in context"),
      error: z.string().optional().describe("Error message or stack trace for debugging tasks"),
      intent: z.string().optional().describe("High-level intent hint for the agent"),
    })
    .optional(),
  model: z.string().optional().describe("Override the agent's default model"),
  thinking: z
    .enum(["low", "medium", "high", "max"])
    .optional()
    .describe("Thinking intensity (supported by claude)"),
  timeoutMs: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (default: 3600000 = 1 hour)"),
  cwd: z.string().optional().describe("Working directory for the subprocess"),
});

export type SpawnOptions = z.infer<typeof spawnOptionsSchema>;
export const spawnAgentSchema = spawnOptionsSchema.shape;
