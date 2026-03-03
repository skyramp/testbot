# Debugging Tools

CLI tools for analyzing and diagnosing Skyramp Testbot runs.

These tools are **not** part of the release — they are excluded from `tsconfig.json`, the esbuild bundle, and the CI build pipeline.

## Prerequisites

- Node.js 24+
- `gh` CLI ([install](https://cli.github.com/)) — only needed for downloading logs from GitHub Actions

## analyze-tools.ts

Single-run tool call timeline. Shows each MCP/builtin tool call with type, duration, and success/failure status.

```bash
# Download and analyze from a GitHub Actions run
npx tsx tools/analyze-tools.ts <run_id> [--repo owner/repo] [--keep-logs]

# Analyze a local NDJSON file
npx tsx tools/analyze-tools.ts --file /path/to/agent-log.ndjson
```

**Options:**
- `<run_id>` — GitHub Actions run ID (requires `gh` CLI)
- `--file`, `-f` — path to a local `agent-log.ndjson` file (skips download)
- `--repo` — repository (default: `letsramp/api-insight`)
- `--keep-logs` — don't delete the downloaded NDJSON file after analysis

## diagnose-run.ts

CI-level run diagnostics. Inspects workflow steps, MCP server connection status, package versions, agent errors, and report submission. Especially useful for debugging MCP connection failures and version mismatches.

```bash
# Diagnose a single run
npx tsx tools/diagnose-run.ts <run_id> --repo owner/repo

# Compare a passing run with a failing run side-by-side
npx tsx tools/diagnose-run.ts <run_id1> <run_id2> --compare --repo owner/repo
```

**Options:**
- `<run_id>` — GitHub Actions run ID(s) (requires `gh` CLI)
- `--repo` — repository (default: `letsramp/api-insight`)
- `--compare` — side-by-side comparison of two or more runs (highlights version/status differences)

**What it checks:**
- Workflow step durations and pass/fail status
- MCP server connection status and server name
- `@skyramp/skyramp` and `@skyramp/mcp` package versions
- Docker executor image version
- Agent type, exit code, retries, and timeout
- Whether `skyramp_submit_report` was called
- Availability of NDJSON agent log artifact

## inspect-prompt.ts

Deep inspection of MCP tool call inputs and outputs. Extracts the full request/response for Skyramp MCP tool calls, showing exactly what instructions the agent received and what it reported back. Useful for debugging prompt compliance (e.g., "did the agent follow the trace file instructions?").

```bash
# Show all Skyramp MCP tool calls (inputs + outputs)
npx tsx tools/inspect-prompt.ts <run_id> --repo owner/repo

# Show only recommend_tests calls (to check trace file instructions)
npx tsx tools/inspect-prompt.ts <run_id> --repo owner/repo --tool skyramp_recommend_tests

# Show the final report submitted by the agent
npx tsx tools/inspect-prompt.ts --file agent-log.ndjson --tool skyramp_submit_report
```

**Options:**
- `<run_id>` — GitHub Actions run ID (requires `gh` CLI)
- `--file`, `-f` — path to a local `agent-log.ndjson` file (skips download)
- `--repo` — repository (default: `letsramp/api-insight`)
- `--tool`, `-t` — filter to a specific tool name (substring match)
- `--keep-logs` — don't delete the downloaded NDJSON file after analysis

## evaluate-runs.ts

Cross-run evaluation metrics. Compares multiple testbot runs across five categories:

- **Test Effectiveness** — exec pass rate, tests created/passed/failed/skipped, endpoints covered
- **Tool Efficiency** — total calls, skyramp ratio, success rate, execute-to-pass ratio
- **Timing** — session duration, skyramp tool time, agent thinking time, avg test exec time
- **Self-Correction** — correction cycles (fail → edit → re-test), edits per cycle
- **Report Quality** — report submitted, commit message present, issues found, skipped ratio

```bash
# Compare multiple runs by ID
npx tsx tools/evaluate-runs.ts <run_id1> <run_id2> ... [--repo owner/repo]

# All runs for a PR
npx tsx tools/evaluate-runs.ts --pr 104 [--repo owner/repo]

# Local NDJSON files
npx tsx tools/evaluate-runs.ts --files log1.ndjson log2.ndjson ...
```

**Options:**
- `<run_ids>` — GitHub Actions run IDs (requires `gh` CLI)
- `--pr` — PR number — fetches all testbot runs for that PR
- `--files` — paths to local `agent-log.ndjson` files
- `--repo` — repository (default: `letsramp/api-insight`)
