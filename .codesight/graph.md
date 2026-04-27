# Dependency Graph

## Most Imported Files (change these carefully)

- `src/spawn-agent.ts` — imported by **7** files
- `src/process-session.ts` — imported by **4** files
- `src/session-store.ts` — imported by **3** files
- `src/schemas.ts` — imported by **3** files
- `src/index.ts` — imported by **1** files
- `src/agents.ts` — imported by **1** files

## Import Map (who imports what)

- `src/spawn-agent.ts` ← `src/__tests__/config-loading.test.ts`, `src/__tests__/config-loading.test.ts`, `src/__tests__/config-loading.test.ts`, `src/__tests__/config-loading.test.ts`, `src/__tests__/config-loading.test.ts` +2 more
- `src/process-session.ts` ← `src/__tests__/session-store.test.ts`, `src/index.ts`, `src/session-store.ts`, `src/spawn-agent.ts`
- `src/session-store.ts` ← `src/__tests__/server.test.ts`, `src/index.ts`, `src/spawn-agent.ts`
- `src/schemas.ts` ← `src/agents.ts`, `src/index.ts`, `src/spawn-agent.ts`
- `src/index.ts` ← `src/__tests__/server.test.ts`
- `src/agents.ts` ← `src/spawn-agent.ts`
