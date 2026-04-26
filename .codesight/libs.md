# Libraries

- `src/index.ts` — function createServer: () => McpServer
- `src/session-store.ts`
  - function createSession: (partial, "output" | "startedAt">) => AgentSession
  - function getSession: (agentId) => AgentSession | undefined
  - function listSessions: () => AgentSession[]
  - function deleteSession: (agentId) => void
  - interface AgentSession
- `src/spawn-agent.ts`
  - function parseQuestion: (text) => string
  - function resolveAgentConfig: (agentName) => Promise<AgentConfig | null>
  - function listAvailableAgents: () => Promise<string[]>
  - function spawnAgent: (opts) => Promise<SpawnResult>
  - interface SpawnResult
