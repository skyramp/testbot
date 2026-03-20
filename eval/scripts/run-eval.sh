#!/usr/bin/env bash
set -euo pipefail

# Evaluate testbot business case quality using the real testbot GitHub Action.
#
# For each PR (single diff.patch):
#   1. Clone the forked repo with PAT auth
#   2. Apply diff.patch, then patch skyramp-testbot.yml to use the current
#      testbot PR branch (TESTBOT_REPO@TESTBOT_REF) instead of the hardcoded
#      release branch — so the eval tests THIS branch's code
#   3. Push to GitHub and open a PR
#   4. Wait for the skyramp-testbot.yml workflow to complete
#   5. Download the skyramp-testbot-report artifact → testbot-result.txt
#   6. Score businessCaseAnalysis with llm-judge.sh (D1–D4)
#   7. Close the PR and delete the remote branch when done
#
# Usage:
#   eval/scripts/run-eval.sh [--repo <num>] [--pr <name>] [--rescore-only] [--dry-run]
#
# Environment (required):
#   GH_PAT          — PAT with repo scope on the forked repos (push + PR + artifact read)
#   TESTBOT_REPO    — testbot action repo, e.g. skyramp/testbot
#   TESTBOT_REF     — testbot branch to test, e.g. roshinimichael/business_case_eval
#
# Environment (optional):
#   ANTHROPIC_API_KEY  — for LLM judge D1-D3 (defaults to 0 if unset)
#   EVAL_WORK_ROOT     — local clone directory (default: /tmp/eval-work)
#   TESTBOT_WORKFLOW   — workflow filename in forked repos (default: skyramp-testbot.yml)
#   TESTBOT_TIMEOUT    — seconds to wait per testbot run (default: 1800)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(dirname "$SCRIPT_DIR")"
WORK_ROOT="${EVAL_WORK_ROOT:-/tmp/eval-work}"
REPOS_DIR="${EVAL_FRAMEWORK_DIR:?Set EVAL_FRAMEWORK_DIR to your local clone of letsramp/eval-framework}/test_repos"
TESTBOT_WORKFLOW="${TESTBOT_WORKFLOW:-skyramp-testbot.yml}"
TESTBOT_TIMEOUT="${TESTBOT_TIMEOUT:-1800}"

# Validate required env vars
for var in GH_PAT TESTBOT_REPO TESTBOT_REF; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is required"
    exit 1
  fi
done

export GH_TOKEN="$GH_PAT"
export GITHUB_TOKEN="$GH_PAT"

# Load ANTHROPIC_API_KEY from .env if not already set
if [[ -z "${ANTHROPIC_API_KEY:-}" && -f "$EVAL_DIR/../.env" ]]; then
  api_key=$(grep '^ANTHROPIC_API_KEY=' "$EVAL_DIR/../.env" | cut -d= -f2-)
  if [[ -n "$api_key" ]]; then
    export ANTHROPIC_API_KEY="$api_key"
    echo "Loaded ANTHROPIC_API_KEY from .env"
  fi
fi

usage() {
  echo "Usage: $0 [--repo <num>] [--pr <name>] [--rescore-only] [--dry-run]"
  echo ""
  echo "  --repo <num>      Only evaluate this repo (e.g., --repo 1 or --repo 01)"
  echo "  --pr <name>       Only evaluate this PR (e.g., --pr pr-a-add-health-endpoint)"
  echo "  --rescore-only    Re-score stored testbot-result.txt without re-running testbot"
  echo "  --dry-run         Print what would be evaluated without running anything"
  exit "${1:-1}"
}

FILTER_REPO=""
FILTER_PR=""
RESCORE_ONLY=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) FILTER_REPO="$2"; shift 2 ;;
    --pr) FILTER_PR="$2"; shift 2 ;;
    --rescore-only) RESCORE_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

get_full_repo() {
  local repo_dir="$1"
  if [[ ! -f "$repo_dir/testbot-config.yml" ]]; then
    echo "ERROR: testbot-config.yml not found in $repo_dir" >&2
    exit 1
  fi
  grep '^repo:' "$repo_dir/testbot-config.yml" | awk '{print $2}'
}

get_default_branch() {
  local repo_path="$1"
  git -C "$repo_path" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
    | sed 's@^refs/remotes/origin/@@' \
    || echo "main"
}

# Rewrite `uses: <any-testbot-ref>` in skyramp-testbot.yml to point at TESTBOT_REPO@TESTBOT_REF.
patch_testbot_workflow() {
  local work_dir="$1"
  local workflow_path="$work_dir/.github/workflows/$TESTBOT_WORKFLOW"

  if [[ ! -f "$workflow_path" ]]; then
    echo "  WARN: $TESTBOT_WORKFLOW not found — skipping patch"
    return 0
  fi

  sed -i.bak "s|uses: [^ ]*testbot@[^ ]*|uses: ${TESTBOT_REPO}@${TESTBOT_REF}|g" "$workflow_path" && rm -f "$workflow_path.bak"
  echo "  Patched $TESTBOT_WORKFLOW → uses: ${TESTBOT_REPO}@${TESTBOT_REF}"
}

# Poll until the testbot workflow run triggered on our branch (after $since) completes.
# Prints the run ID on success; returns 1 on timeout.
wait_for_testbot_run() {
  local full_repo="$1"
  local branch="$2"
  local since="$3"

  local elapsed=0 interval=30 run_id=""

  echo "    Waiting for testbot run on $branch (timeout ${TESTBOT_TIMEOUT}s)..." >&2

  while [[ $elapsed -lt $TESTBOT_TIMEOUT ]]; do
    if [[ -z "$run_id" ]]; then
      run_id=$(gh run list \
        --repo "$full_repo" \
        --workflow "$TESTBOT_WORKFLOW" \
        --branch "$branch" \
        --json databaseId,status,createdAt \
        --jq ".[] | select(.createdAt >= \"$since\") | .databaseId" \
        2>/dev/null | tail -1 || true)
    fi

    if [[ -n "$run_id" ]]; then
      local status
      status=$(gh run view "$run_id" \
        --repo "$full_repo" --json status --jq '.status' 2>/dev/null || echo "unknown")

      if [[ "$status" == "completed" ]]; then
        echo "    Run $run_id completed" >&2
        echo "$run_id"
        return 0
      fi
      echo "    Run $run_id: $status (${elapsed}s)..." >&2
    else
      echo "    No run found yet (${elapsed}s)..." >&2
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  echo "    ERROR: timed out after ${TESTBOT_TIMEOUT}s" >&2
  return 1
}

# Download skyramp-testbot-report artifact and extract testbot-result.txt into result_dir.
download_testbot_report() {
  local full_repo="$1"
  local run_id="$2"
  local result_dir="$3"
  local artifact_dir="$result_dir/artifact-download"
  mkdir -p "$artifact_dir"

  gh run download "$run_id" \
    --repo "$full_repo" \
    --name "skyramp-testbot-report" \
    --dir "$artifact_dir" 2>/dev/null || {
    echo "    WARN: artifact 'skyramp-testbot-report' not found for run $run_id"
    return 1
  }

  local found
  found=$(find "$artifact_dir" -name "testbot-result.txt" | head -1)
  if [[ -n "$found" ]]; then
    cp "$found" "$result_dir/testbot-result.txt"
    echo "    Report: $result_dir/testbot-result.txt"
    return 0
  fi

  echo "    WARN: testbot-result.txt not found in artifact"
  return 1
}

score_report() {
  local result_dir="$1"
  local expected_file="$2"
  local report_file="$result_dir/testbot-result.txt"
  local score_file="$result_dir/score.json"

  if [[ ! -f "$report_file" || ! -s "$report_file" ]]; then
    echo "  SKIP scoring: no testbot-result.txt"
    echo '{"error":"no report"}' > "$score_file"
    return 0
  fi

  local strictness pr_id repo_name
  strictness=$(jq -r '.strictness // "flexible"' "$expected_file")
  pr_id=$(jq -r '.pr_id // "unknown"' "$expected_file")
  repo_name=$(basename "$(dirname "$result_dir")")

  local d1=0 d2=0 d3=0 d4=0
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    d1=$("$SCRIPT_DIR/lib/llm-judge.sh" "$report_file" "$expected_file" "relevance")
    d2=$("$SCRIPT_DIR/lib/llm-judge.sh" "$report_file" "$expected_file" "specificity")
    d3=$("$SCRIPT_DIR/lib/llm-judge.sh" "$report_file" "$expected_file" "value_articulation")
    d4=$("$SCRIPT_DIR/lib/llm-judge.sh" "$report_file" "$expected_file" "clarity")
  else
    echo "  [warn] ANTHROPIC_API_KEY not set — D1/D2/D3/D4 default to 0"
  fi

  local total max_possible=4
  total=$(echo "$d1 + $d2 + $d3 + $d4" | bc)
  local threshold pass="false"
  threshold=$(echo "scale=1; $max_possible * 0.75" | bc)
  if (( $(echo "$total >= $threshold" | bc -l) )); then pass="true"; fi

  jq -n \
    --arg pr_id "$pr_id" --arg repo "$repo_name" --arg strictness "$strictness" \
    --argjson d1 "$d1" --argjson d2 "$d2" --argjson d3 "$d3" --argjson d4 "$d4" \
    --argjson total "$total" --argjson max_possible "$max_possible" --argjson pass "$pass" \
    '{pr_id:$pr_id,repo:$repo,strictness:$strictness,
      dim1_relevance:$d1,dim2_specificity:$d2,dim3_value_articulation:$d3,
      dim4_clarity:$d4,total:$total,max_possible:$max_possible,passed:$pass}' \
    > "$score_file"

  echo "  Score: D1=$d1 D2=$d2 D3=$d3 D4=$d4 → $total/$max_possible (pass=$pass)"
}

eval_pr() {
  local repo_dir="$1"
  local pr_dir="$2"
  local full_repo="$3"
  local fork_name="${full_repo##*/}"
  local pr_name
  pr_name=$(basename "$pr_dir")
  local branch_name="eval/$pr_name"
  local expected_file="$pr_dir/expected.json"

  echo ""
  echo "--- Evaluating: $fork_name / $pr_name ---"
  [[ ! -f "$expected_file" ]] && { echo "  SKIP: no expected.json"; return 0; }

  local result_dir="$EVAL_DIR/results/$fork_name/$pr_name"
  mkdir -p "$result_dir"

  # ── Rescore-only ──────────────────────────────────────────────────────────
  if $RESCORE_ONLY; then
    if [[ -f "$result_dir/testbot-result.txt" ]]; then
      echo "  Rescoring $fork_name / $pr_name..."
      score_report "$result_dir" "$expected_file"
    else
      echo "  SKIP: no testbot-result.txt to rescore"
    fi
    return 0
  fi

  # ── 1. Clone forked repo with PAT auth ────────────────────────────────────
  # Store the token as an http.extraHeader in local repo config so it never
  # appears in the remote URL (git remote -v, logs, process listings).
  local repo_url="https://github.com/${full_repo}.git"
  local auth_header="Authorization: Basic $(printf 'x-access-token:%s' "$GH_PAT" | base64 | tr -d '\n')"

  local work_dir="$WORK_ROOT/$fork_name"
  if [[ -d "$work_dir/.git" ]]; then
    echo "  Reusing clone at $work_dir"
    git -C "$work_dir" remote set-url origin "$repo_url"
  else
    rm -rf "$work_dir"
    echo "  Cloning $full_repo..."
    git -c "http.extraHeader=$auth_header" clone "$repo_url" "$work_dir"
    git -C "$work_dir" config user.email "eval-bot@ci.local"
    git -C "$work_dir" config user.name "Eval Bot"
  fi
  # Set credential for all subsequent git operations in this clone.
  git -C "$work_dir" config http.extraHeader "$auth_header"

  local default_branch
  default_branch=$(get_default_branch "$work_dir")

  # ── 2. Clean slate ────────────────────────────────────────────────────────
  git -C "$work_dir" fetch origin --prune 2>/dev/null || true
  git -C "$work_dir" push origin --delete "$branch_name" 2>/dev/null || true
  git -C "$work_dir" checkout "$default_branch"
  git -C "$work_dir" reset --hard "origin/$default_branch" 2>/dev/null || git -C "$work_dir" reset --hard
  git -C "$work_dir" clean -fdx
  git -C "$work_dir" checkout -B "$branch_name"

  local existing_pr
  existing_pr=$(gh pr list --repo "$full_repo" --head "$branch_name" \
    --json number --jq '.[0].number' 2>/dev/null || true)
  [[ -n "$existing_pr" ]] && gh pr close "$existing_pr" --repo "$full_repo" 2>/dev/null || true

  # ── 3. Locate patch ───────────────────────────────────────────────────────
  local patch_file="$pr_dir/diff.patch"
  if [[ ! -f "$patch_file" ]]; then
    echo "  SKIP: no diff.patch found"
    return 0
  fi

  # ── 4. Cleanup on return ──────────────────────────────────────────────────
  local pr_number="" branch_pushed=false
  cleanup_pr() {
    [[ -n "${work_dir:-}" ]] && git -C "$work_dir" config --unset http.extraHeader 2>/dev/null || true
    if [[ -n "${pr_number:-}" ]]; then
      echo "  Closing PR #$pr_number and deleting branch ${branch_name:-}..."
      gh pr close "$pr_number" --repo "$full_repo" 2>/dev/null || true
    fi
    if [[ "${branch_pushed:-}" == true && -n "${branch_name:-}" ]]; then
      [[ -n "${work_dir:-}" ]] && git -C "$work_dir" push origin --delete "$branch_name" 2>/dev/null || true
    fi
  }
  trap cleanup_pr RETURN EXIT INT TERM

  # ── 5. Apply patch ────────────────────────────────────────────────────────
  git -C "$work_dir" apply "$patch_file" 2>/dev/null || {
    echo "  ERROR: patch apply failed"
    echo '{"error":"patch apply failed"}' > "$result_dir/score.json"
    return 1
  }

  # Patch skyramp-testbot.yml to use current testbot PR branch
  patch_testbot_workflow "$work_dir"

  git -C "$work_dir" add -A
  git -C "$work_dir" commit \
    -m "eval: $pr_name [testbot@${TESTBOT_REF}]" 2>/dev/null || true

  local push_time
  push_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  git -C "$work_dir" push origin "$branch_name" --force-with-lease 2>/dev/null || \
    git -C "$work_dir" push origin "$branch_name" --force
  branch_pushed=true

  # ── 6. Open PR ────────────────────────────────────────────────────────────
  local pr_title
  pr_title=$(jq -r '.description // "Eval PR"' "$expected_file")
  pr_number=$(gh pr create \
    --repo "$full_repo" \
    --head "$branch_name" \
    --base "$default_branch" \
    --title "[eval] $pr_name" \
    --body "${pr_title}

> Auto-generated by testbot eval (testbot: \`${TESTBOT_REF}\`). Closed automatically." \
    | grep -o '[0-9]*$')
  if [[ -z "$pr_number" ]]; then
    echo "  ERROR: PR creation failed"
    echo '{"error":"pr creation failed"}' > "$result_dir/score.json"
    return 1
  fi
  echo "  Opened PR #$pr_number"

  # ── 7. Wait for testbot run ───────────────────────────────────────────────
  local run_id
  run_id=$(wait_for_testbot_run "$full_repo" "$branch_name" "$push_time") || {
    echo "  ERROR: testbot timed out"
    echo '{"error":"testbot timeout"}' > "$result_dir/score.json"
    return 1
  }

  # ── 8. Download report ────────────────────────────────────────────────────
  download_testbot_report "$full_repo" "$run_id" "$result_dir" || {
    echo '{"error":"artifact download failed"}' > "$result_dir/score.json"
    return 1
  }

  # ── 9. Score ──────────────────────────────────────────────────────────────
  score_report "$result_dir" "$expected_file"

  echo "{\"run_id\":$run_id,\"pr_number\":$pr_number,\"testbot_ref\":\"${TESTBOT_REF}\"}" \
    > "$result_dir/run-meta.json"
}

echo "============================================="
echo "  Testbot Business Case Eval"
echo "  Testbot:      ${TESTBOT_REPO}@${TESTBOT_REF}"
echo "  Work root:    $WORK_ROOT"
echo "  Rescore only: $RESCORE_ONLY"
echo "============================================="

total_prs=0
scored_prs=0
failed_prs=0

for repo_dir in "$REPOS_DIR"/monorepos/*/ "$REPOS_DIR"/forked/*/; do
  [[ -d "$repo_dir" ]] || continue

  repo_num=$(basename "$repo_dir" | grep -oE '^[0-9]+' || true)
  [[ -z "$repo_num" ]] && continue
  [[ -n "$FILTER_REPO" && "${repo_num#0}" != "${FILTER_REPO#0}" ]] && continue
  [[ -d "$repo_dir/prs" ]] || continue

  full_repo=$(get_full_repo "$repo_dir")
  fork_name="${full_repo##*/}"
  echo ""
  echo "========== $full_repo =========="

  for pr_dir in "$repo_dir"/prs/*/; do
    [[ -d "$pr_dir" ]] || continue
    pr_name=$(basename "$pr_dir")
    [[ -n "$FILTER_PR" && "$pr_name" != "$FILTER_PR" ]] && continue
    ((total_prs++)) || true

    if $DRY_RUN; then
      echo "  [dry-run] $full_repo / $pr_name → testbot: ${TESTBOT_REPO}@${TESTBOT_REF}"
      continue
    fi

    if eval_pr "$repo_dir" "$pr_dir" "$full_repo"; then
      ((scored_prs++)) || true
    else
      ((failed_prs++)) || true
    fi
  done
done

echo ""
echo "============================================="
echo "  Total PRs:  $total_prs"
echo "  Scored:     $scored_prs"
echo "  Failed:     $failed_prs"
echo "  Results in: $EVAL_DIR/results/"
echo "============================================="

if ! $DRY_RUN && [[ $scored_prs -gt 0 ]]; then
  echo ""
  echo "Running aggregation..."
  "$SCRIPT_DIR/aggregate.sh"
fi
