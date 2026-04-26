# Optimal Global codesight Implementation

> How to use codesight (v1.13.1) across all projects, agents, and AI coding
> tools from a single, consistent setup.

---

## 1. What codesight Does

codesight is a zero-dependency CLI that scans codebases via AST parsing
(TypeScript) or regex fallback (13 other languages) and produces structured
markdown context maps. Instead of an AI assistant spending 26K-47K tokens
exploring files, codesight pre-compiles project understanding into 3K-5K
tokens. With targeted wiki lookups, that drops to ~200-500 tokens per query
(60-131x reduction).

**8 parallel detectors:** routes (30+ frameworks), schema (15 ORMs),
components (React/Vue/Svelte/Flutter/SwiftUI/Angular), libraries (exports +
signatures), config (env vars, deps), middleware, dependency graph (import
edges, hot files), events (BullMQ/Kafka/Redis/Celery/Socket.io).

**Additional:** GraphQL/gRPC/WebSocket detection, OpenAPI spec parsing, test
coverage mapping, blast radius analysis, knowledge mode for markdown/ADR/Obsidian.

---

## 2. Current State

codesight is installed globally via pnpm (`~/.local/share/pnpm/codesight`).
Two projects already have `.codesight/` output:

- `~/projects/agent-link-mcp/.codesight/` (with wiki)
- `~/projects/fleuron/.codesight/` (with wiki)

No MCP server registration, no pre-commit hooks, no config files, no
`--profile` outputs exist yet.

---

## 3. Recommended Global Setup

### 3.1 MCP Server Registration (Claude Code)

Register codesight as an MCP server so Claude Code can call its 14 tools
on-demand without reading static files:

```bash
# Use the global binary directly (avoids npx startup delay)
claude mcp add codesight -- codesight --mcp
```

This exposes these tools inside Claude Code sessions:

| Tool | Tokens | Use case |
|---|---|---|
| `codesight_get_wiki_index` | ~200 | Session start orientation |
| `codesight_get_wiki_article` | ~300-500 | Targeted domain lookup |
| `codesight_get_summary` | ~500 | Quick project overview |
| `codesight_get_routes` | varies | API endpoint lookup (filterable by prefix/tag/method) |
| `codesight_get_schema` | varies | DB model lookup (filterable by name) |
| `codesight_get_blast_radius` | varies | Impact analysis before editing a file |
| `codesight_get_hot_files` | varies | Find highest-impact files |
| `codesight_get_env` | varies | Env var audit |
| `codesight_get_events` | varies | Background job/queue discovery |
| `codesight_get_coverage` | varies | Test coverage gaps |
| `codesight_get_knowledge` | varies | Knowledge base from .md notes |
| `codesight_lint_wiki` | varies | Wiki health check |
| `codesight_scan` | ~3K-5K | Full context map (use sparingly) |
| `codesight_refresh` | 0 | Force re-scan after code changes |

The MCP server caches results per-directory per session. First call scans,
subsequent calls return instantly. Call `codesight_refresh` after significant
code changes within a session.

### 3.2 Git Pre-Commit Hook (Per Project)

Install in every active project to keep `.codesight/` fresh automatically:

```bash
cd ~/projects/<project>
codesight --hook
```

This appends to `.git/hooks/pre-commit`:
```bash
#!/bin/sh
npx codesight --wiki -o .codesight
git add .codesight/
```

Context regenerates on every commit. No manual re-runs needed.

### 3.3 Profile-Generated Instruction Files

For each project, generate tool-specific instruction files:

```bash
# All tools at once (CLAUDE.md, .cursorrules, codex.md, AGENTS.md,
# .github/copilot-instructions.md)
codesight --init

# Or target a single tool
codesight --profile claude-code   # -> CLAUDE.md
codesight --profile cursor        # -> .cursorrules
codesight --profile codex         # -> codex.md
codesight --profile agents        # -> AGENTS.md
codesight --profile copilot       # -> .github/copilot-instructions.md
codesight --profile windsurf      # -> .windsurfrules
```

Each file gets pre-filled with: stack overview, route/schema/component counts,
high-impact files, required env vars, and tool-specific instructions (e.g.,
Claude Code gets the "Two-Step Rule" and MCP tool usage guidance).

**Caution:** `--init` won't overwrite existing files. If CLAUDE.md exists and
doesn't mention codesight, it appends an "AI Context" section. For projects
that already have handwritten CLAUDE.md/AGENTS.md (like agent-link-mcp),
use `--profile` selectively or manually incorporate the codesight references.

### 3.4 Project-Level Config (Optional)

For projects that need tuning, add `codesight.config.json`:

```json
{
  "maxDepth": 8,
  "disableDetectors": ["components"],
  "ignorePatterns": ["**/generated/**", "**/fixtures/**"],
  "customTags": { "billing": ["stripe", "payment"] },
  "blastRadiusDepth": 4,
  "hotFileThreshold": 5,
  "maxTokens": 50000,
  "collapseCrud": true
}
```

Key config options:

| Option | Default | Purpose |
|---|---|---|
| `disableDetectors` | `[]` | Skip irrelevant detectors (saves scan time) |
| `customTags` | `{}` | Custom route tagging beyond built-in (auth/db/cache/payment/ai/queue) |
| `ignorePatterns` | `[]` | Glob patterns to skip (merged with .codesightignore) |
| `maxTokens` | unlimited | Trim output to fit token budget (trims libs first, then components, then routes; never trims schemas) |
| `collapseCrud` | `true` | Collapse standard CRUD route groups into single summary lines |
| `blastRadiusDepth` | `5` | BFS depth for impact analysis |
| `hotFileThreshold` | `3` | Minimum import count to flag as "hot" |
| `plugins` | `[]` | Custom detector/postprocessor hooks |
| `monorepo.enabled` | `false` | Enable workspace-aware scanning |

### 3.5 Plugins for Infrastructure Context

Four built-in plugins extend detection beyond source code:

```typescript
// codesight.config.ts
import { createTerraformPlugin } from "codesight/plugins/terraform";
import { createCICDPlugin } from "codesight/plugins/cicd";
import { createGitHooksPlugin } from "codesight/plugins/githooks";
import { createSkillsPlugin } from "codesight/plugins/skills";

export default {
  plugins: [
    createTerraformPlugin({ infraPath: "../infrastructure" }),
    createCICDPlugin({ systems: ["github-actions"] }),
    createGitHooksPlugin(),
    createSkillsPlugin(),  // reads .claude/commands/ and .claude/skills/
  ],
};
```

| Plugin | Output | What it detects |
|---|---|---|
| Terraform | `infrastructure.md` | Compute, DNS, env vars, secrets, IAM, per-env overrides from .tfvars |
| CI/CD | `cicd.md` | GitHub Actions workflows, CircleCI config, triggers, secrets, deploy targets |
| Git Hooks | `githooks.md` | Lefthook, Husky, raw .git/hooks/ scripts |
| Skills | `skills.md` | Claude Code skills/commands from .claude/ directory |

---

## 4. Optimal Workflow for AI Agents

### 4.1 The Two-Step Rule (Claude Code)

1. **Orient** -- Read `wiki/index.md` (~200 tokens) to see what articles exist,
   then read the relevant domain article (~300-500 tokens) to find WHERE things
   live.
2. **Implement** -- Read the actual source files identified by the wiki article
   before writing code.

Wiki articles are navigation aids, not implementation guides. They tell you
file paths and function signatures but not full logic.

### 4.2 Read Order by Task Type

| Task | Read first | Then |
|---|---|---|
| New session / orientation | `wiki/index.md` -> `wiki/overview.md` | Relevant domain article |
| Architecture question | `wiki/overview.md` (~500 tokens) | Source files it references |
| Adding a new route | `codesight_get_routes` (filtered) | Existing route files for patterns |
| Modifying a file | `codesight_get_blast_radius` for that file | All affected files |
| Debugging | `codesight_get_hot_files` to find central files | `graph.md` for import chains |
| Schema change | `codesight_get_schema` | Related route files |
| Full deep dive | `CODESIGHT.md` (~3K-5K tokens) | Only when targeted lookup isn't enough |

### 4.3 When to Use MCP Tools vs Static Files

**Prefer MCP tools when:**
- You need filtered results (routes by tag, schema by model name)
- You want blast radius analysis for a specific file
- The codebase has changed since `.codesight/` was last generated
- You want minimal token usage (targeted queries)

**Prefer static files when:**
- MCP server isn't registered (e.g., Cursor, Copilot)
- You need the full combined context map
- You're generating instruction files for other tools

### 4.4 Cross-Agent Consistency

For repositories used by multiple AI tools, run `codesight --init` once to
generate all instruction files. Each tool reads its own format:

```
CLAUDE.md             <- Claude Code reads this
.cursorrules          <- Cursor reads this
codex.md              <- OpenAI Codex reads this
AGENTS.md             <- Generic agents read this
.github/copilot-instructions.md  <- Copilot reads this
.windsurfrules        <- Windsurf reads this
```

All files reference the same `.codesight/` data, ensuring every tool has
identical project understanding.

---

## 5. Implementation Plan for This Environment

### Phase 1: Global MCP Registration

```bash
# Register for all Claude Code sessions
claude mcp add codesight -- codesight --mcp
```

### Phase 2: Existing Projects

For each active project:

```bash
cd ~/projects/<project>

# Generate/refresh context + wiki
codesight --wiki

# Install pre-commit hook
codesight --hook

# Generate knowledge map if project has markdown docs
codesight --mode knowledge
```

### Phase 3: CLAUDE.md Integration

Rather than letting `--init` overwrite existing CLAUDE.md files, add a
codesight reference section to existing files:

```markdown
## AI Context (codesight)

- Full context map: `.codesight/CODESIGHT.md`
- Wiki index: `.codesight/wiki/index.md`
- Start with wiki for orientation, then read source files.
- Use `codesight_get_blast_radius` before modifying high-impact files.
```

### Phase 4: Watch Mode for Active Development

During active development sessions:

```bash
codesight --wiki --watch
```

This re-scans on every file save (debounced 500ms), keeping wiki articles
current without waiting for a commit.

### Phase 5: CI Integration (Optional)

Add to CI pipeline to keep `.codesight/` committed and fresh:

```yaml
# .github/workflows/codesight.yml
name: Update AI Context
on: [push]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g codesight && codesight --wiki
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: update codesight context"
          file_pattern: ".codesight/**"
```

---

## 6. Monorepo Considerations

For monorepos, enable workspace-aware scanning:

```json
{
  "monorepo": {
    "enabled": true,
    "workspaceFile": "pnpm-workspace.yaml",
    "minFiles": 10,
    "exclude": ["@internal/scripts"],
    "include": ["@app/core"]
  }
}
```

Each qualifying package gets its own `.codesight/` directory. A global index
at the repo root links all packages. Use `--refresh <pkg>` to re-scan a
single package without re-scanning everything.

---

## 7. Knowledge Mode for Documentation

For projects with ADRs, meeting notes, specs, or Obsidian vaults:

```bash
# Scan project's own markdown docs
codesight --mode knowledge

# Scan an external documentation directory
codesight --mode knowledge ~/vault
```

Produces `.codesight/KNOWLEDGE.md` with:
- Categorized notes (decisions, meetings, retros, specs, research, sessions)
- Extracted decisions and open questions
- People mentions (@-mentions, [[wikilinks]])
- Recurring themes across documents
- Hub notes (most cross-referenced)

---

## 8. Token Budget Strategy

For large projects, use `--max-tokens` to keep output within bounds:

```bash
codesight --max-tokens 50000  # fit in 50K token budget
```

Trim priority (lowest importance first):
1. **Libraries** (trimmed to 70% per pass)
2. **Components** (trimmed to 70% per pass)
3. **Routes** (trimmed to 80% per pass, auth/payment/ai routes kept longest, minimum 10 routes)
4. **Schemas** (never trimmed)

Measure actual savings with:
```bash
codesight --telemetry    # real before/after token measurement
codesight --benchmark    # detailed savings breakdown
```

---

## 9. Key Caveats

- **Non-TypeScript accuracy**: Languages other than TypeScript use regex
  detection, which can miss dynamic route registration, computed patterns,
  and some ORM features. Route detection shows 88-100% recall on tested
  projects; TypeScript gets full AST accuracy.

- **[inferred] badge**: Routes detected via regex (not AST) get an
  `[inferred]` marker. Treat these as probable but verify before relying
  on exact path/method.

- **Knowledge mode requires prior run**: The MCP tool `codesight_get_knowledge`
  returns results from a previous `--mode knowledge` scan. It doesn't scan
  on-demand.

- **npx startup delay**: First `npx codesight` call resolves the package,
  which can take 10-30 seconds. The global install (`pnpm add -g codesight`)
  eliminates this. For Codex CLI MCP registration, set
  `startup_timeout_sec = 60`.

- **Wiki articles are navigation, not implementation**: They show WHERE things
  live and WHAT exists. Always read actual source files before writing code.

- **Session cache**: MCP server caches scan results for the session. Call
  `codesight_refresh` after significant changes within a long session.

---

## 10. Quick Reference

```bash
# One-time global setup
claude mcp add codesight -- codesight --mcp

# Per-project setup
codesight --wiki                      # scan + wiki
codesight --hook                      # pre-commit hook
codesight --mode knowledge            # knowledge map (if .md docs exist)
codesight --init                      # all AI tool instruction files

# Daily use
codesight --wiki --watch              # watch mode during development
codesight --blast src/critical.ts     # blast radius before editing
codesight --refresh                   # re-scan monorepo package

# Diagnostics
codesight --telemetry                 # measure real token savings
codesight --benchmark                 # detailed savings breakdown
codesight --open                      # interactive HTML dashboard
```
