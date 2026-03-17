#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(dirname "$SCRIPT_DIR")"

output="$EVAL_DIR/results/summary.md"
mkdir -p "$(dirname "$output")"

echo "# Business Case Eval Summary" > "$output"
echo "" >> "$output"
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$output"
echo "" >> "$output"

total_prs=0
passed_prs=0
failed_prs=0
error_prs=0

# Five dimensions: D1 Relevance, D2 Specificity, D3 Value Articulation, D4 Report Completeness, D5 Clarity
dim_sums=(0 0 0 0 0)
dim_counts=(0 0 0 0 0)
dim_names=("Relevance" "Specificity" "Value Articulation" "Report Completeness" "Clarity")
dim_keys=("dim1_relevance" "dim2_specificity" "dim3_value_articulation" "dim4_report_completeness" "dim5_clarity")

echo "## Results" >> "$output"
echo "" >> "$output"
echo "| Repo | PR | D1 Relevance | D2 Specificity | D3 Value | D4 Complete | D5 Clarity | Total | Pass? |" >> "$output"
echo "|------|-----|:---:|:---:|:---:|:---:|:---:|:-----:|:-----:|" >> "$output"

# Collect score files: results/<repo>/<pr>/score.json
while IFS= read -r score_file; do
  [[ -f "$score_file" ]] || continue

  local_path="${score_file#"$EVAL_DIR/results/"}"
  repo=$(cut -d/ -f1 <<< "$local_path")
  pr=$(cut -d/ -f2 <<< "$local_path")

  if jq -e '.error' "$score_file" &>/dev/null; then
    error_msg=$(jq -r '.error' "$score_file")
    echo "| $repo | $pr | - | - | - | - | ERROR: $error_msg | - |" >> "$output"
    ((error_prs++)) || true
    ((total_prs++)) || true
    continue
  fi

  d1=$(jq '.dim1_relevance // 0' "$score_file")
  d2=$(jq '.dim2_specificity // 0' "$score_file")
  d3=$(jq '.dim3_value_articulation // 0' "$score_file")
  d4=$(jq '.dim4_report_completeness // 0' "$score_file")
  d5=$(jq '.dim5_clarity // 0' "$score_file")

  total=$(echo "$d1 + $d2 + $d3 + $d4 + $d5" | bc)
  max_possible=5
  threshold=$(echo "scale=1; $max_possible * 0.625" | bc)

  pass="NO"
  if (( $(echo "$total >= $threshold" | bc -l) )); then
    pass="YES"
    ((passed_prs++)) || true
  else
    ((failed_prs++)) || true
  fi

  echo "| $repo | $pr | $d1 | $d2 | $d3 | $d4 | $d5 | **$total/$max_possible** | $pass |" >> "$output"

  for i in 0 1 2 3 4; do
    val=$(jq ".${dim_keys[$i]} // 0" "$score_file")
    dim_sums[$i]=$(echo "${dim_sums[$i]} + $val" | bc 2>/dev/null || echo "${dim_sums[$i]}")
    dim_counts[$i]=$((${dim_counts[$i]} + 1))
  done

  ((total_prs++)) || true
done < <(find "$EVAL_DIR/results" -name "score.json" | sort)

echo "" >> "$output"
echo "## Overall" >> "$output"
echo "" >> "$output"
echo "- **Total PRs evaluated**: $total_prs" >> "$output"
echo "- **Passed**: $passed_prs" >> "$output"
echo "- **Failed**: $failed_prs" >> "$output"
if [[ $error_prs -gt 0 ]]; then
  echo "- **Errors** (missing or invalid score): $error_prs" >> "$output"
fi

if [[ $total_prs -gt 0 && $((passed_prs + failed_prs)) -gt 0 ]]; then
  scored_total=$((passed_prs + failed_prs))
  pass_rate=$(echo "scale=1; $passed_prs * 100 / $scored_total" | bc)
  echo "- **Pass rate**: ${pass_rate}% (of scored PRs)" >> "$output"
  echo "" >> "$output"

  if (( $(echo "$pass_rate >= 80" | bc -l) )); then
    echo "### Verdict: PASS" >> "$output"
    echo "" >> "$output"
    echo ">= 80% of scored PRs pass their threshold." >> "$output"
  else
    echo "### Verdict: FAIL" >> "$output"
    echo "" >> "$output"
    echo "< 80% of PRs pass. Review the weakest dimensions below and iterate on the testbot prompt." >> "$output"
  fi
else
  echo "- **Pass rate**: N/A (no scored PRs — add diff.patch and expected.json under eval/repos/.../prs/*/ and rerun run-eval.sh)" >> "$output"
fi

echo "" >> "$output"
echo "## Dimension Averages" >> "$output"
echo "" >> "$output"
echo "| # | Dimension | Average | Scored PRs |" >> "$output"
echo "|:-:|-----------|:-------:|:----------:|" >> "$output"

for i in 0 1 2 3; do
  if [[ ${dim_counts[$i]} -gt 0 ]]; then
    avg=$(echo "scale=2; ${dim_sums[$i]} / ${dim_counts[$i]}" | bc)
    echo "| D$((i+1)) | ${dim_names[$i]} | $avg | ${dim_counts[$i]} |" >> "$output"
  else
    echo "| D$((i+1)) | ${dim_names[$i]} | - | 0 |" >> "$output"
  fi
done

echo "" >> "$output"
echo "## Scoring Guide" >> "$output"
echo "" >> "$output"
echo "| Dimension | Method | Description |" >> "$output"
echo "|-----------|--------|-------------|" >> "$output"
echo "| D1 Relevance | LLM judge | Does the business case address actual PR changes? |" >> "$output"
echo "| D2 Specificity | LLM judge | Are specific endpoints / feature names mentioned? |" >> "$output"
echo "| D3 Value Articulation | LLM judge | Does it explain WHY testing matters? |" >> "$output"
echo "| D4 Report Completeness | jq | Does the report contain businessCaseAnalysis + testResults? |" >> "$output"
echo "| D5 Clarity | LLM judge | Is the business case concise and easy to understand? |" >> "$output"
echo "" >> "$output"
echo "**Pass threshold:** >= 62.5% of dimensions (3.125/5) per PR" >> "$output"
echo "" >> "$output"
echo "**Overall verdict:** PASS if >= 80% of scored PRs pass" >> "$output"
echo "" >> "$output"
echo "---" >> "$output"
echo "" >> "$output"
echo "_If verdict is FAIL, focus on dimensions with lowest averages. To add a PR: add a \`diff.patch\` under \`eval/repos/.../prs/<pr>/\` and re-run \`run-eval.sh\`._" >> "$output"

echo ""
echo "Summary written to: $output"
echo ""
cat "$output"
