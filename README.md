# Skyramp Testbot

> Automated test generation and maintenance for your APIs and UIs using Skyramp's AI-powered Testbot

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Skyramp%20Testbot-blue?logo=github)](https://github.com/marketplace/actions/skyramp-testbot)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

## Features

- 🔍 **Smart Change Detection** - Analyzes the PR diff to identify impacted and missing tests
- ✨ **Multi-type Test Generation** - Creates API tests (integration, contract) plus browser **E2E and UI** tests for new behavior
- 🎭 **Browser Recording** - Your UI tests are grounded in real DOM elements and recorded browser interactions — logging in first with credentials you provide when the app requires auth — and execution videos are linked in the report
- 🔁 **Before/After Maintenance** - Runs impacted tests before and after updating them so you can see exactly what the change fixed
- ✅ **Automated Test Execution** - Runs generated and maintained tests and validates results
- 🌿 **Clean Side-PR Delivery** - By default opens a separate PR with the test changes into your feature branch, keeping the feature PR clean (or commits directly onto the feature branch)
- 🔗 **Multi-repo Aware** - Analyzes related repositories as shared context and can deliver tests to a separate test repo
- 💬 **Rich PR Reports** - Posts a detailed, collapsible summary as a PR comment with timing breakdowns
- 🔒 **Author Allowlisting** - Restrict which PR authors Testbot acts on
- 🤖 **Bring Your Own LLM Key** - Runs on Claude Code with your own Anthropic API key

## Quick Start

The fastest way to get started is with the **Skyramp Testbot Installer** — a guided wizard that installs the GitHub App, configures secrets, and opens a ready-to-merge setup PR in your repository.

> ⚠️ **Permissions required:** Installing the GitHub App on an organization requires org-owner (or an admin with app-install) permissions, and configuring secrets and opening the setup PR requires admin/write access to the target repository. If you don't have these, ask an org/repo admin to run the installer, or set up the workflow manually via the [Usage Examples](#usage-examples) instead.

1. Go to [testbot.skyramp.dev](https://testbot.skyramp.dev) and sign in with GitHub.
2. Install the Skyramp Testbot GitHub App on your organization or personal account.
3. Select a repository, configure your Skyramp license and AI agent key, and review the generated workflow.
4. Click **Deploy** — the installer creates a PR with the workflow file and configures your secrets automatically.
5. Merge the PR, and Testbot will run on every pull request.

The installer detects your stack, writes the workflow file, and configures your `SKYRAMP_LICENSE` and agent API key secrets for you — no need to hand-write any YAML. To wire up the workflow yourself instead, see the [Usage Examples](#usage-examples) below.

Once the setup PR is merged, Testbot runs automatically on each subsequent pull request: it analyzes the diff, generates new tests and updates impacted ones, and — in the default `separate-branch` mode — opens a **separate test PR** targeting that feature branch with the changes (rather than committing onto the PR directly). See [`generatedTestsMode`](#test-generation--delivery) to change this behavior.

## How It Works

1. **Change Detection** - Generates a git diff between the base branch and the current PR (correlating related repos when `relatedRepoPaths` is set)
2. **License Setup** - Configures the Skyramp license from secrets
3. **Environment Setup** - Installs Node.js, the Skyramp MCP server, and the selected AI agent CLI
4. **MCP Configuration** - Configures the Skyramp MCP server for agent access
5. **Service Startup** - Starts your services using the configured command and runs the ready check
6. **AI Analysis** - The agent analyzes changes and identifies test impacts and gaps
7. **Test Generation & Maintenance** - Generates new API and UI/E2E tests and updates impacted tests (running them before and after)
8. **Test Execution** - Runs tests and validates results
9. **Report Generation** - Builds a detailed summary with metrics, timing, and any recorded UI videos
10. **PR Comment** - Posts the summary to the PR (if enabled)
11. **Delivery** - Opens a side PR with the test changes (default) or commits directly to the feature branch

## Prerequisites

Before using this action, ensure you have:

- [ ] Skyramp license file content stored in GitHub Secrets as `SKYRAMP_LICENSE`
- [ ] A Claude Code API key stored in GitHub Secrets as `ANTHROPIC_API_KEY`
- [ ] Docker available in your runner (for the Skyramp Executor)
- [ ] A project whose services can be started in CI (the action runs `docker compose up -d` by default)
- [ ] Existing Skyramp tests or a test directory structure (Testbot creates `.skyramp/workspace.yml` on its first run)

## Action Inputs

`action.yml` is the source of truth for inputs and defaults. The tables below summarize the most useful ones.

### Required

| Input | Description |
|-------|-------------|
| `skyrampLicenseFile` | Skyramp license file content (store in GitHub Secrets) |
| `anthropicApiKey` * | Anthropic API key for Claude Code (store in GitHub Secrets) |

<sub>\* Provide exactly one agent key. Testbot also supports Cursor (`cursorApiKey`) and GitHub Copilot (`copilotApiKey`) as alternate agents.</sub>

### Target Lifecycle

| Input | Description | Default |
|-------|-------------|---------|
| `targetSetupCommand` | Command to start services before testing. Can emit a JSON object on its last stdout line to override the workspace `baseUrl` at runtime (e.g. `{"baseUrl": "http://remote-host:8000"}`, or `{"services": {"backend": {"baseUrl": "..."}}}` for multi-service) | `docker compose up -d` |
| `skipTargetSetup` | Skip running the service startup command | `false` |
| `targetSetupRetries` | Retries for `targetSetupCommand` on failure (e.g. transient DockerHub 502s) | `3` |
| `targetSetupRetryDelay` | Delay in seconds between setup retries | `10` |
| `targetReadyCheckCommand` | Command to verify services are ready (retried until success or timeout). When empty, auto-generates curl health checks against the workspace service base URLs | `''` (auto) |
| `targetReadyCheckTimeout` | Max seconds to wait for the ready check to succeed | `1800` |
| `targetReadyCheckInterval` | Seconds between ready check poll attempts | `30` |
| `targetReadyCheckDiagnosticsCommand` | Command to collect diagnostics on ready-check timeout | Docker container status/logs |
| `targetTeardownCommand` | Command to tear down services (runs in the post step, guaranteed even on failure/cancellation) | `''` |
| `skipTargetTeardown` | Skip running the service teardown command | `false` |

### Authentication & Access

| Input | Description | Default |
|-------|-------------|---------|
| `authTokenCommand` | Shell command to generate an auth token. Runs after services start; stdout is captured and set as `SKYRAMP_TEST_TOKEN` for test execution | `''` |
| `uiCredentials` | Browser login credentials for apps that require auth before UI test recording. Format `username:password`, one per line for multiple users. Store in GitHub Secrets | `''` |
| `allowedAuthors` | Newline-separated GitHub usernames whose PRs Testbot will act on. Empty allows all authors | `''` |

### Test Generation & Delivery

| Input | Description | Default |
|-------|-------------|---------|
| `maxRecommendations` | Total number of test recommendations to produce (generated + additional) | `20` |
| `maxGenerate` | Number of tests to generate and execute this run; the rest are listed as additional recommendations | `3` |
| `generatedTestsMode` | Where test changes are delivered: `separate-branch` (default) opens a side PR into the feature branch to keep it clean; `same-branch` commits directly onto the feature branch | `separate-branch` |
| `testRepoPath` | Cross-repo delivery: local path to a separately checked-out test repository. When set, tests are committed and a side PR is opened there instead of the app repo | `''` |
| `relatedRepoPaths` | Multi-repo analysis: newline-separated paths to related repos (checked out as sibling dirs) analyzed read-only as shared context. Max 5 | `''` |
| `autoCommit` | Automatically commit/deliver test changes | `true` |
| `commitMessage` | Commit message for test changes | `Skyramp Testbot: test maintenance suggestions` |

### Skyramp & MCP Versions

| Input | Description | Default |
|-------|-------------|---------|
| `skyrampExecutorVersion` | Skyramp Executor Docker image version | workspace.yml, else `v1.3.30` |
| `skyrampMcpVersion` | Skyramp MCP package version | workspace.yml, else `latest` |

### Behavior, Retries & Reporting

| Input | Description | Default |
|-------|-------------|---------|
| `githubToken` | Token for PR comments and API access. Use a GitHub App token or PAT if you want side-PR CI to auto-run | `${{ github.token }}` |
| `workingDirectory` | Working directory for the action | `.` |
| `postPrComment` | Post the summary as a PR comment | `true` |
| `reportCollapsed` | Wrap report sections in collapsible `<details>` blocks | `true` |
| `testbotMaxRetries` | Max retries for transient agent CLI errors | `3` |
| `testbotRetryDelay` | Delay in seconds between agent retry attempts | `10` |
| `testExecutionTimeout` | Timeout (seconds) for individual MCP tool calls, e.g. test execution | `300` |
| `testbotTimeout` | Timeout (minutes) for agent execution (safety net; does not kill the child process) | `60` |
| `enableDebug` | Enable verbose debug logging (for NDJSON-capable agents this produces the `agent-log.ndjson` that is uploaded as an artifact) | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `test_summary` | Full summary of test maintenance actions |
| `tests_modified` | Number of tests modified |
| `tests_created` | Number of tests created |
| `tests_executed` | Number of tests executed |
| `skipped_self_trigger` | Whether execution was skipped due to detecting its own commit |
| `commit_sha` | SHA of the commit made by Testbot (empty if no commit) |
| `side_pr_url` | URL of the side PR opened by Testbot. Empty when no side PR was opened (no test changes, or `generatedTestsMode=same-branch`) |
| `side_pr_number` | Number of the side PR opened by Testbot. Empty under the same conditions as `side_pr_url` |
| `duration_setup` / `duration_analyzing` / `duration_generating` / `duration_executing` / `duration_maintaining` / `duration_reporting` / `duration_total` | Per-phase and total durations in seconds |

## Usage Examples

### Basic Usage

Testbot runs on Claude Code:

```yaml
- uses: skyramp/testbot@v0.10.7
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
```

<details>
<summary>Using a different agent (Cursor or GitHub Copilot)</summary>

Testbot also supports Cursor and GitHub Copilot. Provide **exactly one** agent key — Testbot auto-detects which agent to use from the key present. Replace the `anthropicApiKey` line in the example above with one of:

- **Cursor:** `cursorApiKey: ${{ secrets.CURSOR_API_KEY }}`
- **GitHub Copilot:** `copilotApiKey: ${{ secrets.COPILOT_PAT }}` (a GitHub PAT with "Copilot Requests" permission)

</details>

### Custom Service Startup Command

```yaml
- uses: skyramp/testbot@v0.10.7
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
    targetSetupCommand: 'npm run start:services'
```

### API Token Authentication

If your API under test requires authentication, there are two ways to provide a token for test execution.

#### Static Token

If your token is fixed (e.g. a test API key), set `SKYRAMP_TEST_TOKEN` as a workflow environment variable:

```yaml
env:
  SKYRAMP_TEST_TOKEN: ${{ secrets.SKYRAMP_TEST_TOKEN }}

jobs:
  test-maintenance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: skyramp/testbot@v0.10.7
        with:
          skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
          anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
```

#### Dynamic Token

If your token must be generated at runtime (e.g. by calling a login endpoint or running a CLI), use the `authTokenCommand` input. The command runs after services start, and its stdout is captured as the token:

```yaml
- uses: skyramp/testbot@v0.10.7
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
    authTokenCommand: 'curl -s https://my-api.com/auth/token'
```

The token is automatically registered as a secret so it is masked in the workflow logs. If the command fails, the action stops before running any tests.

### UI / E2E Tests Behind a Login

For apps that require authentication before recording browser flows, pass credentials via `uiCredentials` (store as a secret). Testbot logs in once before recording UI/E2E tests.

```yaml
- uses: skyramp/testbot@v0.10.7
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
    uiCredentials: ${{ secrets.TESTBOT_UI_CREDENTIALS }}  # "user@example.com:password"
```

### Without Auto-commit (Manual Review)

```yaml
- uses: skyramp/testbot@v0.10.7
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
    autoCommit: false
```

### Commit Directly to the Feature Branch

By default Testbot opens a side PR with the test changes into your feature branch. To commit the changes directly onto the feature branch instead:

```yaml
- uses: skyramp/testbot@v0.10.7
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
    generatedTestsMode: same-branch
```

### Custom Test Directory Location

Test directory locations are configured per-service in `.skyramp/workspace.yml` (created by Testbot on its first run):

```yaml
services:
  - serviceName: api
    testDirectory: api/tests
```

### Multi-repo Analysis

When a change spans repositories (e.g. a frontend and a backend), check out the related repos as sibling directories and pass their paths so Testbot correlates cross-repo changes before generating tests:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/checkout@v4
  with:
    repository: my-org/backend
    path: backend
- uses: skyramp/testbot@v0.10.7
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}
    relatedRepoPaths: backend
```

### Using Outputs

```yaml
- uses: skyramp/testbot@v0.10.7
  id: skyramp
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Check Results
  run: |
    echo "Tests Modified: ${{ steps.skyramp.outputs.tests_modified }}"
    echo "Tests Created: ${{ steps.skyramp.outputs.tests_created }}"
    echo "Tests Executed: ${{ steps.skyramp.outputs.tests_executed }}"
    echo "Side PR: ${{ steps.skyramp.outputs.side_pr_url }}"
```

## Troubleshooting

### Common Issues

**CLI installation fails**

- Check runner network connectivity
- Verify the installation endpoint is accessible
- Try enabling debug mode: `enableDebug: true`
- For Copilot: Ensure npm is working correctly

**License validation errors**

- Ensure license content is properly stored in GitHub Secrets
- Check that license file is not expired
- Verify secret name matches input parameter

**Service startup issues**

- Verify docker-compose.yml exists in repository
- Check that Docker is available in runner
- Use `skipTargetSetup: true` if services not needed
- Customize with `targetSetupCommand` for different startup methods

**Agent timeout or failures**

- **Claude Code**: Check that `ANTHROPIC_API_KEY` is valid and has quota remaining
- **Cursor**: Check API key is valid and has quota remaining
- **Copilot**: Verify Copilot subscription is active and token is valid
- Review the agent logs — the `skyramp-agent-logs` NDJSON artifact is uploaded automatically whenever the agent produces one (Cursor and Claude Code; enable `enableDebug` for fuller output)
- Enable debug mode for more detailed output

## Security Best Practices

1. **Never commit secrets** - Always use GitHub Secrets for sensitive values
2. **Limit permissions** - Only grant necessary permissions in workflow
3. **Pin versions** - Use a specific version (`@v0.10.6`) for production workflows, or the floating minor tag (`@v0.10`) to get patches automatically
4. **Review test changes** - Rely on the default side-PR delivery (or disable auto-commit) for sensitive repositories
5. **Audit logs** - Enable debug mode periodically to review action behavior

## Support

- **Website**: [skyramp.dev](https://skyramp.dev)

## License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

---

Made with ⚡ by [Skyramp](https://skyramp.dev)
