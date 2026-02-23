# Debugging Tools

CLI tools for analyzing Skyramp Testbot NDJSON logs from Cursor agent runs.

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
