# Skyramp Testbot

> Automated test maintenance for your REST APIs using Skyramp's AI-powered Testbot

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Skyramp%20Testbot-blue?logo=github)](https://github.com/marketplace/actions/skyramp-testbot)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

## Features

- 🤖 **Skyramp Powered Test Maintenance** - Automatically updates tests when code changes
- 🔍 **Smart Change Detection** - Analyzes git diffs to identify impacted tests
- ✨ **Test Generation** - Creates new tests for new code additions
- ✅ **Automated Test Execution** - Runs tests and validates results
- 💬 **PR Integration** - Posts detailed summaries as PR comments
- 🔄 **Auto-commit** - Optionally commits test changes automatically

## Quick Start

The fastest way to get started is with the **Skyramp Testbot Installer** — a guided wizard that installs the GitHub App, configures secrets, and opens a ready-to-merge setup PR in your repository.

1. Go to [testbot.skyramp.dev](https://testbot.skyramp.dev) and sign in with GitHub.
2. Install the Skyramp Testbot GitHub App on your organization or personal account.
3. Select a repository, configure your Skyramp license and AI agent key, and review the generated workflow.
4. Click **Deploy** — the installer creates a PR with the workflow file and configures your secrets automatically.
5. Merge the PR, and Testbot will run on every pull request.

### Manual Setup

If you prefer to set things up manually:

1. Add 2 secrets to your repository:
    1. Obtain a [Skyramp](https://skyramp.dev) license key and store it as `SKYRAMP_LICENSE`.
    2. Add an API key for your chosen AI agent (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, or `COPILOT_PAT`).
2. Add this workflow to your repository (`.github/workflows/skyramp-testbot.yml`):

    ```yaml
    name: Skyramp Testbot
    on: [pull_request]

    jobs:
      testbot:
        runs-on: ubuntu-latest
        permissions:
          contents: write
          pull-requests: write
        steps:
          - uses: actions/checkout@v4
            with:
              fetch-depth: 0

          - uses: skyramp/testbot@v0.1
            with:
              skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    ```

## Agent Customization

Should you want to use your own AI agent subscription, provision a key and use the appropriate input.

- Claude Code - Coding Agent by Anthropic
- **Cursor CLI** - Powerful AI agent from Cursor
- **GitHub Copilot CLI** - GitHub's AI coding assistant

Choose the agent that best fits your needs and existing subscriptions.

## Prerequisites

Before using this action, ensure you have:

- [ ] Skyramp license file content stored in GitHub Secrets as `SKYRAMP_LICENSE`
- [ ] **For Claude Code**: Claude Code API key stored in GitHub Secrets as `ANTHROPIC_API_KEY`
- [ ] **For Cursor**: Cursor API key stored in GitHub Secrets as `CURSOR_API_KEY`
- [ ] **For Copilot**: GitHub token with Copilot access stored in GitHub Secrets as `GITHUB_TOKEN` or `COPILOT_PAT`
- [ ] Docker available in your runner (for Skyramp Executor)
- [ ] Node.js compatible project (action installs Node.js automatically)
- [ ] Existing Skyramp tests or a test directory structure

> **Note:** The agent type is automatically detected based on which API key you provide. Provide only one key (not both).

## Inputs

### Required

| Input | Description |
|-------|-------------|
| `skyrampLicenseFile` | Skyramp license file content (store in GitHub Secrets) |
| `anthropicApiKey` | Anthropic API key (provide this to use Claude Code) |
| `cursorApiKey` | Cursor API key (provide this to use Cursor agent) |
| `copilotApiKey` | GitHub token with Copilot access (provide this to use Copilot agent) |

### Optional - Service Lifecycle

| Input | Description | Default |
|-------|-------------|---------|
| `targetSetupCommand` | Command to start services before test maintenance | `docker compose up -d` |
| `skipTargetSetup` | Skip running service startup command | `false` |
| `targetReadyCheckCommand` | Command to verify services are ready (retried until success or timeout) | `sleep 5` |
| `targetReadyCheckTimeout` | Max seconds to wait for ready check to succeed | `30` |
| `targetReadyCheckDiagnosticsCommand` | Command to collect diagnostics on ready check timeout | Docker container status/logs |
| `targetTeardownCommand` | Command to tear down services after tests (runs in post step, guaranteed even on failure/cancellation) | `''` |
| `skipTargetTeardown` | Skip running service teardown command | `false` |
| `authTokenCommand` | Shell command to generate an authentication token (stdout is captured and set as `SKYRAMP_TEST_TOKEN`) | `''` |

### Optional - Other

| Input | Description | Default |
|-------|-------------|---------|
| `testDirectory` | Directory containing Skyramp tests | `tests` |
| `skyrampExecutorVersion` | Skyramp Executor Docker image version | `v1.3.15` |
| `skyrampMcpVersion` | Skyramp MCP package version | `latest` |
| `nodeVersion` | Node.js version to use | `lts/*` |
| `workingDirectory` | Working directory for the action | `.` |
| `autoCommit` | Automatically commit test changes | `true` |
| `commitMessage` | Commit message for test changes | `Skyramp Testbot: test maintenance suggestions` |
| `postPrComment` | Post summary as PR comment | `true` |
| `testbotMaxRetries` | Maximum number of retries for transient agent CLI errors | `3` |
| `testbotRetryDelay` | Delay in seconds between agent retry attempts | `10` |
| `testExecutionTimeout` | Timeout in seconds for individual MCP tool calls (e.g., test execution) | `300` |
| `testbotTimeout` | Timeout in minutes for the agent execution | `60` |
| `reportCollapsed` | Wrap report sections in collapsible `<details>` blocks | `true` |
| `enableDebug` | Enable debug logging | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `test_summary` | Full summary of test maintenance actions |
| `tests_modified` | Number of tests modified |
| `tests_created` | Number of tests created |
| `tests_executed` | Number of tests executed |
| `skipped_self_trigger` | Whether execution was skipped due to detecting own commit |
| `commit_sha` | SHA of the commit made by testbot (empty if no commit) |

## Usage Examples

### Basic Usage with Claude Code

```yaml
- uses: skyramp/testbot@v0.1.0
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    anthropicApiKey: ${{ secrets.ANTHROPIC_API_KEY }}

```

### Basic Usage with Cursor

```yaml
- uses: skyramp/testbot@v0.1.0
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
```

### Using GitHub Copilot CLI

```yaml
- uses: skyramp/testbot@v0.1.0
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    copilotApiKey: ${{ secrets.COPILOT_PAT }}
```

### Custom Service Startup Command

```yaml
- uses: skyramp/testbot@v0.1.0
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
    targetSetupCommand: 'npm run start:services'
```

### Without Auto-commit (Manual Review)

```yaml
- uses: skyramp/testbot@v0.1.0
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
    autoCommit: false
```

### Custom Test Directory Location

```yaml
- uses: skyramp/testbot@v0.1.0
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
    testDirectory: 'api/tests'
```

### Authentication

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

      - uses: skyramp/testbot@v0.1.0
        with:
          skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
          cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
```

#### Dynamic Token

If your token must be generated at runtime (e.g. by calling a login endpoint or running a CLI), use the `authTokenCommand` input. The command runs after services start, and its stdout is captured as the token:

```yaml
- uses: skyramp/testbot@v0.1.0
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
    authTokenCommand: 'curl -s https://my-api.com/auth/token'
```

The token is automatically masked in GitHub Actions logs via `::add-mask::`. If the command fails, the action stops before running any tests.

### Using Outputs

```yaml
- uses: skyramp/testbot@v0.1.0
  id: skyramp
  with:
    skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
    cursorApiKey: ${{ secrets.CURSOR_API_KEY }}

- name: Check Results
  run: |
    echo "Tests Modified: ${{ steps.skyramp.outputs.tests_modified }}"
    echo "Tests Created: ${{ steps.skyramp.outputs.tests_created }}"
    echo "Tests Executed: ${{ steps.skyramp.outputs.tests_executed }}"
```

## Triggering Other Workflows

By default, commits made by GitHub Actions using `GITHUB_TOKEN` don't trigger other workflows (this is GitHub's built-in recursion prevention). If you want Testbot's commits to trigger your CI/CD pipelines, linters, or other workflows, you need to use a Personal Access Token (PAT).

### Setup Steps

1. **Create a fine-grained PAT** scoped to your repository with `Contents: Read and Write` permission at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens). Set an expiration date and rotate regularly.
2. **Add it as a secret** named `PAT_TOKEN` in your repository settings
3. **Update your workflow** to use the PAT at checkout and add recursion prevention:

```yaml
jobs:
  test-maintenance:
    runs-on: ubuntu-latest
    # Prevent infinite loops - on push events, skip if triggered by Testbot's own commits
    # head_commit is only available on push events; pull_request events are handled by the action-level check
    if: github.event_name != 'push' || github.event.head_commit.author.name != 'Skyramp Testbot'

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.PAT_TOKEN }}  # Use PAT instead of GITHUB_TOKEN

      - uses: skyramp/testbot@v0.1.0
        with:
          skyrampLicenseFile: ${{ secrets.SKYRAMP_LICENSE }}
          cursorApiKey: ${{ secrets.CURSOR_API_KEY }}
```

See [examples/trigger-workflows.yml](examples/trigger-workflows.yml) for a complete example.

### How It Works

The recursion prevention has two layers:

1. **Job-level condition**: On `push` events, skips the entire job if the commit was made by Testbot
2. **Action-level detection**: The action detects self-triggers (using `git log` for `pull_request` events where `head_commit` is unavailable) and exits gracefully

This ensures Testbot never runs on its own commits while allowing other workflows to run normally.

## How It Works

1. **Change Detection** - Generates a git diff between the base branch and current PR
2. **License Setup** - Configures Skyramp license from secrets
3. **Environment Setup** - Installs Node.js, Skyramp MCP, and selected AI agent CLI
4. **MCP Configuration** - Configures the Skyramp MCP server for agent access
5. **Service Startup** - Starts your services using the configured command
6. **AI Analysis** - AI agent analyzes changes and identifies test impacts
7. **Test Maintenance** - Updates existing tests or generates new ones using Skyramp MCP
8. **Test Execution** - Runs tests and validates results
9. **Summary Generation** - Creates detailed summary of actions taken
10. **PR Comment** - Posts summary to PR (if enabled)
11. **Auto-commit** - Commits test changes (if enabled)

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

- **Cursor**: Check API key is valid and has quota remaining
- **Copilot**: Verify Copilot subscription is active and token is valid
- Review agent logs for specific errors
- Enable debug mode for more detailed output

For more detailed troubleshooting, see [docs/troubleshooting.md](docs/troubleshooting.md).

## Configuration Guide

For advanced configuration options and patterns, see [docs/configuration.md](docs/configuration.md).

## Security Best Practices

1. **Never commit secrets** - Always use GitHub Secrets for sensitive values
2. **Limit permissions** - Only grant necessary permissions in workflow
3. **Pin versions** - Use specific versions (`@v1.0.0`) for production workflows
4. **Review auto-commits** - Consider disabling auto-commit for sensitive repositories
5. **Audit logs** - Enable debug mode periodically to review action behavior

## Support

- **Documentation**: [docs/](docs/)
- **Website**: [skyramp.dev](https://skyramp.dev)

## License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

---

Made with ⚡ by [Skyramp](https://skyramp.dev)
