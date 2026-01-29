# Configuration Guide

This guide provides detailed information about configuring Skyramp Test Bot for your specific needs.

## Table of Contents

- [Input Reference](#input-reference)
- [Output Usage](#output-usage)
- [Advanced Patterns](#advanced-patterns)
- [Environment-Specific Setup](#environment-specific-setup)
- [Best Practices](#best-practices)

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

**Storage:** GitHub Secrets (required)

**Example:**
```yaml
with:
  cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
```

**Notes:**
- Obtain from Cursor dashboard
- Required for agent to make API calls
- Check quota limits for high-frequency workflows

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

#### `test_file_pattern`

**Description:** Glob pattern for test files to commit

**Type:** String

**Default:** `tests/**/*`

**Example:**
```yaml
with:
  test_file_pattern: 'api/tests/**/*.yml'
```

**Use Cases:**
- Specific file extensions (`.yml`, `.yaml`, `.json`)
- Multiple patterns: `tests/**/*.{yml,yaml}`
- Exclude certain files: Use `.gitignore` patterns

**Important:** Pattern is used by `git-auto-commit-action`, must be valid git pathspec.

#### `service_startup_command`

**Description:** Command to start services before test maintenance

**Type:** String

**Default:** `docker compose up -d`

**Examples:**

1. **Docker Compose v2:**
   ```yaml
   service_startup_command: 'docker compose up -d'
   ```

2. **Docker Compose v1:**
   ```yaml
   service_startup_command: 'docker-compose up -d'
   ```

3. **npm script:**
   ```yaml
   service_startup_command: 'npm run start:services'
   ```

4. **Multiple commands:**
   ```yaml
   service_startup_command: 'docker compose up -d && npm run migrate'
   ```

5. **Custom script:**
   ```yaml
   service_startup_command: './scripts/start-test-env.sh'
   ```

**Notes:**
- Command runs in `working_directory`
- Failure is logged as warning but doesn't fail action
- 5 second wait after startup for initialization
- Use `skip_service_startup: true` if not needed

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

#### `skip_service_startup`

**Description:** Skip running service startup command

**Type:** Boolean

**Default:** `false`

**Example:**
```yaml
with:
  skip_service_startup: true
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
- Affects where `service_startup_command` runs
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
- uses: skyramp/test-bot@v1
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

     Generated by Skyramp Test Bot
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
- uses: skyramp/test-bot@v1
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

      - uses: skyramp/test-bot@v1
        with:
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
          test_directory: 'services/${{ matrix.service }}/tests'
          test_file_pattern: 'services/${{ matrix.service }}/tests/**/*'
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
      - uses: skyramp/test-bot@v1
        with:
          auto_commit: true

  test-maintenance-production:
    runs-on: ubuntu-latest
    if: github.base_ref == 'main'
    environment: production  # Requires approval
    steps:
      - uses: skyramp/test-bot@v1
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

- uses: skyramp/test-bot@v1
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
      - uses: skyramp/test-bot@v1
        with:
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
```

## Environment-Specific Setup

### Development Environment

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE_DEV }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    enable_debug: true
    auto_commit: false
    post_pr_comment: true
```

### Staging Environment

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE_STAGING }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    auto_commit: true
    commit_message: 'test: automated update [staging]'
```

### Production Environment

```yaml
- uses: skyramp/test-bot@v1
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
- uses: skyramp/test-bot@v1.0.0  # Exact version
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
- uses: skyramp/test-bot@v1
  id: skyramp
  continue-on-error: true

- name: Notify on failure
  if: failure()
  run: |
    echo "::error::Skyramp Test Bot failed. Manual intervention required."
    # Send notification, create issue, etc.
```

### 5. Performance Optimization

- Use `skip_service_startup: true` if services already running
- Pin `skyramp_mcp_version` to avoid npm registry lookups
- Cache Docker images if using self-hosted runners
- Limit diff size for faster agent processing

### 6. Testing Configuration Changes

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

      - name: Run Skyramp Test Bot
        id: skyramp
        uses: skyramp/test-bot@v1
        with:
          # Required
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}

          # Paths
          test_directory: 'tests/api'
          test_file_pattern: 'tests/api/**/*.yml'
          working_directory: '.'

          # Services
          service_startup_command: 'docker compose -f docker-compose.test.yml up -d'
          skip_service_startup: false

          # Versions
          skyramp_executor_version: 'v1.3.3'
          skyramp_mcp_version: 'latest'
          node_version: 'lts'

          # Behavior
          auto_commit: true
          commit_message: 'test: automated test maintenance [skip ci]'
          post_pr_comment: true
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
