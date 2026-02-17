# Claude Code Configuration — test-bot

## Project Overview

Skyramp Testbot is a reusable GitHub Action (Node.js/TypeScript) that uses an AI agent (Cursor or Copilot CLI) with the Skyramp MCP server to automatically generate, execute, and report on API tests for pull requests.

## Key Commands

- `npm run build` — bundle TypeScript to `dist/index.js` via `esbuild`
- `npm run typecheck` — run `tsc --noEmit` for type checking
- Test by pushing to a branch referenced by a calling workflow (e.g., api-insight's `.github/workflows/`)

## Project Structure

```
action.yml              # Declarative inputs/outputs + runs.using: node24
package.json            # Dependencies and build scripts
tsconfig.json           # TypeScript configuration (target ES2024)
.github/workflows/
  build.yml             # CI: auto-builds dist/ on push to any branch
dist/                   # Compiled bundle — NOT in git, auto-built by CI
src/
  main.ts               # Entry point — orchestrates the full 18-step flow
  types.ts              # Shared interfaces (ActionInputs, ResolvedConfig, Paths, AgentCommand, etc.)
  inputs.ts             # getInputs() + detectAgentType()
  config.ts             # loadConfig() — merges .skyramp.yml with action inputs
  self-trigger.ts       # checkSelfTrigger() — PR head SHA aware
  progress.ts           # PR progress comment CRUD via Octokit
  mcp.ts                # installMcp() (npm/github source) + configureMcp()
  agent.ts              # installAgentCli(), initializeAgent(), buildAgentCommand(), buildPrompt(), runAgentWithRetry()
  services.ts           # startServices() + generateAuthToken()
  report.ts             # readSummary(), parseMetrics()
  git.ts                # generateGitDiff(), configureGitIdentity(), autoCommit()
  utils.ts              # exec(), sleep(), withRetry(), withGroup(), debug()/setDebugEnabled()
assets/
  progress-spinner.gif  # Animated spinner for PR progress comments
```

## Architecture

### Action Type

This is a `runs.using: node24` action. The `action.yml` is a thin declarative wrapper — all logic lives in TypeScript, bundled to `dist/index.js` via esbuild. The `dist/` directory is in `.gitignore` and auto-built by `.github/workflows/build.yml` on every push.

### Execution Flow (src/main.ts)

1. **Self-trigger check** (`self-trigger.ts`) — detects bot's own commits to prevent infinite loops
2. **Input validation** (`inputs.ts`) — parses action inputs, detects agent type (Cursor vs Copilot)
3. **Config loading** (`config.ts`) — merges `.skyramp.yml` overrides with action input defaults
4. **MCP source validation** — ensures npm/github source config is valid
5. **Path setup** — creates temp directory under `$RUNNER_TEMP/skyramp/`
6. **Git diff generation** (`git.ts`) — diffs PR base SHA against HEAD
7. **Progress comment** (`progress.ts`) — posts initial PR comment with checkboxes
8. **License injection & validation** — writes license file, validates via SkyrampClient
9. **MCP installation** (`mcp.ts`) — installs from npm or clones from github
10. **Docker executor pull** — pulls `skyramp/executor` image with retries
11. **Agent CLI setup** (`agent.ts`) — installs Cursor/Copilot CLI, writes MCP config, initializes
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

### Agent Types

- **Cursor**: `agent -f -p --model auto` (add `--output-format stream-json` for debug mode)
- **Copilot**: `copilot --additional-mcp-config @~/.copilot/mcp-config.json --allow-all-tools --allow-all-paths -p`
  - Note: `@` prefix is required for file paths in `--additional-mcp-config` (without it, CLI parses the value as inline JSON)

## Important Patterns

- **Self-trigger detection**: For `pull_request` events, uses `github.event.pull_request.head.sha` to get the actual commit author (not the merge commit)
- **Progress comment**: Uses Octokit (`@actions/github`) for all comment CRUD. Comment ID is tracked as a local variable in `main.ts` (no env var passing)
- **Stdout fallback**: Agent may print summary to stdout instead of writing to the output file. `agent-stdout.txt` is captured and used as fallback in `readSummary()`
- **Debug mode**: When `enable_debug=true`, Cursor agent output is NDJSON (not human-readable) — routed to log file, not used as text fallback. Debug messages use `core.info('[debug]')` because `core.debug()` requires `ACTIONS_STEP_DEBUG` set before the step starts.
- **Graceful failure**: If the agent fails, the action continues to post partial results before calling `core.setFailed()`
- **Agent timeout**: `testbot_timeout` (default 10 min) uses `Promise.race` as a safety net. Note: the child process is NOT killed on timeout (limitation of `@actions/exec`); it's cleaned up when the runner tears down the job.
- **GitHub token**: Must be read from `core.getInput('github_token')`, not `process.env.GITHUB_TOKEN` — node24 actions don't inherit env vars like composite actions do.

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
