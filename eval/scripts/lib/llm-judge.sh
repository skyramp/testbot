#!/usr/bin/env bash
set -euo pipefail

# Usage: llm-judge.sh <report.json> <expected.json> <dimension>
# Returns: score (0, 0.5, or 1) to stdout
# Writes reasoning to llm-judge.log alongside the report file

report_file="$1"
expected_file="$2"
dimension="$3"

LOG_DIR="$(dirname "$report_file")"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "0"
  exit 0
fi

# Extract businessCaseAnalysis from the testbot JSON report
business_case=$(jq -r '.businessCaseAnalysis // ""' "$report_file" 2>/dev/null || { echo "Warning: Failed to parse businessCaseAnalysis from $report_file; treating as empty." >&2; echo ""; })
if [[ -z "$business_case" || "$business_case" == "null" ]]; then
  echo "0"
  exit 0
fi

expected_text=$(cat "$expected_file")
description=$(jq -r '.description // ""' "$expected_file")
changed_endpoints=$(jq -r '(.changed_endpoints // []) | join(", ")' "$expected_file")
should_mention=$(jq -r '(.should_mention_in_business_case // []) | join(", ")' "$expected_file")

case "$dimension" in
  relevance)
    rubric="Score how RELEVANT the business case analysis is to the actual code changes in this PR.

CONTEXT:
- PR description: $description
- Changed endpoints: $changed_endpoints
- Expected mentions: $should_mention

SCORING RUBRIC:
- 1.0: The business case explicitly addresses the specific code changes, mentions the affected endpoints or features by name, and connects them directly to test coverage needs.
- 0.5: The business case broadly addresses the PR area but is vague about specific endpoints or features, or only partially covers the changes.
- 0.0: The business case is generic/boilerplate with no meaningful connection to the actual PR changes. Could have been written for any PR.

EXAMPLES:
'Tests cover the GET /articles/feed/favorites endpoint and its interaction with the user follow and article favorite systems' → Score 1.0 (specific endpoint + cross-resource context)
'Tests should cover the new API functionality for article feeds' → Score 0.5 (vague reference to the feature)
'Tests ensure the API functions correctly' → Score 0.0 (completely generic)"
    ;;

  specificity)
    rubric="Score how SPECIFIC and CONCRETE the business case analysis is in naming technical details.

CONTEXT:
- PR description: $description
- Changed endpoints: $changed_endpoints
- Expected mentions: $should_mention

SCORING RUBRIC:
- 1.0: Names specific endpoint paths (e.g. 'GET /api/articles/feed/favorites'), HTTP methods, field names, or service names. References concrete test scenarios with specific data flows.
- 0.5: Mentions some endpoint names or service names, but omits HTTP methods or request/response details. Partially specific.
- 0.0: No specific endpoint paths, methods, field names, or service names. Pure prose with no technical grounding.

EXAMPLES:
'Validates that POST /api/reviews with a valid packageId and rating returns 201 and that the reviews appear on GET /api/packages/{slug}/reviews' → Score 1.0
'Tests the reviews endpoint behavior' → Score 0.5
'Ensures the new feature works as expected' → Score 0.0"
    ;;

  value_articulation)
    rubric="Score how well the business case articulates WHY testing these changes matters for the business or end users.

CONTEXT:
- PR description: $description

SCORING RUBRIC:
- 1.0: Clearly explains the business impact or user risk if the tested functionality breaks. Connects test coverage to a specific business outcome, user flow, or risk (e.g. revenue, trust, data integrity, user experience).
- 0.5: Mentions that testing is important but provides a generic rationale (e.g. 'ensures correctness') without specific business impact.
- 0.0: States what is being tested without any explanation of why it matters beyond functional correctness.

EXAMPLES:
'Failures in the checkout flow would directly block revenue — these tests catch payment processing regressions before they reach production users' → Score 1.0
'Testing is important to ensure the feature works correctly' → Score 0.5
'Tests cover the new favorites feed endpoint' → Score 0.0 (describes what, not why)"
    ;;

  clarity)
    rubric="Score how CONCISE and CLEAR the business case analysis is.

SCORING RUBRIC:
- 1.0: The text is direct and easy to understand. No unnecessary filler, no repeated points, no jargon. A non-technical reader could grasp the key message in one read.
- 0.5: Mostly clear but contains some redundancy, padding, or overly complex phrasing that reduces readability.
- 0.0: Verbose, repetitive, or hard to follow. The core message is buried in filler text or technical jargon with no plain-language explanation.

EXAMPLES:
'The new bulk-evaluate endpoint processes up to 100 flags in one call — testing it prevents latency regressions that would degrade flag-gated feature rollouts.' → Score 1.0 (tight, plain, one clear sentence)
'This PR introduces important changes to the feature flag evaluation system which is a core component of our platform and it is important to ensure that these changes are tested thoroughly to make sure they work correctly.' → Score 0.5 (repetitive but understandable)
'The implementation of the aforementioned functionality necessitates comprehensive validation across multiple dimensions of system behavior to ensure robustness.' → Score 0.0 (jargon-heavy, says nothing concrete)"
    ;;

  *)
    echo "0"
    exit 0
    ;;
esac

prompt="You are an evaluator scoring the \"Business Case Analysis\" section of an AI-generated testbot report.

TASK: Score the text on the dimension described below.

$rubric

BUSINESS CASE ANALYSIS TO EVALUATE:
$business_case

EXPECTED CONTEXT (from eval config):
$expected_text

Respond with ONLY a JSON object, nothing else:
{\"score\": <0 or 0.5 or 1>, \"reason\": \"<one sentence justification>\"}"

json_payload=$(jq -n \
  --arg model "claude-sonnet-4-6" \
  --argjson max_tokens 200 \
  --argjson temperature 0 \
  --arg prompt "$prompt" \
  '{
    model: $model,
    max_tokens: $max_tokens,
    temperature: $temperature,
    messages: [{role: "user", content: $prompt}]
  }')

score=""
reason=""
for attempt in 1 2 3; do
  response=$(curl -s --max-time 30 https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "content-type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    -d "$json_payload" 2>/dev/null) || {
    echo "  [llm-judge] Attempt $attempt failed (curl error)" >&2
    sleep 2
    continue
  }

  raw_text=$(echo "$response" | jq -r '.content[0].text // ""' 2>/dev/null) || raw_text=""

  api_error=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null) || api_error=""
  if [[ -n "$api_error" ]]; then
    echo "  [llm-judge] Attempt $attempt API error: $api_error" >&2
    sleep 2
    continue
  fi

  score=$(echo "$raw_text" | jq -r '.score // empty' 2>/dev/null) || score=""
  reason=$(echo "$raw_text" | jq -r '.reason // ""' 2>/dev/null) || reason=""

  if [[ -n "$score" && "$score" != "null" ]]; then
    break
  fi

  echo "  [llm-judge] Attempt $attempt: could not parse score from: $raw_text" >&2
  sleep 2
done

if [[ -z "$score" || "$score" == "null" ]]; then
  echo "  [llm-judge] All attempts failed for $dimension, defaulting to 0" >&2
  score="0"
  reason="all LLM judge attempts failed"
fi

if [[ -d "$LOG_DIR" ]]; then
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -n \
    --arg dimension "$dimension" \
    --arg score "$score" \
    --arg reason "$reason" \
    --arg timestamp "$timestamp" \
    '{dimension: $dimension, score: ($score | tonumber), reason: $reason, timestamp: $timestamp}' >> "$LOG_DIR/llm-judge.log"
fi

echo "$score"
