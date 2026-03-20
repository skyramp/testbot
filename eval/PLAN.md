# Business Case Eval — Plan

## Goal

Systematically measure whether Testbot's `businessCaseAnalysis` field is:
1. **Relevant** — identifies user interactions impacted by the PR
2. **Specific** — covers the full feature as a unit, not just added endpoints
3. **Value-articulating** — states key user actions enabled, without describing tests
4. **Clear** — concise and focused on user/business value, not test mechanics

---

## Scoring Dimensions

### D1 — Relevance (LLM judge)

**What it measures:** Does the business case identify the user interactions impacted by this PR and connect them to test coverage needs?

**Rubric:**
- `1.0` — Identifies specific user interactions or flows affected (e.g. "customers can leave and view reviews") and connects them to the need for test coverage post-merge
- `0.5` — Mentions affected functionality but frames it as technical changes rather than user interactions, or only partially covers impacted flows
- `0.0` — Generic/boilerplate; no connection to user-facing impact

**Signal:** If D1 is consistently low, testbot is describing code changes instead of user interactions — update the prompt to focus on user journeys.

### D2 — Specificity (LLM judge)

**What it measures:** Does the business case cover the full feature as a unit (all related endpoints), not just the newly added ones?

**Rubric:**
- `1.0` — Treats the affected feature end-to-end (e.g. for a reviews PR: covers both POST /reviews AND GET /reviews as the complete user-facing flow)
- `0.5` — Names some endpoints but only the ones added in the diff, missing related endpoints that are part of the same user flow
- `0.0` — No specific endpoint paths, feature names, or user flow details

**Signal:** If D2 is low, testbot is scoping coverage too narrowly to the diff — update the prompt to reason about the full feature unit.

### D3 — Value Articulation (LLM judge)

**What it measures:** Does the business case state the key user actions enabled or protected by this PR, without describing what the tests do?

**Rubric:**
- `1.0` — Clearly states the primary user actions or use cases enabled/protected. Does NOT describe test mechanics. Focuses on the most important user-facing impact.
- `0.5` — Mentions user impact but either focuses on a secondary change (missing the primary use case), or mixes business value with test descriptions
- `0.0` — Primarily describes what the tests do rather than articulating user value

**Signal:** If D3 is low, the business case reads like a test plan instead of a value statement — add instruction to focus on user impact, not test mechanics.

### D4 — Clarity (LLM judge)

**What it measures:** Is the business case concise and focused on user/business value — not test mechanics?

**Rubric:**
- `1.0` — Direct, focused purely on user interactions and business value. No test descriptions, no filler.
- `0.5` — Mostly clear but spends significant text describing test mechanics instead of user/business value
- `0.0` — Primarily a description of what tests do; user value is buried or absent

**Signal:** If D4 is consistently low, the agent is narrating test execution instead of making a business case — add instruction: "describe user value only, do not describe what the tests do".

---

## Pass Threshold

Per PR: `total ≥ 3 / 4` (75%)
Overall verdict: PASS if `pass_rate ≥ 80%`

---

## Eval Report → Prompt Iteration Loop

When the verdict is FAIL, look at which dimensions have the lowest averages:

| Weak dimension | Likely root cause | Fix |
|----------------|-------------------|-----|
| D1 low | Testbot describes code changes, not user interactions | Update prompt: "focus on which user journeys are affected by this PR" |
| D2 low | Testbot scopes coverage only to added endpoints | Update prompt: "consider the full feature unit, not just changed endpoints" |
| D3 low | Testbot describes tests instead of user value | Update prompt: "state the key user actions enabled — do not describe what tests do" |
| D4 low | Testbot narrates test execution instead of business case | Update prompt: "describe user value only, do not describe test mechanics" |

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
7. It scores the `businessCaseAnalysis` field using `llm-judge.sh` (D1–D4)
8. The eval PR is closed and the branch is deleted automatically (cleanup trap fires on return/exit/interrupt)

**Rescore-only mode:** Once `testbot-result.txt` files exist in `eval/results/`, run `--rescore-only` to re-score without re-running the agent. Useful when adjusting the LLM judge rubric or scoring thresholds.
