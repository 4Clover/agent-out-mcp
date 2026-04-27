# agent-link-mcp — Overview

> **Navigation aid.** This article shows WHERE things live (routes, models, files). Read actual source files before implementing new features or making changes.

**agent-link-mcp** is a typescript project built with raw-http.

## Scale

4 library files · 1 environment variables

## High-Impact Files

Changes to these files have the widest blast radius across the codebase:

- `src/spawn-agent.ts` — imported by **7** files
- `src/process-session.ts` — imported by **4** files
- `src/session-store.ts` — imported by **3** files
- `src/schemas.ts` — imported by **3** files
- `src/index.ts` — imported by **1** files
- `src/agents.ts` — imported by **1** files

## Required Environment Variables

- `AGENT_LINK_CONFIG` — `src/__tests__/config-loading.test.ts`

---
_Back to [index.md](./index.md) · Generated 2026-04-26_