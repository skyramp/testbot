# Configuration Guide

This guide provides detailed information about configuring Skyramp Testbot for your specific needs.

## Table of Contents

- [Workspace Configuration (.skyramp/workspace.yml)](#workspace-configuration-skyrampworkspaceyml)
- [Input Reference](#input-reference)
- [Output Usage](#output-usage)
- [Advanced Patterns](#advanced-patterns)
- [Environment-Specific Setup](#environment-specific-setup)
- [Best Practices](#best-practices)

## Workspace Configuration (.skyramp/workspace.yml)

Skyramp Testbot reads project-level configuration from `.skyramp/workspace.yml` — the standard Skyramp workspace config file. This file is created and maintained by the Skyramp MCP server's `skyramp_initialize_workspace` tool and validated using Zod schemas from `@skyramp/skyramp`.

### Configuration Precedence

The configuration system follows this precedence order (highest to lowest):

1. **GitHub Action workflow inputs** — Explicitly set values in the workflow file
2. **`.skyramp/workspace.yml` values** — Service-level configuration (test directory, startup command, versions)
3. **Hardcoded defaults** — Built-in fallback values (e.g., `tests`, `v1.3.15`, `latest`)

When a workflow input is explicitly provided, it always takes precedence over workspace values. When a workflow input is omitted, workspace values fill in the gap. If neither is set, hardcoded defaults are used. Testbot-specific settings (timeouts, debug, auto-commit, retries, etc.) always come from action inputs.

### File Location

The action looks for `.skyramp/workspace.yml` relative to the `workingDirectory` input (default: repository root). This file is typically created by running `skyramp_initialize_workspace` from the Skyramp MCP server.

### Workspace File Structure

```yaml
# .skyramp/workspace.yml
workspace:
  repoName: "my-api"
  repoUrl: "https://github.com/org/my-api"

metadata:
  schemaVersion: "v1"
  mcpVersion: "0.0.55"
  executorVersion: "v1.3.15"
  createdAt: "2026-01-15T10:00:00Z"
  updatedAt: "2026-02-18T14:30:00Z"

services:
  - serviceName: "api"
    language: "python"
    framework: "pytest"
    testDirectory: "tests/python"
    api:
      baseUrl: "http://localhost:8000"
      authType: "bearer"
      schemaPath: "openapi.json"
    runtimeDetails:
      serverStartCommand: "docker compose up -d"
      runtime: "docker"
```

### Field Mapping

| Workspace field | Testbot config field | Notes |
|---|---|---|
| `services[i].testDirectory` | `testDirectory` | Fallback when `testDirectory` input is empty |
| `services[i].runtimeDetails.serverStartCommand` | `targetSetupCommand` | Fallback when `targetSetupCommand` input is empty |
| `services[i].runtimeDetails.serverTeardownCommand` | `targetTeardownCommand` | Fallback when `targetTeardownCommand` input is empty |
| `services[i].language` | (passed to agent prompt) | Helps LLM generate appropriate tests |
| `services[i].framework` | (passed to agent prompt) | Helps LLM use correct test framework |
| `services[i].api.baseUrl` | (passed to agent prompt) | Helps LLM target correct URL |
| `metadata.executorVersion` | `skyrampExecutorVersion` | Fallback when `skyrampExecutorVersion` input is empty |
| `metadata.mcpVersion` | `skyrampMcpVersion` | Fallback when `skyrampMcpVersion` input is empty |

### Multi-Service Workspaces

All services defined in `.skyramp/workspace.yml` are passed to the agent prompt. The LLM receives each service's language, framework, base URL, and output directory, allowing it to generate and maintain tests for all services in a single run.

The first service's `testDirectory` and `runtimeDetails.serverStartCommand` are used as operational defaults (for action `testDirectory` and `targetSetupCommand`). During auto-commit, files are staged from each service's `testDirectory`.

### Validation and Error Handling

- If `.skyramp/workspace.yml` doesn't exist, the action proceeds with action input defaults
- If the file exists but fails Zod validation, a warning is logged and input defaults are used
- The action gracefully handles partial configurations (missing optional fields use input defaults)

## Input Reference

### Required Inputs

#### `skyrampLicenseFile`

**Description:** Skyramp license file content

**Type:** String (multiline supported)

**Storage:** GitHub Secrets (required)

**Example:**
```yaml
with:
  skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
```

**Notes:**
- Never commit license directly in workflow files
- Store in repository or organization secrets
- License is written to runner temp directory with 600 permissions
- File path: `${{ runner.temp }}/skyramp/skyramp_license.lic`

#### `cursorApiKey`

**Description:** Cursor API key for agent access

**Type:** String

**Storage:** GitHub Secrets

**Example:**
```yaml
with:
  cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
```

**Notes:**
- Obtain from Cursor dashboard
- Required when using Cursor CLI agent (default)
- Check quota limits for high-frequency workflows

#### `copilotApiKey`

**Description:** GitHub Copilot API token for agent access

**Type:** String

**Storage:** GitHub Secrets

**Example:**
```yaml
with:
  copilotApiKey: ${{ secrets.COPILOT_API_KEY }}
```

**Notes:**
- Obtain from GitHub (requires active Copilot subscription)
- Required when using GitHub Copilot CLI agent
- Can use fine-grained personal access token with "Copilot Requests" permission

### Agent Configuration

This is inferred by which API key is provided: `cursorApiKey`, `copilotApiKey`, or `anthropicApiKey` (Claude Code).

**Notes:**
- Determines which CLI will be installed and configured
- Must have exactly one corresponding API key configured
- Cursor, Copilot, and Claude Code agents all use the same Skyramp MCP server

### Optional Inputs - High Priority

#### `testDirectory`

**Description:** Directory containing Skyramp tests

**Type:** String

**Default:** `tests`

**Example:**
```yaml
with:
  testDirectory: 'api/tests'
```

**Use Cases:**
- Custom test directory structure
- Multiple test directories (see Advanced Patterns)
- Monorepo with service-specific test directories

#### `targetSetupCommand`

**Description:** Command to start services before test maintenance

**Type:** String

**Default:** `docker compose up -d`

**Examples:**

1. **Docker Compose v2:**
   ```yaml
   targetSetupCommand: 'docker compose up -d'
   ```

2. **Docker Compose v1:**
   ```yaml
   targetSetupCommand: 'docker-compose up -d'
   ```

3. **npm script:**
   ```yaml
   targetSetupCommand: 'npm run start:services'
   ```

4. **Multiple commands:**
   ```yaml
   targetSetupCommand: 'docker compose up -d && npm run migrate'
   ```

5. **Custom script:**
   ```yaml
   targetSetupCommand: './scripts/start-test-env.sh'
   ```

**Notes:**
- Command runs in `workingDirectory`
- Failures are treated as fatal: the action run will fail if this command fails
- Use `skipTargetSetup: true` if not needed
- See `targetReadyCheckCommand` for controlling readiness polling after startup

**Setup Output (JSON):**

The setup command can optionally emit a JSON object as its **last line of stdout** to override workspace configuration at runtime. This is useful when services are started on a remote host (e.g., via Buildkite) and the base URL isn't known until runtime.

Supported formats:

```json
// Single service — applies baseUrl to all services
{"baseUrl": "http://52.11.18.47:8000"}

// Multi service — per-service overrides
{"services": {"backend": {"baseUrl": "http://52.11.18.47:8000"}, "frontend": {"baseUrl": "http://52.11.18.47:5173"}}}

// Mixed — top-level default with per-service overrides
{"baseUrl": "http://52.11.18.47:8000", "services": {"frontend": {"baseUrl": "http://52.11.18.47:5173"}}}
```

Resolution order per service: `services[serviceName].baseUrl` → top-level `baseUrl` → original workspace value.

Non-JSON output is ignored — the command can freely emit log lines before the final JSON line

#### `targetTeardownCommand`

**Description:** Command to tear down services after test execution. Runs in the GitHub Actions `post` step, which is guaranteed to execute even on failure or cancellation.

**Type:** String

**Default:** `''` (empty — no teardown by default)

**Examples:**

1. **Docker Compose:**
   ```yaml
   targetTeardownCommand: 'docker compose down'
   ```

2. **Custom cleanup script:**
   ```yaml
   targetTeardownCommand: './scripts/teardown-test-env.sh'
   ```

3. **Multiple commands:**
   ```yaml
   targetTeardownCommand: 'docker compose down && rm -rf /tmp/test-data'
   ```

**Notes:**
- Runs in `workingDirectory`
- Failure is non-fatal: logs a warning but never fails the action
- Runs in the `post` step (after the main step completes), guaranteed by GitHub Actions even on cancellation
- Use `skipTargetTeardown: true` to disable without removing the command

#### `skipTargetTeardown`

**Description:** Skip running service teardown command

**Type:** Boolean

**Default:** `false`

**Example:**
```yaml
with:
  skipTargetTeardown: true
```

**Use Cases:**
- Temporary debugging where you want services to stay up
- External teardown handled by a separate workflow step

#### `targetReadyCheckCommand`

**Description:** Shell command to verify services are ready after startup. Retried every 2 seconds until it succeeds (exit code 0) or `targetReadyCheckTimeout` is reached.

**Type:** String

**Default:** `"sleep 5"`

**Examples:**

1. **HTTP health endpoint:**
   ```yaml
   targetReadyCheckCommand: 'curl -sf http://localhost:8000/health'
   ```

2. **TCP port check:**
   ```yaml
   targetReadyCheckCommand: 'nc -z localhost 5432'
   ```

3. **Docker container health:**
   ```yaml
   targetReadyCheckCommand: 'docker compose exec -T api curl -sf http://localhost:8000/health'
   ```

**Notes:**
- Runs via `bash -c`, so pipes and operators work
- Each attempt is logged for visibility
- On timeout, a warning is logged but the action continues (non-fatal)

#### `targetReadyCheckTimeout`

**Description:** Maximum seconds to wait for `targetReadyCheckCommand` to succeed

**Type:** String (numeric)

**Default:** `30`

**Example:**
```yaml
with:
  targetReadyCheckTimeout: 60
```

**Notes:**
- Only relevant when `targetReadyCheckCommand` is set
- The command is polled every 2 seconds until success or this timeout
- If the timeout is reached, a warning is emitted and execution continues

#### `targetReadyCheckDiagnosticsCommand`

**Description:** Shell command to collect diagnostics when a health check times out. Runs via `bash -c` in the working directory. Override to use non-Docker diagnostics (e.g., `journalctl`, `kubectl logs`, or custom scripts).

**Type:** String

**Default:** Docker container status and logs (last 30 lines per container)

**Examples:**

1. **Kubernetes pods:**
   ```yaml
   targetReadyCheckDiagnosticsCommand: 'kubectl get pods -o wide && kubectl logs -l app=myservice --tail=30'
   ```

2. **Systemd journal:**
   ```yaml
   targetReadyCheckDiagnosticsCommand: 'journalctl -u myservice --no-pager -n 50'
   ```

3. **Custom script:**
   ```yaml
   targetReadyCheckDiagnosticsCommand: './scripts/collect-diagnostics.sh'
   ```

**Notes:**
- Only runs when `targetReadyCheckCommand` is set and times out
- Failure of the diagnostics command is non-fatal (caught and logged)
- Runs via `bash -c`, so pipes and operators work

### Optional Inputs - Medium Priority

#### `skyrampExecutorVersion`

**Description:** Skyramp Executor Docker image version

**Type:** String

**Default:** `v1.3.15`

**Example:**
```yaml
with:
  skyrampExecutorVersion: 'v1.4.0'
```

**Notes:**
- Should match version compatible with your license
- Check [Skyramp releases](https://github.com/skyramp/executor/releases) for available versions
- Use specific version tags, not `latest` for production

#### `skyrampMcpVersion`

**Description:** Skyramp MCP npm package version

**Type:** String

**Default:** `latest`

**Example:**
```yaml
with:
  skyrampMcpVersion: '1.2.0'
```

**Notes:**
- `latest` pulls newest version each run (slower, but always current)
- Pin version for reproducible builds
- Check [npm registry](https://www.npmjs.com/package/@skyramp/mcp) for versions

#### `nodeVersion`

**Description:** Node.js version for the action

**Type:** String

**Default:** `lts/*` (matches `action.yml`; resolves to the latest LTS via `actions/setup-node`)

**Examples:**

1. **LTS (Recommended — same as omitting the input):**
   ```yaml
   nodeVersion: 'lts/*'
   ```

2. **Specific major version:**
   ```yaml
   nodeVersion: '20.x'
   ```

3. **Exact version:**
   ```yaml
   nodeVersion: '20.10.0'
   ```

**Notes:**
- Uses `actions/setup-node@v4`
- Prefer `lts/*` for the default behavior; pin `20.x` or an exact version when you need reproducibility
- Match your project's Node.js version for consistency

#### `skipTargetSetup`

**Description:** Skip running service startup command

**Type:** Boolean

**Default:** `false`

**Example:**
```yaml
with:
  skipTargetSetup: true
```

**Use Cases:**
- Services already running in previous step
- Tests don't require services
- Using external test environment
- Troubleshooting service startup issues

#### `workingDirectory`

**Description:** Working directory for action execution

**Type:** String

**Default:** `.` (repository root)

**Example:**
```yaml
with:
  workingDirectory: './services/api'
```

**Use Cases:**
- Monorepo with multiple services
- Project in subdirectory
- Custom repository structure

**Notes:**
- Affects where `targetSetupCommand` runs
- Relative to repository root
- Test directory is relative to working directory

#### `autoCommit`

**Description:** Automatically commit test changes

**Type:** Boolean

**Default:** `true`

**Example:**
```yaml
with:
  autoCommit: false
```

**When to Disable:**
- Manual review required before committing
- Organization policy requires human approval
- Testing the action without modifying repository
- Generating test suggestions only

**Alternative Workflow:**
```yaml
- uses: skyramp/testbot@v1
  with:
    autoCommit: false

- name: Upload changes
  uses: actions/upload-artifact@v4
  with:
    name: test-changes
    path: tests/
```

#### `commitMessage`

**Description:** Git commit message for test changes

**Type:** String

**Default:** `Skyramp Testbot: test maintenance suggestions`

**Examples:**

1. **Conventional Commits:**
   ```yaml
   commitMessage: 'test: update API tests via Skyramp bot'
   ```

2. **Skip CI:**
   ```yaml
   commitMessage: 'chore: update tests [skip ci]'
   ```

3. **Include PR reference:**
   ```yaml
   commitMessage: 'test: update tests for PR #${{ github.event.pull_request.number }}'
   ```

4. **Detailed message:**
   ```yaml
   commitMessage: |
     test: automated test maintenance

     Generated by Skyramp Testbot
     PR: #${{ github.event.pull_request.number }}
   ```

#### `postPrComment`

**Description:** Post test summary as PR comment

**Type:** Boolean

**Default:** `true`

**Example:**
```yaml
with:
  postPrComment: false
```

**Notes:**
- Requires `pull-requests: write` permission
- Only works on pull_request events
- Uses `peter-evans/create-or-update-comment@v4`
- Comments are updated, not duplicated

#### `testbotMaxRetries`

**Description:** Maximum number of retries for transient agent CLI errors (e.g., Cursor "Connection stalled")

**Type:** String (numeric)

**Default:** `3`

**Example:**
```yaml
with:
  testbotMaxRetries: 5
```

**Notes:**
- Only transient errors (e.g., "Connection stalled") trigger retries; other failures fail immediately
- Set to `1` to disable retries

#### `testbotRetryDelay`

**Description:** Delay in seconds between agent retry attempts

**Type:** String (numeric)

**Default:** `10`

**Example:**
```yaml
with:
  testbotRetryDelay: 30
```

**Notes:**
- Increase for environments with intermittent connectivity issues
- The total worst-case delay is `testbotMaxRetries * testbotRetryDelay` seconds

#### `enableDebug`

**Description:** Enable verbose debug logging

**Type:** Boolean

**Default:** `false`

**Example:**
```yaml
with:
  enableDebug: true
```

**What Gets Logged:**
- Git diff content
- MCP server configuration
- Active MCP servers
- Test summary content
- Internal step outputs

**Use Cases:**
- Troubleshooting issues
- Understanding agent behavior
- Development and testing
- Bug reports

**Warning:** Debug logs may contain sensitive information. Review before sharing.

## Output Usage

### Accessing Outputs

All outputs are available via step outputs:

```yaml
- uses: skyramp/testbot@v1
  id: skyramp  # Required for accessing outputs
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}

- name: Use outputs
  run: |
    echo "Summary: ${{ steps.skyramp.outputs.test_summary }}"
    echo "Modified: ${{ steps.skyramp.outputs.tests_modified }}"
    echo "Created: ${{ steps.skyramp.outputs.tests_created }}"
    echo "Executed: ${{ steps.skyramp.outputs.tests_executed }}"
```

### Output Reference

#### `test_summary`

**Type:** String (multiline)

**Description:** Full text summary of test maintenance actions

**Example Content:**
```
Test Maintenance Summary
========================

Tests Impacted and Updated:
- api/tests/user-api.yml: Updated to validate new email field
- api/tests/auth-api.yml: Modified authentication flow test

Tests Created:
- api/tests/profile-api.yml: New test for profile update endpoint

Tests Executed:
✓ api/tests/user-api.yml (PASSED)
✓ api/tests/auth-api.yml (PASSED)
✓ api/tests/profile-api.yml (PASSED)

All tests passed successfully.
```

**Usage:**
```yaml
- name: Add to job summary
  run: |
    echo "${{ steps.skyramp.outputs.test_summary }}" >> $GITHUB_STEP_SUMMARY
```

#### `tests_modified`

**Type:** String (numeric)

**Description:** Count of tests that were modified

**Example:** `"3"`

**Usage:**
```yaml
- name: Check if tests changed
  if: steps.skyramp.outputs.tests_modified > 0
  run: echo "Tests were modified!"
```

#### `tests_created`

**Type:** String (numeric)

**Description:** Count of tests that were created

**Example:** `"1"`

**Usage:**
```yaml
- name: Notify on new tests
  if: steps.skyramp.outputs.tests_created > 0
  run: |
    echo "::notice::${{ steps.skyramp.outputs.tests_created }} new tests created"
```

#### `tests_executed`

**Type:** String (numeric)

**Description:** Count of tests that were executed

**Example:** `"5"`

**Usage:**
```yaml
- name: Require tests executed
  if: steps.skyramp.outputs.tests_executed == '0'
  run: |
    echo "::error::No tests were executed!"
    exit 1
```

#### `skipped_self_trigger`

**Type:** String (boolean)

**Description:** Whether execution was skipped due to detecting testbot's own commit

**Example:** `"true"` or `"false"`

**Usage:**
```yaml
- name: Check if skipped
  run: |
    if [ "${{ steps.skyramp.outputs.skipped_self_trigger }}" = "true" ]; then
      echo "Execution was skipped (self-triggered commit detected)"
    fi
```

**Notes:**
- Returns `"true"` when the triggering commit was made by testbot itself
- Used to prevent infinite recursion when using PAT tokens
- See [Triggering Other Workflows](../README.md#triggering-other-workflows) for setup

#### `commit_sha`

**Type:** String

**Description:** SHA of the commit made by testbot (empty if no commit was made)

**Example:** `"abc123def456..."`

**Usage:**
```yaml
- name: Log commit SHA
  if: steps.skyramp.outputs.commit_sha != ''
  run: |
    echo "Test-bot committed changes: ${{ steps.skyramp.outputs.commit_sha }}"
```

**Notes:**
- Empty string if no changes were committed (no test modifications)
- Empty string if `autoCommit` is set to `false`
- Empty string if execution was skipped due to self-trigger
- Provided by the underlying `stefanzweifel/git-auto-commit-action`

### Output Patterns

#### 1. Job Summary

```yaml
- name: Create job summary
  run: |
    echo "## Test Maintenance Results" >> $GITHUB_STEP_SUMMARY
    echo "" >> $GITHUB_STEP_SUMMARY
    echo "| Metric | Count |" >> $GITHUB_STEP_SUMMARY
    echo "|--------|-------|" >> $GITHUB_STEP_SUMMARY
    echo "| Modified | ${{ steps.skyramp.outputs.tests_modified }} |" >> $GITHUB_STEP_SUMMARY
    echo "| Created | ${{ steps.skyramp.outputs.tests_created }} |" >> $GITHUB_STEP_SUMMARY
    echo "| Executed | ${{ steps.skyramp.outputs.tests_executed }} |" >> $GITHUB_STEP_SUMMARY
```

#### 2. Conditional Notifications

```yaml
- name: Slack notification
  if: steps.skyramp.outputs.tests_created > 0
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {
        "text": "${{ steps.skyramp.outputs.tests_created }} new tests created by Skyramp Bot"
      }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

#### 3. Quality Gates

```yaml
- name: Ensure test coverage
  run: |
    MODIFIED=${{ steps.skyramp.outputs.tests_modified }}
    CREATED=${{ steps.skyramp.outputs.tests_created }}
    TOTAL=$((MODIFIED + CREATED))

    if [ $TOTAL -eq 0 ]; then
      echo "::warning::No tests were modified or created. Manual review recommended."
    fi
```

## Advanced Patterns

### Pattern 1: Multiple Test Directories

Run action multiple times for different test directories:

```yaml
jobs:
  test-maintenance:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [user-service, order-service, payment-service]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: skyramp/testbot@v1
        with:
          skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
          cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
          testDirectory: 'services/${{ matrix.service }}/tests'
          workingDirectory: 'services/${{ matrix.service }}'
```

### Pattern 2: Staged Rollout

Test with manual approval before production:

```yaml
jobs:
  test-maintenance-staging:
    runs-on: ubuntu-latest
    if: github.base_ref == 'develop'
    steps:
      - uses: skyramp/testbot@v1
        with:
          autoCommit: true

  test-maintenance-production:
    runs-on: ubuntu-latest
    if: github.base_ref == 'main'
    environment: production  # Requires approval
    steps:
      - uses: skyramp/testbot@v1
        with:
          autoCommit: true
```

### Pattern 3: Caching Dependencies

Speed up workflows by caching Node modules:

```yaml
- name: Cache Node modules
  uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-

- uses: skyramp/testbot@v1
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
```

### Pattern 4: Conditional Execution

Only run on specific file changes:

```yaml
jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      api_changed: ${{ steps.filter.outputs.api }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            api:
              - 'src/api/**'

  test-maintenance:
    needs: detect-changes
    if: needs.detect-changes.outputs.api_changed == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: skyramp/testbot@v1
        with:
          skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
          cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
```

## Environment-Specific Setup

### Development Environment

```yaml
- uses: skyramp/testbot@v1
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE_DEV }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
    enableDebug: true
    autoCommit: false
    postPrComment: true
```

### Staging Environment

```yaml
- uses: skyramp/testbot@v1
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE_STAGING }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
    autoCommit: true
    commitMessage: 'test: automated update [staging]'
```

### Production Environment

```yaml
- uses: skyramp/testbot@v1
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE_PROD }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
    skyrampExecutorVersion: 'v1.3.15'  # Pinned version
    skyrampMcpVersion: '1.0.0'  # Pinned version
    autoCommit: true
    enableDebug: false
```

## Best Practices

### 1. Version Pinning

For production, pin action and dependency versions:

```yaml
- uses: skyramp/testbot@v1.0.0  # Exact version
  with:
    skyrampExecutorVersion: 'v1.3.15'
    skyrampMcpVersion: '1.0.0'
    nodeVersion: '20.x'
```

### 2. Secret Management

Use organization-level secrets for shared resources:

```yaml
with:
  skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}  # Organization secret
  cursorApiKey: ${{ secrets.CURSOR_API_KEY }}  # Repository secret
```

### 3. Permission Scoping

Only grant necessary permissions:

```yaml
permissions:
  contents: write  # For commits
  pull-requests: write  # For comments
  # Don't grant: issues, actions, deployments, etc.
```

### 4. Error Handling

Add fallback steps for critical workflows:

```yaml
- uses: skyramp/testbot@v1
  id: skyramp
  continue-on-error: true

- name: Notify on failure
  if: failure()
  run: |
    echo "::error::Skyramp Testbot failed. Manual intervention required."
    # Send notification, create issue, etc.
```

### 5. Concurrency Control

Cancel in-flight runs when new commits are pushed to the same PR branch. This prevents race conditions where multiple testbot runs try to commit to the same branch simultaneously:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref }}
  cancel-in-progress: true
```

This ensures only the latest run proceeds, avoiding stale-branch conflicts and wasted compute.

### 6. Performance Optimization

- Use `skipTargetSetup: true` if services already running
- Pin `skyrampMcpVersion` to avoid npm registry lookups
- Cache Docker images if using self-hosted runners
- Limit diff size for faster agent processing

### 7. Testing Configuration Changes

Before rolling out configuration changes:

1. Test in separate branch
2. Use `autoCommit: false` initially
3. Enable `enableDebug: true`
4. Review artifact outputs
5. Gradually enable auto-commit

## Example: Complete Configuration

```yaml
name: Skyramp Test Automation
on:
  pull_request:
    branches: [main, develop]
    paths:
      - 'src/api/**'
      - 'tests/**'

concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  test-maintenance:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Cache dependencies
        uses: actions/cache@v4
        with:
          path: ~/.npm
          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}

      - name: Run Skyramp Testbot
        id: skyramp
        uses: skyramp/testbot@v1
        with:
          # Required
          skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
          cursorApiKey: ${{ secrets.CURSOR_API_KEY }}

          # Paths
          testDirectory: 'tests/api'
          workingDirectory: '.'

          # Services
          targetSetupCommand: 'docker compose -f docker-compose.test.yml up -d'
          skipTargetSetup: false

          # Versions
          skyrampExecutorVersion: 'v1.3.15'
          skyrampMcpVersion: 'latest'
          nodeVersion: 'lts/*'

          # Behavior
          autoCommit: true
          commitMessage: 'test: automated test maintenance [skip ci]'
          postPrComment: true
          testbotMaxRetries: 3
          testbotRetryDelay: 10
          enableDebug: false

      - name: Job summary
        run: |
          echo "## Test Maintenance Results" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "- Modified: ${{ steps.skyramp.outputs.tests_modified }}" >> $GITHUB_STEP_SUMMARY
          echo "- Created: ${{ steps.skyramp.outputs.tests_created }}" >> $GITHUB_STEP_SUMMARY
          echo "- Executed: ${{ steps.skyramp.outputs.tests_executed }}" >> $GITHUB_STEP_SUMMARY
```

## Additional Resources

- [Troubleshooting Guide](troubleshooting.md)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Skyramp Documentation](https://docs.skyramp.com)
- [Cursor CLI Documentation](https://docs.cursor.com)
