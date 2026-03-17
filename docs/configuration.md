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
3. **Hardcoded defaults** — Built-in fallback values (e.g., `tests`, `v1.3.12`, `latest`)

When a workflow input is explicitly provided, it always takes precedence over workspace values. When a workflow input is omitted, workspace values fill in the gap. If neither is set, hardcoded defaults are used. Testbot-specific settings (timeouts, debug, auto-commit, retries, etc.) always come from action inputs.

### File Location

The action looks for `.skyramp/workspace.yml` relative to the `working_directory` input (default: repository root). This file is typically created by running `skyramp_initialize_workspace` from the Skyramp MCP server.

### Workspace File Structure

```yaml
# .skyramp/workspace.yml
workspace:
  repoName: "my-api"
  repoUrl: "https://github.com/org/my-api"

metadata:
  schemaVersion: "v1"
  mcpVersion: "0.0.55"
  executorVersion: "v1.3.3"
  createdAt: "2026-01-15T10:00:00Z"
  updatedAt: "2026-02-18T14:30:00Z"

services:
  - serviceName: "api"
    language: "python"
    framework: "pytest"
    outputDir: "tests/python"
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
| `services[i].outputDir` | `testDirectory` | Fallback when `test_directory` input is empty |
| `services[i].runtimeDetails.serverStartCommand` | `targetSetupCommand` | Fallback when `target_setup_command` input is empty |
| `services[i].runtimeDetails.serverTeardownCommand` | `targetTeardownCommand` | Fallback when `target_teardown_command` input is empty |
| `services[i].language` | (passed to agent prompt) | Helps LLM generate appropriate tests |
| `services[i].framework` | (passed to agent prompt) | Helps LLM use correct test framework |
| `services[i].api.baseUrl` | (passed to agent prompt) | Helps LLM target correct URL |
| `metadata.executorVersion` | `skyrampExecutorVersion` | Fallback when `skyramp_executor_version` input is empty |
| `metadata.mcpVersion` | `skyrampMcpVersion` | Fallback when `skyramp_mcp_version` input is empty |

### Multi-Service Workspaces

All services defined in `.skyramp/workspace.yml` are passed to the agent prompt. The LLM receives each service's language, framework, base URL, and output directory, allowing it to generate and maintain tests for all services in a single run.

The first service's `outputDir` and `runtimeDetails.serverStartCommand` are used as operational defaults (for `testDirectory` and `targetSetupCommand`). During auto-commit, files are staged from each service's `outputDir`.

### Validation and Error Handling

- If `.skyramp/workspace.yml` doesn't exist, the action proceeds with action input defaults
- If the file exists but fails Zod validation, a warning is logged and input defaults are used
- The action gracefully handles partial configurations (missing optional fields use input defaults)

## Input Reference

### Required Inputs

#### `skyramp_license_file`

**Description:** Skyramp license file content

**Type:** String (multiline supported)

**Storage:** GitHub Secrets (required)

**Example:**
```yaml
with:
  skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
```

**Notes:**
- Never commit license directly in workflow files
- Store in repository or organization secrets
- License is written to runner temp directory with 600 permissions
- File path: `${{ runner.temp }}/skyramp/skyramp_license.lic`

#### `cursor_api_key`

**Description:** Cursor API key for agent access

**Type:** String

**Storage:** GitHub Secrets

**Example:**
```yaml
with:
  cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
```

**Notes:**
- Obtain from Cursor dashboard
- Required when using Cursor CLI agent (default)
- Check quota limits for high-frequency workflows

#### `copilot_api_key`

**Description:** GitHub Copilot API token for agent access

**Type:** String

**Storage:** GitHub Secrets

**Example:**
```yaml
with:
  copilot_api_key: ${{ secrets.COPILOT_API_KEY }}
```

**Notes:**
- Obtain from GitHub (requires active Copilot subscription)
- Required when using GitHub Copilot CLI agent
- Can use fine-grained personal access token with "Copilot Requests" permission

### Agent Configuration

This is infered by which API key is provided, `cursor_api_key` v/s `copilot_api_key`.

**Notes:**
- Determines which CLI will be installed and configured
- Must have corresponding API key configured
- Both agents work with the same Skyramp MCP server

### Optional Inputs - High Priority

#### `test_directory`

**Description:** Directory containing Skyramp tests

**Type:** String

**Default:** `tests`

**Example:**
```yaml
with:
  test_directory: 'api/tests'
```

**Use Cases:**
- Custom test directory structure
- Multiple test directories (see Advanced Patterns)
- Monorepo with service-specific test directories

#### `target_setup_command`

**Description:** Command to start services before test maintenance

**Type:** String

**Default:** `docker compose up -d`

**Examples:**

1. **Docker Compose v2:**
   ```yaml
   target_setup_command: 'docker compose up -d'
   ```

2. **Docker Compose v1:**
   ```yaml
   target_setup_command: 'docker-compose up -d'
   ```

3. **npm script:**
   ```yaml
   target_setup_command: 'npm run start:services'
   ```

4. **Multiple commands:**
   ```yaml
   target_setup_command: 'docker compose up -d && npm run migrate'
   ```

5. **Custom script:**
   ```yaml
   target_setup_command: './scripts/start-test-env.sh'
   ```

**Notes:**
- Command runs in `working_directory`
- Failures are treated as fatal: the action run will fail if this command fails
- Use `skip_target_setup: true` if not needed
- See `target_ready_check_command` for controlling readiness polling after startup

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

#### `target_teardown_command`

**Description:** Command to tear down services after test execution. Runs in the GitHub Actions `post` step, which is guaranteed to execute even on failure or cancellation.

**Type:** String

**Default:** `''` (empty — no teardown by default)

**Examples:**

1. **Docker Compose:**
   ```yaml
   target_teardown_command: 'docker compose down'
   ```

2. **Custom cleanup script:**
   ```yaml
   target_teardown_command: './scripts/teardown-test-env.sh'
   ```

3. **Multiple commands:**
   ```yaml
   target_teardown_command: 'docker compose down && rm -rf /tmp/test-data'
   ```

**Notes:**
- Runs in `working_directory`
- Failure is non-fatal: logs a warning but never fails the action
- Runs in the `post` step (after the main step completes), guaranteed by GitHub Actions even on cancellation
- Use `skip_target_teardown: true` to disable without removing the command

#### `skip_target_teardown`

**Description:** Skip running service teardown command

**Type:** Boolean

**Default:** `false`

**Example:**
```yaml
with:
  skip_target_teardown: true
```

**Use Cases:**
- Temporary debugging where you want services to stay up
- External teardown handled by a separate workflow step

#### `target_ready_check_command`

**Description:** Shell command to verify services are ready after startup. Retried every 2 seconds until it succeeds (exit code 0) or `target_ready_check_timeout` is reached.

**Type:** String

**Default:** `"sleep 5"`

**Examples:**

1. **HTTP health endpoint:**
   ```yaml
   target_ready_check_command: 'curl -sf http://localhost:8000/health'
   ```

2. **TCP port check:**
   ```yaml
   target_ready_check_command: 'nc -z localhost 5432'
   ```

3. **Docker container health:**
   ```yaml
   target_ready_check_command: 'docker compose exec -T api curl -sf http://localhost:8000/health'
   ```

**Notes:**
- Runs via `bash -c`, so pipes and operators work
- Each attempt is logged for visibility
- On timeout, a warning is logged but the action continues (non-fatal)

#### `target_ready_check_timeout`

**Description:** Maximum seconds to wait for `target_ready_check_command` to succeed

**Type:** String (numeric)

**Default:** `30`

**Example:**
```yaml
with:
  target_ready_check_timeout: 60
```

**Notes:**
- Only relevant when `target_ready_check_command` is set
- The command is polled every 2 seconds until success or this timeout
- If the timeout is reached, a warning is emitted and execution continues

#### `target_ready_check_diagnostics_command`

**Description:** Shell command to collect diagnostics when a health check times out. Runs via `bash -c` in the working directory. Override to use non-Docker diagnostics (e.g., `journalctl`, `kubectl logs`, or custom scripts).

**Type:** String

**Default:** Docker container status and logs (last 30 lines per container)

**Examples:**

1. **Kubernetes pods:**
   ```yaml
   target_ready_check_diagnostics_command: 'kubectl get pods -o wide && kubectl logs -l app=myservice --tail=30'
   ```

2. **Systemd journal:**
   ```yaml
   target_ready_check_diagnostics_command: 'journalctl -u myservice --no-pager -n 50'
   ```

3. **Custom script:**
   ```yaml
   target_ready_check_diagnostics_command: './scripts/collect-diagnostics.sh'
   ```

**Notes:**
- Only runs when `target_ready_check_command` is set and times out
- Failure of the diagnostics command is non-fatal (caught and logged)
- Runs via `bash -c`, so pipes and operators work

### Optional Inputs - Medium Priority

#### `skyramp_executor_version`

**Description:** Skyramp Executor Docker image version

**Type:** String

**Default:** `v1.3.3`

**Example:**
```yaml
with:
  skyramp_executor_version: 'v1.4.0'
```

**Notes:**
- Should match version compatible with your license
- Check [Skyramp releases](https://github.com/skyramp/executor/releases) for available versions
- Use specific version tags, not `latest` for production

#### `skyramp_mcp_version`

**Description:** Skyramp MCP npm package version

**Type:** String

**Default:** `latest`

**Example:**
```yaml
with:
  skyramp_mcp_version: '1.2.0'
```

**Notes:**
- `latest` pulls newest version each run (slower, but always current)
- Pin version for reproducible builds
- Check [npm registry](https://www.npmjs.com/package/@skyramp/mcp) for versions

#### `node_version`

**Description:** Node.js version for the action

**Type:** String

**Default:** `lts` (Long Term Support)

**Examples:**

1. **LTS (Recommended):**
   ```yaml
   node_version: 'lts'
   ```

2. **Specific major version:**
   ```yaml
   node_version: '20.x'
   ```

3. **Exact version:**
   ```yaml
   node_version: '20.10.0'
   ```

**Notes:**
- Uses `actions/setup-node@v4`
- LTS is safest for compatibility
- Match your project's Node.js version for consistency

#### `skip_target_setup`

**Description:** Skip running service startup command

**Type:** Boolean

**Default:** `false`

**Example:**
```yaml
with:
  skip_target_setup: true
```

**Use Cases:**
- Services already running in previous step
- Tests don't require services
- Using external test environment
- Troubleshooting service startup issues

#### `working_directory`

**Description:** Working directory for action execution

**Type:** String

**Default:** `.` (repository root)

**Example:**
```yaml
with:
  working_directory: './services/api'
```

**Use Cases:**
- Monorepo with multiple services
- Project in subdirectory
- Custom repository structure

**Notes:**
- Affects where `target_setup_command` runs
- Relative to repository root
- Test directory is relative to working directory

#### `auto_commit`

**Description:** Automatically commit test changes

**Type:** Boolean

**Default:** `true`

**Example:**
```yaml
with:
  auto_commit: false
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
    auto_commit: false

- name: Upload changes
  uses: actions/upload-artifact@v4
  with:
    name: test-changes
    path: tests/
```

#### `commit_message`

**Description:** Git commit message for test changes

**Type:** String

**Default:** `Skyramp Testbot: test maintenance suggestions`

**Examples:**

1. **Conventional Commits:**
   ```yaml
   commit_message: 'test: update API tests via Skyramp bot'
   ```

2. **Skip CI:**
   ```yaml
   commit_message: 'chore: update tests [skip ci]'
   ```

3. **Include PR reference:**
   ```yaml
   commit_message: 'test: update tests for PR #${{ github.event.pull_request.number }}'
   ```

4. **Detailed message:**
   ```yaml
   commit_message: |
     test: automated test maintenance

     Generated by Skyramp Testbot
     PR: #${{ github.event.pull_request.number }}
   ```

#### `post_pr_comment`

**Description:** Post test summary as PR comment

**Type:** Boolean

**Default:** `true`

**Example:**
```yaml
with:
  post_pr_comment: false
```

**Notes:**
- Requires `pull-requests: write` permission
- Only works on pull_request events
- Uses `peter-evans/create-or-update-comment@v4`
- Comments are updated, not duplicated

#### `testbot_max_retries`

**Description:** Maximum number of retries for transient agent CLI errors (e.g., Cursor "Connection stalled")

**Type:** String (numeric)

**Default:** `3`

**Example:**
```yaml
with:
  testbot_max_retries: 5
```

**Notes:**
- Only transient errors (e.g., "Connection stalled") trigger retries; other failures fail immediately
- Set to `1` to disable retries

#### `testbot_retry_delay`

**Description:** Delay in seconds between agent retry attempts

**Type:** String (numeric)

**Default:** `10`

**Example:**
```yaml
with:
  testbot_retry_delay: 30
```

**Notes:**
- Increase for environments with intermittent connectivity issues
- The total worst-case delay is `testbot_max_retries * testbot_retry_delay` seconds

#### `enable_debug`

**Description:** Enable verbose debug logging

**Type:** Boolean

**Default:** `false`

**Example:**
```yaml
with:
  enable_debug: true
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
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}

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
- Empty string if `auto_commit` is set to `false`
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
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
          test_directory: 'services/${{ matrix.service }}/tests'
          working_directory: 'services/${{ matrix.service }}'
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
          auto_commit: true

  test-maintenance-production:
    runs-on: ubuntu-latest
    if: github.base_ref == 'main'
    environment: production  # Requires approval
    steps:
      - uses: skyramp/testbot@v1
        with:
          auto_commit: true
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
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
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
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
```

## Environment-Specific Setup

### Development Environment

```yaml
- uses: skyramp/testbot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE_DEV }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    enable_debug: true
    auto_commit: false
    post_pr_comment: true
```

### Staging Environment

```yaml
- uses: skyramp/testbot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE_STAGING }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    auto_commit: true
    commit_message: 'test: automated update [staging]'
```

### Production Environment

```yaml
- uses: skyramp/testbot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE_PROD }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    skyramp_executor_version: 'v1.3.3'  # Pinned version
    skyramp_mcp_version: '1.0.0'  # Pinned version
    auto_commit: true
    enable_debug: false
```

## Best Practices

### 1. Version Pinning

For production, pin action and dependency versions:

```yaml
- uses: skyramp/testbot@v1.0.0  # Exact version
  with:
    skyramp_executor_version: 'v1.3.3'
    skyramp_mcp_version: '1.0.0'
    node_version: '20.x'
```

### 2. Secret Management

Use organization-level secrets for shared resources:

```yaml
with:
  skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}  # Organization secret
  cursor_api_key: ${{ secrets.CURSOR_API_KEY }}  # Repository secret
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

- Use `skip_target_setup: true` if services already running
- Pin `skyramp_mcp_version` to avoid npm registry lookups
- Cache Docker images if using self-hosted runners
- Limit diff size for faster agent processing

### 7. Testing Configuration Changes

Before rolling out configuration changes:

1. Test in separate branch
2. Use `auto_commit: false` initially
3. Enable `enable_debug: true`
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
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}

          # Paths
          test_directory: 'tests/api'
          working_directory: '.'

          # Services
          target_setup_command: 'docker compose -f docker-compose.test.yml up -d'
          skip_target_setup: false

          # Versions
          skyramp_executor_version: 'v1.3.3'
          skyramp_mcp_version: 'latest'
          node_version: 'lts'

          # Behavior
          auto_commit: true
          commit_message: 'test: automated test maintenance [skip ci]'
          post_pr_comment: true
          testbot_max_retries: 3
          testbot_retry_delay: 10
          enable_debug: false

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
