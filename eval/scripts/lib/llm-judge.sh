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
    rubric="Score how RELEVANT the business case analysis is to the actual PR changes and the USER INTERACTIONS impacted.

CONTEXT:
- PR description: $description
- Changed endpoints: $changed_endpoints
- Expected mentions: $should_mention

SCORING RUBRIC:
- 1.0: Explicitly addresses the specific code changes AND identifies the user interactions or user flows affected by this PR (e.g. 'users can now export items', 'customers can leave and view reviews'). Connects those interactions to the need for test coverage to validate correct behavior post-merge.
- 0.5: Mentions the affected endpoints or features by name but frames it as technical changes rather than user interactions, or only partially covers the impacted user flows.
- 0.0: Generic/boilerplate with no meaningful connection to the actual PR changes or user-facing impact. Could have been written for any PR.

EXAMPLES:
'This PR enables customers to leave product reviews and see them reliably — tests validate both the submission and retrieval flows to prevent regressions that would break this user journey' → Score 1.0 (specific changes + user interactions + why coverage matters)
'Tests cover the GET /articles/feed/favorites endpoint and its interaction with the user follow system' → Score 0.5 (specific endpoint but framed technically, not as user interaction)
'Tests ensure the API functions correctly' → Score 0.0 (completely generic)"
    ;;

  specificity)
    rubric="Score how SPECIFIC and CONCRETE the business case analysis is, and whether it covers the FULL FEATURE as a unit — not just the newly added endpoints.

CONTEXT:
- PR description: $description
- Changed endpoints: $changed_endpoints
- Expected mentions: $should_mention

SCORING RUBRIC:
- 1.0: Names specific endpoint paths (e.g. 'GET /api/articles/feed'), HTTP methods, or field names AND treats the affected feature as a unit to be validated end-to-end (e.g. for a reviews PR: covers both POST /reviews AND GET /reviews as the full user-facing flow), not just the endpoints added in the diff.
- 0.5: Names some specific endpoints or features but either omits HTTP methods/paths, or only covers the newly added endpoints and misses related endpoints that form part of the same user-facing feature.
- 0.0: No specific endpoint paths, methods, field names, or feature names. Pure prose with no technical grounding.

EXAMPLES:
'Validates the full reviews workflow: POST /api/reviews to submit and GET /api/packages/{slug}/reviews to confirm visibility — ensuring the end-to-end user journey works' → Score 1.0 (specific paths + full feature unit)
'Tests the POST /reviews endpoint that was added in this PR' → Score 0.5 (specific but only covers added endpoint, misses GET)
'Ensures the new feature works as expected' → Score 0.0"
    ;;

  value_articulation)
    rubric="Score how well the business case articulates WHY testing these changes matters and identifies the KEY USER ACTIONS enabled or protected — without describing what the tests do.

CONTEXT:
- PR description: $description

SCORING RUBRIC:
- 1.0: Clearly explains the business impact or user risk if the functionality breaks AND states the primary user actions or use cases enabled/protected by this PR. Connects test coverage to a specific user flow or business outcome. Does NOT describe test mechanics or focus on secondary changes.
- 0.5: Mentions business impact or user actions but either (a) focuses on a secondary use case while missing the primary one, (b) gives a generic rationale like 'ensures correctness' without specific user impact, or (c) mixes valid business value with descriptions of what the tests do.
- 0.0: Primarily describes what the tests do (e.g. 'the tests verify POST /reviews returns 201') with no explanation of user value or business impact.

EXAMPLES:
'This PR enables customers to submit product reviews and ensures those reviews are immediately visible to other shoppers — regressions here would break the core social proof loop that drives purchase decisions' → Score 1.0 (primary user action + business risk, no test description)
'The key change adds UI support, and tests validate the new component renders correctly' → Score 0.5 (focuses on secondary change, describes tests)
'The tests verify that POST /reviews returns 201 and GET /reviews returns the submitted data' → Score 0.0 (pure test description, no business value)"
    ;;

  clarity)
    rubric="Score how CONCISE and CLEAR the business case analysis is — focused on user/business value, NOT on describing what the tests do.

SCORING RUBRIC:
- 1.0: Direct, no unnecessary filler, no repeated points, no jargon. Focused purely on user interactions and business value. No test descriptions. Core message is immediately clear in one read.
- 0.5: Mostly clear but either (a) contains some redundancy, padding, or overly complex phrasing, or (b) spends significant text describing test mechanics instead of focusing on user/business value.
- 0.0: Verbose, repetitive, or hard to follow. Primarily describes what the tests do rather than making a business case. The actual user value is buried or absent.

EXAMPLES:
'Customers can submit reviews and see them immediately — these tests prevent regressions in both flows before they reach production.' → Score 1.0 (tight, plain, pure business value)
'The tests cover the POST /reviews endpoint which was added in this PR to allow users to submit reviews, and the integration test verifies a 201 response is returned.' → Score 0.5 (mixes test description with value)
'The integration test sends a POST request to /reviews with a valid payload and asserts a 201 status, then calls GET /reviews to verify the item appears in the list.' → Score 0.0 (pure test description, no business value)"
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
