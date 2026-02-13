# Claude Code Configuration — test-bot

## Project Overview

Skyramp Test Bot is a reusable GitHub Action (composite action) that uses an AI agent (Cursor or Copilot CLI) with the Skyramp MCP server to automatically generate, execute, and report on API tests for pull requests.

## Key Commands

- No build step — `action.yml` is the entire implementation
- Test by pushing to a branch referenced by a calling workflow (e.g., api-insight's `.github/workflows/`)

## Project Structure

```
action.yml              # Composite GitHub Action (~1235 lines) — the main file
assets/
  progress-spinner.gif  # Animated spinner for PR progress comments
```

## Architecture

### Execution Flow

1. **action.yml** validates inputs, loads config, checks out code, generates git diff
2. Posts a **progress comment** on the PR with checkboxes (Gathering → Analyzing → Finalizing)
3. Installs MCP server, Cursor/Copilot CLI, starts services, generates auth token
4. Runs a **single agent invocation** (`$AGENT_CMD` with retry wrapper):
   - Agent receives a prompt with PR title, description, diff file, test directory, output file path
   - Agent calls MCP `skyramp_testbot` prompt which returns instructions for both recommendations and maintenance
   - Agent uses Skyramp MCP tools to analyze, generate, execute tests, and write a report
5. **Prepare Report** step copies the agent's output file (or falls back to captured stdout)
6. **Post PR Comment** appends the report to the progress comment
7. Commits any new/modified test files via `git-auto-commit-action`

### Helper Scripts (written to `$RUNNER_TEMP/skyramp/`)

- `run-agent-with-retry.sh` — retries agent on "Connection stalled" errors (configurable max_retries, delay)
  - Params: `prompt`, `log_file` (optional, for debug NDJSON), `stdout_file` (optional, captures text output)
- `update-progress.sh` — manages PR progress comment (create, update checkboxes, append report)
  - `generate_progress_body()` — centralized markdown body generation
  - `update_progress_comment()` — PATCH existing comment with checkbox progress
  - `append_report_to_progress()` — final update with all checkboxes + report content

### Agent Types

- **Cursor**: `agent -f -p --model auto` (add `--output-format stream-json` for debug mode)
- **Copilot**: `copilot --additional-mcp-config ... --allow-all-tools --allow-all-paths -p`

## Important Patterns

- **Self-trigger detection**: For `pull_request` events, use `github.event.pull_request.head.sha` to get the actual commit author (not the merge commit)
- **Progress comment**: Uses `gh api` for all comment CRUD (not peter-evans action). Comment ID stored in `PROGRESS_COMMENT_ID` env var
- **Stdout fallback**: Agent may print summary to stdout instead of writing to the output file. `agent-stdout.txt` is captured and used as fallback in Prepare Report
- **Debug mode**: When `enable_debug=true`, agent output is NDJSON (not human-readable) — don't use as text fallback
- **Single output file**: Agent writes to `testbot-result.txt`, which gets copied to `combined-result.txt` for posting

## Common Gotchas

- GitHub Actions `pull_request` checkout creates a merge commit at `refs/remotes/pull/N/merge` — `git log -1` returns PR author, not latest committer
- YAML heredoc indentation: 8-space base stripped by YAML parser, but inline multiline strings in shell keep their indentation (renders as code blocks in markdown)
- `set -e` with `|| true` masks exit codes — capture `$?` explicitly when fallback logic depends on success/failure
- Cursor `--output-format stream-json` produces NDJSON, not plain text
- The MCP `skyramp_testbot` prompt handles both recommendations AND maintenance in one call — do NOT run the agent twice

## Related Repos

- `mcp.git` — MCP server with `skyramp_testbot` prompt (`src/prompts/testbot/testbot-prompts.ts`)
- `api-insight.git` — Demo FastAPI app used for testing the bot
- `skyramp.git` — Core Skyramp library
