import path from "node:path";
import { z } from "zod";

const absolutePath = z.string().refine(
  (v) => path.posix.isAbsolute(v) || path.win32.isAbsolute(v),
  { message: "cwd must be an absolute path", path: ["cwd"] }
);

export const spawnOptionsSchema = z.object({
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
  model: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.\-:/@]*$/, { message: "model must be a valid model identifier" })
    .optional()
    .describe("Override the agent's default model"),
  thinking: z
    .enum(["low", "medium", "high", "max"])
    .optional()
    .describe("Thinking intensity (supported by claude)"),
  timeoutMs: z
    .number()
    .int()
    .min(1000, { message: "timeoutMs must be at least 1000 (1 second)" })
    .max(86_400_000, { message: "timeoutMs must not exceed 86400000 (24 hours)" })
    .optional()
    .describe("Timeout in milliseconds (default: 3600000 = 1 hour)"),
  cwd: absolutePath.optional().describe("Absolute working directory for the subprocess"),
});

export type SpawnOptions = z.infer<typeof spawnOptionsSchema>;
export const spawnAgentSchema = spawnOptionsSchema.shape;

export const flagMapSchema = z
  .object({
    model: z.string().optional(),
    thinking: z.string().optional(),
  })
  .strict();

export const agentConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  promptFlag: z.string().nullable().default(null),
  flagMap: flagMapSchema.default({}),
  env: z
    .union([
      z.literal("passthrough"),
      z.array(
        z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
          message: "env entry must be a valid environment variable name",
        })
      ),
    ])
    .optional(),
});
export type AgentConfigSchema = z.infer<typeof agentConfigSchema>;

export const userConfigSchema = z.object({
  agents: z.record(z.string(), agentConfigSchema).optional(),
});
export type UserConfig = z.infer<typeof userConfigSchema>;

export const spawnAgentsBatchSchema = z
  .array(spawnOptionsSchema)
  .min(1)
  .max(10);
export type SpawnAgentsBatchInput = z.infer<typeof spawnAgentsBatchSchema>;
