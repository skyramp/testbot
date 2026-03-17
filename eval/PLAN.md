# Business Case Eval — Plan

## Goal

Systematically measure whether Testbot's `businessCaseAnalysis` field is:
1. **Relevant** to the actual code changes in the PR
2. **Specific** in naming affected endpoints and features
3. **Value-articulating** — explains *why* these tests matter for the business

---

## Scoring Dimensions

### D1 — Relevance (LLM judge)

**What it measures:** Does the business case directly address the code changes in this PR? Does it mention the specific endpoints, services, or feature areas that were modified?

**Rubric:**
- `1.0` — Explicitly names the changed endpoints or features and connects them to test coverage needs
- `0.5` — Broadly addresses the PR area but vague about specific changes
- `0.0` — Generic/boilerplate; could apply to any PR

**Signal:** If D1 is consistently low, testbot is not grounding its analysis in the PR diff, or the agent is ignoring the diff context.

### D2 — Specificity (LLM judge)

**What it measures:** Are concrete technical details present — endpoint paths, HTTP methods, service names, field names?

**Rubric:**
- `1.0` — Names specific paths (e.g. `GET /api/articles/feed/favorites`), HTTP methods, or field names
- `0.5` — Mentions feature names but not endpoint paths or methods
- `0.0` — Pure prose; no technical grounding

**Signal:** If D2 is low, the agent is generating high-level narrative instead of technically grounded analysis.

### D3 — Value Articulation (LLM judge)

**What it measures:** Does the text explain *why* testing these changes matters — not just *what* changed?

**Rubric:**
- `1.0` — States a specific business risk, user impact, or outcome (e.g. "regressions here block checkout revenue")
- `0.5` — Generic rationale like "ensures correctness" without specific impact
- `0.0` — Describes what is being tested with no business context

**Signal:** If D3 is low, the business case reads like a changelog rather than a justification.

### D4 — Report Completeness (jq)

**What it measures:** Did testbot produce a structurally complete report? Specifically: are both `businessCaseAnalysis` (non-empty string) and `testResults` (non-empty array) present?

**Scoring:** `1.0` if both fields present and non-empty, `0.5` if only business case, `0` if neither.

**Signal:** If D4 is consistently below 1.0, testbot is failing to call `skyramp_submit_report` correctly, or calling it without test results.

### D5 — Clarity (LLM judge)

**What it measures:** Is the business case concise and easy to understand? Can a developer reader grasp the key message in one read?

**Rubric:**
- `1.0` — Direct, no filler, no jargon. Core message is immediately clear.
- `0.5` — Mostly clear but contains some redundancy, padding, or overly complex phrasing.
- `0.0` — Verbose, repetitive, or jargon-heavy; the core message is buried.

**Signal:** If D5 is consistently low, the agent is generating padded or overly formal prose instead of a clear, direct business case.

---

## Pass Threshold

Per PR: `total ≥ 3.125 / 5` (62.5%)
Overall verdict: PASS if `pass_rate ≥ 80%`

---

## Eval Report → Prompt Iteration Loop

When the verdict is FAIL, look at which dimensions have the lowest averages:

| Weak dimension | Likely root cause | Fix |
|----------------|-------------------|-----|
| D1 low | Prompt doesn't emphasise diff context | Update testbot prompt to require specific PR analysis |
| D2 low | Agent uses vague language | Add explicit instruction to name endpoints in business case |
| D3 low | Agent writes a changelog, not a justification | Add rubric: "explain the business or user risk if untested" |
| D4 low | Agent skips `skyramp_submit_report` or submits empty | Check MCP tool call logs; update prompt to enforce submission |
| D5 low | Agent produces verbose or jargon-heavy text | Add instruction: "be concise — one to two sentences per key point, no filler" |

---

## How Reports Are Generated

The eval uses the **real testbot GitHub Action** running in 4 private forked repos under `roshinimichael/`, so it tests the exact code under review — not a standalone agent or a released version.

Repo fixtures (`testbot-config.yml`, `diff.patch`, `expected.json`) live in [letsramp/eval-framework](https://github.com/letsramp/eval-framework) on branch `roshinimichael/testbot-eval-setup` under `test_repos/forked/11–14`. The CI checks out eval-framework at that branch and points `EVAL_FRAMEWORK_DIR` at it.

### Eval Repos

| # | Fork | Source |
|---|------|--------|
| 11 | roshinimichael/parse-server-example | parse-community/parse-server-example |
| 12 | roshinimichael/flagsmith-testb | Flagsmith/flagsmith |
| 13 | roshinimichael/prefect-testb | PrefectHQ/prefect |
| 14 | roshinimichael/directus | directus/directus |

Each fork has `skyramp-testbot.yml` and all required secrets pre-configured. The `testbot-config.yml` in eval-framework specifies `repo:` and `fork_name:` — `run-eval.sh` reads `repo:` to get the full `owner/name`, ensuring pushes always go to the private fork and never to the upstream public repo.

### Per-PR Flow

1. `run-eval.sh` reads `testbot-config.yml` from `$EVAL_FRAMEWORK_DIR/test_repos/forked/<num>/`, then clones the private fork with PAT auth
2. It applies `diff.patch` to a new `eval/<pr-name>` branch
3. It patches `skyramp-testbot.yml` in that branch to replace the pinned testbot ref with `TESTBOT_REPO@TESTBOT_REF` (the branch being evaluated), so the fork's workflow runs the PR's code — not a released version
4. It pushes the branch and opens a PR against the fork's default branch
5. The fork's `skyramp-testbot.yml` triggers automatically
6. `run-eval.sh` polls until the workflow completes, then downloads the `skyramp-testbot-report` artifact → `testbot-result.txt`
7. It scores the `businessCaseAnalysis` field using `llm-judge.sh` (D1–D3) and `jq` (D4)
8. The eval PR is closed and the branch is deleted automatically (cleanup trap fires on return/exit/interrupt)

**Why use the real GitHub Action?**
The testbot Action sets up Docker, runs the agent CLI, starts services, and captures real `testResults`. This gives D4 (Report Completeness) meaningful signal — without real test execution, `testResults` would always be empty and D4 would max at 0.5.

**Rescore-only mode:** Once `testbot-result.txt` files exist in `eval/results/`, run `--rescore-only` to re-score without re-running the agent. Useful when adjusting the LLM judge rubric or scoring thresholds.
