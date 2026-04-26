# agent-link-mcp

Your own MCP server that spawns CLI agents as subprocesses with bidirectional communication.

## Setup

```bash
npm install
npm run build
claude mcp add agent-link node /absolute/path/to/dist/index.js
```

Or run directly from source (Node 22+):
```bash
claude mcp add agent-link node --experimental-strip-types /absolute/path/to/src/index.ts
```

## Available Tools

| Tool | Description |
|---|---|
| `spawn_agent` | Spawn a single agent (claude, codex, gemini, aider, custom) |
| `spawn_agents` | Spawn multiple agents in parallel |
| `reply` | Reply to an agent that asked a [QUESTION] |
| `kill_agent` | Abort a running session |
| `list_agents` | Show which CLIs are available |
| `get_status` | Show all active sessions |

## Custom Agents

Create `~/.agent-link/config.json`:
```json
{
  "agents": {
    "my-local-llm": {
      "command": "ollama",
      "args": ["run", "codellama"],
      "promptFlag": null,
      "outputFormat": "text"
    }
  }
}
```

Override config path: `AGENT_LINK_CONFIG=/path/to/config.json`

## Bidirectional Protocol

Agents can pause and ask questions by printing `[QUESTION] <text>` to stdout.
The tool returns `{ status: "waiting_for_reply", question: "..." }`.
Call `reply(agentId, "your answer")` to continue.

## CLAUDE.md Snippet

```markdown
## Multi-Agent Workflows
- Use spawn_agent("gemini", ...) for large-context research tasks
- Use spawn_agent("codex", ...) for autonomous implementation
- Use spawn_agents([...]) for parallel code reviews
- Always pass context.diff: true for review tasks
- If an agent returns waiting_for_reply, answer immediately with reply()
```
