# Testbot Business Case Eval

Automated evaluation of the **business case quality** in Skyramp Testbot PR reports.

Testbot generates a `businessCaseAnalysis` field in every report — a paragraph explaining *why* the recommended tests matter for the business. This eval framework measures how well that text connects to the actual code changes in the PR.

## How It Works

The eval uses the **real testbot GitHub Action** running in 4 forked repos. For each eval PR:

1. `run-eval.sh` reads the repo config from `$EVAL_FRAMEWORK_DIR/test_repos/forked/<num>/testbot-config.yml`
2. It clones the forked repo (e.g. `roshinimichael/directus`) and applies `diff.patch` to a new `eval/<pr-name>` branch
3. It patches `skyramp-testbot.yml` in that branch to use `TESTBOT_REPO@TESTBOT_REF` — so the forked repo runs the testbot branch under review, not a pinned release
4. It pushes the branch and opens a PR against the fork's default branch
5. The fork's `skyramp-testbot.yml` workflow triggers (using secrets pre-configured in the fork)
6. `run-eval.sh` waits for the workflow to complete, downloads the `skyramp-testbot-report` artifact → `testbot-result.txt`
7. It scores the `businessCaseAnalysis` field on 4 dimensions
8. The eval PR is closed and the branch is deleted automatically

## What's Evaluated

Each testbot run produces a `testbot-result.txt` (JSON). The eval scores the `businessCaseAnalysis` field:

| # | Dimension | Method | Description |
|:-:|-----------|--------|-------------|
| D1 | **Relevance** | LLM judge | Does it address the actual PR changes? |
| D2 | **Specificity** | LLM judge | Are specific endpoint paths or feature names mentioned? |
| D3 | **Value Articulation** | LLM judge | Does it explain *why* testing these changes matters? |
| D4 | **Report Completeness** | jq | Are `businessCaseAnalysis` and `testResults` both present and non-empty? |
| D5 | **Clarity** | LLM judge | Is the business case concise and easy to understand? |

**Pass threshold per PR:** ≥ 62.5% of dimensions (≥ 3.125 / 5)
**Overall verdict:** PASS if ≥ 80% of scored PRs pass

## Eval Repos

4 private forked repos under `roshinimichael/` on GitHub, each with `skyramp-testbot.yml` and required secrets pre-configured. Repo fixtures (config, patches, expected outputs) live in [letsramp/eval-framework](https://github.com/letsramp/eval-framework) under `test_repos/forked/`, branch `roshinimichael/testbot-eval-setup`:

| # | Fork | Source | Stack | PR |
|---|------|--------|-------|----|
| 11 | roshinimichael/parse-server-example | parse-community/parse-server-example | Node.js / Parse Server | pr-a-add-health-endpoint |
| 12 | roshinimichael/flagsmith-testb | Flagsmith/flagsmith | Python / Django REST | pr-a-add-bulk-evaluate |
| 13 | roshinimichael/prefect-testb | PrefectHQ/prefect | Python / FastAPI | pr-a-add-flow-run-cancel |
| 14 | roshinimichael/directus | directus/directus | TypeScript / Node.js | pr-a-add-item-export |

Each repo's `testbot-config.yml` in eval-framework specifies:
```yaml
repo: roshinimichael/<fork-name>
fork_name: <fork-name>
```

## Running Evals

### Via GitHub Actions (recommended)

**Manual trigger** — from the Actions tab on branch `roshinimichael/business_case_eval`, run "Business Case Eval". Optionally filter by repo number or PR name.

**From a PR** — add the label `run-business-case-eval` to any testbot PR. Results are posted back as a PR comment after the run.

**Weekly schedule** — runs automatically every Monday at 7am UTC.

### Required secrets (in this repo)

| Secret | Used for |
|--------|----------|
| `PAT_TOKEN` | Clone forked repos, push eval branches, open/close PRs, download artifacts |
| `ANTHROPIC_KEY` | LLM judge scoring (D1–D3) |
| `GH_ORG_PRIVATE_PAT` | Checkout letsramp/eval-framework (private) |

Note: Testbot-specific secrets (`SKYRAMP_LICENSE`, `SKYRAMP_TESTBOT_API_KEY`, etc.) are in the **forked repos**, not this repo — the testbot Action running there reads them directly.

### Locally (for debugging)

```bash
export GH_PAT=ghp_...
export TESTBOT_REPO=letsramp/testbot
export TESTBOT_REF=roshinimichael/business_case_eval
export ANTHROPIC_API_KEY=sk-ant-...
export EVAL_FRAMEWORK_DIR=/Users/roshinimichael/workspace/dev/eval-framework  # branch: roshinimichael/testbot-eval-setup

# Dry run (no push, no PR)
eval/scripts/run-eval.sh --repo 14 --dry-run

# Single repo
eval/scripts/run-eval.sh --repo 14

# Single PR within a repo
eval/scripts/run-eval.sh --repo 14 --pr pr-a-add-item-export

# Re-score stored results without re-running testbot
eval/scripts/run-eval.sh --repo 14 --rescore-only
```

## Directory Structure

Repo fixtures live in [letsramp/eval-framework](https://github.com/letsramp/eval-framework) on branch `roshinimichael/testbot-eval-setup`:

```
eval-framework/
  test_repos/
    forked/
      11-parse-server-example/
        config.yaml              ← used by recommendation eval (do not modify)
        testbot-config.yml       ← testbot eval config: repo + fork_name
        prs/
          pr-a-add-health-endpoint/
            diff.patch           ← git patch applied to the forked repo
            expected.json        ← scoring criteria for the LLM judge
      12-flagsmith/      ...
      13-prefect/        ...
      14-directus/       ...
```

Scripts and results in this repo:

```
eval/
  scripts/
    run-eval.sh          ← main runner: clone → apply patch → open PR → wait → download → score
    aggregate.sh         ← compile results into summary.md
    eval-agent.sh        ← standalone local agent runner (no GitHub PR flow)
    lib/
      llm-judge.sh       ← LLM-as-judge for D1/D2/D3
  results/               ← generated at runtime (gitignored)
    summary.md
    <repo>/<pr>/testbot-result.txt
    <repo>/<pr>/score.json
    <repo>/<pr>/llm-judge.log
    <repo>/<pr>/run-meta.json
```

## Adding a New Eval Repo

1. Fork the target source repo to `roshinimichael/<fork-name>` (private)
2. Add `skyramp-testbot.yml` to the fork with all required secrets configured
3. In [letsramp/eval-framework](https://github.com/letsramp/eval-framework) on branch `roshinimichael/testbot-eval-setup`, add:
   - `test_repos/forked/NN-<name>/testbot-config.yml` with `repo:` and `fork_name:`
   - `test_repos/forked/NN-<name>/prs/<pr-name>/diff.patch`
   - `test_repos/forked/NN-<name>/prs/<pr-name>/expected.json`
4. Add the new entry to the matrix in `.github/workflows/eval-matrix.yml`

## Creating a diff.patch

```bash
# In your fork, create a branch with the synthetic PR change
git checkout -b eval/pr-a-my-change
# ... make changes ...
git add -A && git commit -m "feat: my change"

# Export the patch relative to the default branch
# (save to eval-framework, not this repo)
git diff main...eval/pr-a-my-change \
  > /path/to/eval-framework/test_repos/forked/NN-repo/prs/pr-a-my-change/diff.patch
```

## Adding a New Scoring Dimension

1. Add a new `case` to `eval/scripts/lib/llm-judge.sh` with a scoring rubric
2. Add the score variable and `jq` call in `score_report()` in `eval/scripts/run-eval.sh`
3. Update `dim_names`, `dim_keys`, and table headers in `eval/scripts/aggregate.sh`
4. Update this README
