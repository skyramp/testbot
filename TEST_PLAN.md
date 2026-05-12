# Test Plan: Retry Cleanup of Generated Test Files

## Problem

When the agent completes an attempt but fails to produce a report (e.g. `skyramp_submit_report`
called after exhausting context in 70 turns), any test files written to disk persist into the
next retry. The retry's `skyramp_analyze_changes` sees those orphaned files as pre-existing
Skyramp tests, scores them IGNORE, and generates additional tests to fill the GENERATE budget
— producing more files than `maxGenerate` allows.

**Observed:** directus PR #79 (run `25688924282`) — attempt 1 generated 3 tests and failed to
report; attempt 2 found those 3 as "existing", generated 2 more → 5 tests committed instead of 3.

## Fix

In `executeAgent()` (inside the `if ((transientCrash || emptyResult) && attempt < maxRetries)`
block), before sleeping and retrying:

```
git checkout -- .   # restore modified tracked files (e.g. extended contract test)
git clean -fd       # remove new untracked files (generated .spec.ts / scenario_*.json)
```

Both run with `ignoreReturnCode: true` and are wrapped in a try/catch so they never break the
retry flow on a clean tree.

---

## Test Cases

### TC-1 — Happy path: single attempt succeeds, no cleanup runs
**Setup:** normal PR where the agent succeeds on attempt 1.
**Expected:** retry block is never entered; no `git checkout`/`git clean` calls in the debug log;
final committed file count equals `maxGenerate` (default 3).
**Verify:** `[debug] Cleaned up generated test files` does NOT appear in the Actions log.

---

### TC-2 — Retry after "no report produced": generated files are cleaned before attempt 2
**Setup:** simulate attempt 1 generating files but not writing the summary — easiest to reproduce
by setting `testbotTimeout` to a very low value (e.g. 2 min) so the agent times out mid-run after
generating a test or two.
**Expected:**
- Actions log contains `[warning] Agent no report produced (attempt 1/N). Retrying in Xs...`
- Actions log contains `[debug] Cleaned up generated test files from failed attempt before retry`
- Attempt 2 starts with a clean working tree: `skyramp_analyze_changes` reports 0 existing Skyramp
  tests for this service
- Final committed test count <= `maxGenerate`

**Verify via Actions log search:** `Cleaned up generated test files`

---

### TC-3 — Retry after transient crash: generated files are also cleaned
**Setup:** force a `Connection stalled` or equivalent transient error during attempt 1 (can be
simulated by temporarily blocking the Anthropic API endpoint in network policy, or by patching
`isTransientAgentError` to return `true`).
**Expected:** same cleanup behaviour as TC-2 — working tree is restored before attempt 2.

---

### TC-4 — Cleanup on a clean tree is a no-op (does not error)
**Setup:** agent fails with no report AND no test files were generated (e.g. it crashed before
any `skyramp_batch_scenario_test_generation` call).
**Expected:** `git checkout -- .` and `git clean -fd` both exit 0 on a clean tree; retry proceeds
normally; no error is thrown.
**Verify:** `[debug] Cleaned up generated test files` still appears (the try block runs), and the
subsequent attempt starts normally.

---

### TC-5 — Modified tracked file is restored (contract test extended in failed attempt)
**Setup:** attempt 1 generates a scenario where an existing contract test file is extended with a
new test case (tracked file modified), then fails to report.
**Expected:** `git checkout -- .` restores the file to its pre-attempt state; attempt 2 sees the
original (unmodified) contract test as an existing test and correctly processes it.

---

### TC-6 — maxRetries=1: cleanup block is skipped entirely
**Setup:** set `testbotMaxRetries: 1`.
**Expected:** the `attempt < maxRetries` guard is false; cleanup never runs; error is emitted
after the single failed attempt as before.

---

## How to Run

### Manual (against a real directus-like repo)
1. On a feature branch, configure `.skyramp/workspace.yml` and `skyramp-testbot.yml` with
   `testbotMaxRetries: 3` and `testbotTimeout: 2` (2-minute timeout to force a mid-run failure).
2. Open a PR — the testbot will trigger, hit the timeout, and retry.
3. Check the Actions log for `Cleaned up generated test files`.
4. Check the committed file count on the side PR is <= `maxGenerate`.

### Automated (unit-level, if a test harness is added to this repo)
Mock `exec2`, `fs17`, and `sleep` in a unit test for `executeAgent`:
- Assert that when `emptyResult=true` and `attempt < maxRetries`, `exec2` is called with
  `["checkout", "--", "."]` then `["clean", "-fd"]` before `sleep`.
- Assert that when `emptyResult=false` (success), `exec2` is NOT called with those args.
- Assert that when `attempt === maxRetries`, `exec2` is NOT called (no cleanup on final attempt).
