# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Skyramp Testbot is a reusable GitHub Action (Node.js/TypeScript) that uses an AI agent (Cursor, Copilot, or Claude Code CLI) with the Skyramp MCP server to automatically generate, execute, and report on API tests for pull requests.

## Key Commands

- `npm run build` — bundle TypeScript to `dist/index.js` + `dist/post.js` via esbuild
- `npm run typecheck` — run `tsc --noEmit` for type checking
- `npm test` — run all tests with vitest (`vitest run`)
- `npm run test:watch` — run tests in watch mode
- End-to-end testing: push to a branch referenced by a calling workflow (e.g., api-insight's `.github/workflows/`)

## Architecture

### Action Type

This is a `runs.using: node24` action. The `action.yml` is a thin declarative wrapper — all logic lives in TypeScript, bundled to `dist/index.js` (main) and `dist/post.js` (post step) via esbuild. The `dist/` directory is auto-built and committed by `.github/workflows/build.yml` on every push.

### Execution Flow (src/main.ts)

1. **Self-trigger check** (`self-trigger.ts`) — detects bot's own commits to prevent infinite loops
2. **Input validation** (`inputs.ts`) — parses action inputs, detects agent type → creates `AgentStrategy` via `createAgent()`
3. **Config loading** (`config.ts`) — merges `.skyramp.yml` overrides with action input defaults
4. **MCP source validation** — ensures npm/github source config is valid
5. **Path setup** — creates temp directory under `$RUNNER_TEMP/skyramp/`
6. **Git diff generation** (`git.ts`) — diffs PR base SHA against HEAD
7. **Progress comment** (`progress.ts`) — posts initial PR comment with checkboxes
8. **License injection & validation** — writes license file, validates via SkyrampClient
9. **MCP installation** (`mcp.ts`) — installs from npm or clones from github
10. **Docker executor pull** — pulls `skyramp/executor` image with retries
11. **Agent CLI setup** (`agent.ts`) — delegates to `AgentStrategy` for install, MCP config, and initialization
12. **Service startup** (`services.ts`) — runs user's startup command, generates auth token
13. **Progress update** — advances checkboxes to step 2
14. **Testbot execution** (`agent.ts`) — runs agent with retry logic and timeout
15. **Report processing** (`report.ts`) — reads summary, parses metrics, writes combined report
16. **Artifact upload** — uploads debug NDJSON logs when `enable_debug=true`
17. **PR comment** (`progress.ts`) — appends report to progress comment (or posts standalone fallback)
18. **Auto-commit** (`git.ts`) — stages matching files, commits, and pushes

### Shared Utilities (src/utils.ts)

- `exec()` — wrapper around `@actions/exec` with stdout/stderr capture, optional timeout
- `sleep()` — async delay in seconds
- `withRetry()` — generic retry-with-delay loop (used by agent install, docker pull, agent run)
- `withGroup()` — exception-safe `core.startGroup/endGroup` wrapper (group always closed via `finally`)
- `debug()`/`setDebugEnabled()` — runtime-gated debug logging via `core.info('[debug] ...')`

### Agent Types (Strategy Pattern)

Agent-type-specific behavior uses the **strategy pattern**. The abstract class `AgentStrategy` (in `src/types.ts`) defines the interface; each agent type has a concrete subclass in `src/agents/`. The factory `createAgent(type)` in `src/agents/index.ts` maps the `AgentType` string to the right class. Call sites in `agent.ts`, `mcp.ts`, and `main.ts` are thin delegates that call methods on the strategy object — no if/else on agent type outside the factory.

Current agents:
- **Cursor** (`src/agents/cursor.ts`): `agent -f -p --model sonnet-4.5` (add `--output-format stream-json` for debug mode). `supportsNdjsonLog = true`.
- **Copilot** (`src/agents/copilot.ts`): `copilot --additional-mcp-config @~/.copilot/mcp-config.json --allow-all-tools --allow-all-paths -p`
  - Note: `@` prefix is required for file paths in `--additional-mcp-config` (without it, CLI parses the value as inline JSON)
- **Claude Code** (`src/agents/claude.ts`): `claude --dangerously-skip-permissions --model sonnet -p`. Overrides `exportEnv()` to set `ANTHROPIC_API_KEY` and `MCP_TIMEOUT` as process env vars instead of using `core.exportVariable`.

#### Adding a New Agent Type

1. **Add the type** to the `AgentType` union in `src/types.ts` (e.g., `'newagent'`).
2. **Add the API key input** to `ActionInputs` in `src/types.ts` (e.g., `newAgentApiKey: string`), and parse it in `src/inputs.ts` `getInputs()`.
3. **Update detection** in `src/inputs.ts` `detectAgentType()` to check the new key.
4. **Create the strategy** file `src/agents/newagent.ts` extending `AgentStrategy`. Implement all abstract methods:
   - `install()` — how to install the CLI binary
   - `initialize()` — post-install setup (MCP enable, connectivity checks)
   - `configureMcp()` — write MCP server config in the format the agent expects
   - `buildCommand()` — return the CLI command and args
   - `exportEnv()` — (optional override) export API key / env vars
   - Set `supportsNdjsonLog = true` if the agent produces NDJSON debug output
5. **Register** the new class in `src/agents/index.ts` — add a `case` to `createAgent()` and export it.
6. **Add the action input** to `action.yml` (e.g., `new_agent_api_key`).
7. **Add tests** in `src/__tests__/agent.test.ts` for `buildAgentCommand(createAgent('newagent'), ...)` and `installAgentCli(createAgent('newagent'))`.

No changes to `agent.ts`, `mcp.ts`, or `main.ts` are needed — they delegate to the strategy object.

## Important Patterns

- **Self-trigger detection**: For `pull_request` events, uses `github.event.pull_request.head.sha` to get the actual commit author (not the merge commit)
- **Progress comment**: Uses Octokit (`@actions/github`) for all comment CRUD. Comment ID is tracked as a local variable in `main.ts` (no env var passing)
- **Stdout fallback**: Agent may print summary to stdout instead of writing to the output file. `agent-stdout.txt` is captured and used as fallback in `readSummary()`
- **Debug mode**: When `enable_debug=true`, agents with `supportsNdjsonLog` (Cursor and Claude Code) produce NDJSON output — routed to log file, not used as text fallback. Debug messages use `core.info('[debug]')` because `core.debug()` requires `ACTIONS_STEP_DEBUG` set before the step starts.
- **Graceful failure**: If the agent fails, the action continues to post partial results before calling `core.setFailed()`
- **Agent timeout**: `testbot_timeout` (default 60 min) uses `Promise.race` as a safety net. Note: the child process is NOT killed on timeout (limitation of `@actions/exec`); it's cleaned up when the runner tears down the job.
- **GitHub token**: Must be read from `core.getInput('github_token')`, not `process.env.GITHUB_TOKEN` — node24 actions don't inherit env vars like composite actions do.

## Code Review Guidelines

- **Prefer TypeScript enums over ad-hoc union types**: When you see string union types like `"foo" | "bar"` used as parameter types, define them as proper TypeScript enums instead. This applies to both writing new code and reviewing existing code.

## Common Gotchas

- GitHub Actions `pull_request` checkout creates a merge commit — use `payload.pull_request.head.sha` for real author
- Cursor `--output-format stream-json` produces NDJSON, not plain text
- The MCP `skyramp_testbot` prompt handles both recommendations AND maintenance in one call — do NOT run the agent twice
- `dist/` is auto-built by CI — push source changes and wait for the build workflow before testing downstream
- After CI auto-builds `dist/`, your local branch will be behind; `git pull --rebase` before pushing again

## Related Repos

- `mcp.git` — MCP server with `skyramp_testbot` prompt (`src/prompts/testbot/testbot-prompts.ts`)
- `api-insight.git` — Demo FastAPI app used for testing the bot
- `skyramp.git` — Core Skyramp library
