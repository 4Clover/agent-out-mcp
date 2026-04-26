# agent-link-mcp

# list available recipes
default:
  @just --list

# install dependencies
install:
  pnpm install

# build TypeScript to dist/
build:
  pnpm run build

# typecheck without emitting
check:
  npx tsc --noEmit

# run the MCP server
start: build
  pnpm run start

# run in dev mode (Node 22+ required)
dev:
  pnpm run dev

# run all tests
test *args:
  pnpm run test {{args}}

# run tests in watch mode
test-watch *args:
  pnpm run test:watch {{args}}

# run a single test file by name (e.g. `just test-file spawn-agent`)
test-file name:
  pnpm exec vitest run src/__tests__/{{name}}.test.ts

# typecheck + test
ci: check test

# clean build artifacts
clean:
  rm -rf dist

# rebuild from scratch
rebuild: clean build

# show spawnable agent configs (requires jq)
agents:
  node --experimental-strip-types -e \
    "import { DEFAULT_AGENTS } from './src/agents.ts'; console.log(JSON.stringify(DEFAULT_AGENTS, null, 2))"

# register with claude code (compiled)
register: build
  @echo "Run:  claude mcp add agent-link node $(pwd)/dist/index.js"

# register with claude code (source, Node 22+)
register-dev:
  @echo "Run:  claude mcp add agent-link node --experimental-strip-types $(pwd)/src/index.ts"

# show project status (deps, types, tests)
status:
  #!/usr/bin/env bash
  set -euo pipefail
  echo "=== dependencies ==="
  pnpm ls --depth 0 2>/dev/null || echo "(not installed)"
  echo ""
  echo "=== typecheck ==="
  npx tsc --noEmit 2>&1 && echo "ok" || true
  echo ""
  echo "=== tests ==="
  pnpm run test 2>&1 || true
