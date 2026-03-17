#!/usr/bin/env bash
set -euo pipefail

# Run testbot's Claude Code agent against a locally cloned repo with an eval branch checked out.
# Produces testbot-result.txt (TestbotReport JSON) in RESULT_DIR.
#
# Usage: eval-agent.sh <work_dir> <result_dir> --base-branch <branch>
#
# Environment:
#   ANTHROPIC_API_KEY   — required (Claude Code agent)
#   SKYRAMP_LICENSE     — required (Skyramp MCP)
#   MCP_SERVER          — path to Skyramp MCP index.js (default: npm global install)
#   SKIP_MCP_REGISTER   — set to 1 to skip claude mcp add (already registered by run-eval.sh)

WORK_DIR="$1"
RESULT_DIR="$2"
shift 2

BASE_BRANCH="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-branch) BASE_BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$RESULT_DIR"

# ── Generate git diff ──────────────────────────────────────────────────────────
DIFF_FILE="$RESULT_DIR/git_diff"
cd "$WORK_DIR"
git diff "$BASE_BRANCH"...HEAD > "$DIFF_FILE" 2>/dev/null || git diff HEAD~1 > "$DIFF_FILE" 2>/dev/null || true

if [[ ! -s "$DIFF_FILE" ]]; then
  echo "  [eval-agent] WARNING: empty diff — no changes detected on eval branch"
fi

echo "  [eval-agent] Diff: $(wc -l < "$DIFF_FILE") lines"

# ── Register Skyramp MCP (unless already done by run-eval.sh) ─────────────────
if [[ -z "${SKIP_MCP_REGISTER:-}" ]]; then
  CLAUDE_CONFIG="$HOME/.claude.json"
  [[ -f "$CLAUDE_CONFIG" ]] || echo '{}' > "$CLAUDE_CONFIG"

  if [[ -n "${MCP_SERVER:-}" ]]; then
    MCP_CMD="node"
    MCP_ARG="$MCP_SERVER"
  else
    # Use globally installed @skyramp/mcp
    MCP_BIN=$(npm root -g)/@skyramp/mcp/build/index.js
    MCP_CMD="node"
    MCP_ARG="$MCP_BIN"
  fi

  jq --arg cmd "$MCP_CMD" \
     --arg mcp_arg "$MCP_ARG" \
     '.mcpServers.skyramp = {type: "stdio", command: $cmd, args: [$mcp_arg], env: {"CI": "true"}}' \
     "$CLAUDE_CONFIG" > "$CLAUDE_CONFIG.tmp" && mv "$CLAUDE_CONFIG.tmp" "$CLAUDE_CONFIG"
fi

# ── Build testbot prompt ───────────────────────────────────────────────────────
SUMMARY_PATH="$RESULT_DIR/testbot-result.txt"
PR_TITLE=$(git log -1 --pretty=%s 2>/dev/null || echo "Eval PR")

PROMPT="You are Skyramp Testbot. Analyze the following pull request and generate a test report.

<pr_context>
<title>${PR_TITLE}</title>
<base_branch>${BASE_BRANCH}</base_branch>
<diff_file>.skyramp_git_diff</diff_file>
</pr_context>

Using the Skyramp MCP server, do ALL of the following:
1. Call skyramp_recommend_tests to analyze the PR diff and recommend API tests
2. Based on your analysis, call skyramp_submit_report with:
   - businessCaseAnalysis: a paragraph explaining which changes were made and why testing them matters for the business
   - testResults: [] (empty — no services are running in this eval environment)
   - newTestsCreated: [] (empty — no test execution in eval mode)
   - testMaintenance: []
   - issuesFound: []
   - commitMessage: a one-line summary of the test recommendations

Write the JSON output of skyramp_submit_report to: ${SUMMARY_PATH}

IMPORTANT: The businessCaseAnalysis field must specifically address the endpoints and features changed in this PR. Do not write generic text."

# Write diff to working dir for agent access
cp "$DIFF_FILE" "$WORK_DIR/.skyramp_git_diff"

# ── Run Claude Code agent ──────────────────────────────────────────────────────
LOG_FILE="$RESULT_DIR/agent-log.ndjson"
STDOUT_FILE="$RESULT_DIR/agent-stdout.txt"
STDERR_FILE="$RESULT_DIR/agent-stderr.log"

echo "  [eval-agent] Running Claude Code agent (base: $BASE_BRANCH)..."

set +e
claude \
  --dangerously-skip-permissions \
  --model claude-sonnet-4-6 \
  --output-format stream-json \
  --max-turns 30 \
  -p "$PROMPT" \
  > "$LOG_FILE" \
  2> "$STDERR_FILE"
AGENT_EXIT=$?
set -e

# Extract plain text from NDJSON for fallback
if [[ -f "$LOG_FILE" ]]; then
  jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' \
    "$LOG_FILE" 2>/dev/null > "$STDOUT_FILE" || true
fi

# Clean up temp diff
rm -f "$WORK_DIR/.skyramp_git_diff"

if [[ $AGENT_EXIT -ne 0 ]]; then
  echo "  [eval-agent] Agent exited with code $AGENT_EXIT"
  cat "$STDERR_FILE" >&2 2>/dev/null || true
fi

# ── Extract report from agent output ──────────────────────────────────────────
# Primary: agent wrote JSON to SUMMARY_PATH via skyramp_submit_report
# Fallback: extract the skyramp_submit_report args from NDJSON log

if [[ -f "$SUMMARY_PATH" && -s "$SUMMARY_PATH" ]]; then
  echo "  [eval-agent] Report found at $SUMMARY_PATH"
else
  echo "  [eval-agent] Extracting report from agent NDJSON log..."
  # Try to find skyramp_submit_report tool call args in the log
  EXTRACTED=$(jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(.type == "tool_use") |
    select(.name | test("submit_report")) |
    .input
  ' "$LOG_FILE" 2>/dev/null | head -1)

  if [[ -n "$EXTRACTED" && "$EXTRACTED" != "null" ]]; then
    echo "$EXTRACTED" > "$SUMMARY_PATH"
    echo "  [eval-agent] Extracted report from tool call args"
  else
    echo "  [eval-agent] ERROR: no report found in agent output"
    exit 1
  fi
fi

# Validate it's parseable JSON with businessCaseAnalysis
BUSINESS_CASE=$(jq -r '.businessCaseAnalysis // ""' "$SUMMARY_PATH" 2>/dev/null || echo "")
if [[ -z "$BUSINESS_CASE" ]]; then
  echo "  [eval-agent] ERROR: businessCaseAnalysis missing or empty in report"
  exit 1
fi

echo "  [eval-agent] Business case length: ${#BUSINESS_CASE} chars"
echo "  [eval-agent] Done"
