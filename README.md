# Skyramp Test Bot

> Automated test maintenance for your REST APIs using Skyramp's AI-powered TestBot

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Skyramp%20Test%20Bot-blue?logo=github)](https://github.com/marketplace/actions/skyramp-test-bot)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## Features

- 🤖 **Skyramp Powered Test Maintenance** - Automatically updates tests when code changes
- 🔍 **Smart Change Detection** - Analyzes git diffs to identify impacted tests
- ✨ **Test Generation** - Creates new tests for uncovered code changes
- ✅ **Automated Test Execution** - Runs tests and validates results
- 💬 **PR Integration** - Posts detailed summaries as PR comments
- 🔄 **Auto-commit** - Optionally commits test changes automatically
- 📁 **Workspace Config** - Project-level settings via .skyramp.yml

## Quick Start

1. Setup your repository with 2 secrets
    1. Obtain [Skyramp](https://skyramp.dev) license key.
    2. Generate a Cursor or GitHub Copilot API Key.
2. Add this workflow to your repository:

    Cursor version

    ```yaml
    name: Skyramp TestBot
    on: [pull_request]

    jobs:
      test-maintenance:
        runs-on: ubuntu-latest
        permissions:
          contents: write
          pull-requests: write
        steps:
          - uses: actions/checkout@v6
            with:
              fetch-depth: 0

          - uses: skyramp/test-bot@v0.2
            with:
              skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
              cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    ```

    GitHub Copilot version

    ```yaml
    name: Skyramp TestBot
    on: [pull_request]

    jobs:
      test-maintenance:
        runs-on: ubuntu-latest
        permissions:
          contents: write
          pull-requests: write
        steps:
          - uses: actions/checkout@v6
            with:
              fetch-depth: 0

          - uses: skyramp/test-bot@v0.2
            with:
              skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
              copilot_api_key: ${{ secrets.COPILOT_API_KEY }}
    ```


## Agent Selection

This action supports two AI agents:

- **Cursor CLI** - Powerful AI agent from Cursor
- **GitHub Copilot CLI** - GitHub's AI coding assistant

Choose the agent that best fits your needs and existing subscriptions.

## Prerequisites

Before using this action, ensure you have:

- [ ] Skyramp license file content stored in GitHub Secrets as `SKYRAMP_LICENSE`
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
| `skyramp_license_file` | Skyramp license file content (store in GitHub Secrets) |
| `cursor_api_key` | Cursor API key (provide this to use Cursor agent) |
| `copilot_api_key` | GitHub token with Copilot access (provide this to use Copilot agent) |

### Optional - High Priority

| Input | Description | Default |
|-------|-------------|---------|
| `test_directory` | Directory containing Skyramp tests | `tests` |
| `test_file_pattern` | Pattern for test files to commit | `tests/**/*` |
| `service_startup_command` | Command to start services before test maintenance | `docker compose up -d` |

### Optional - Medium Priority

| Input | Description | Default |
|-------|-------------|---------|
| `skyramp_executor_version` | Skyramp Executor Docker image version | `v1.3.3` |
| `skyramp_mcp_version` | Skyramp MCP package version | `latest` |
| `node_version` | Node.js version to use | `lts` |
| `skip_service_startup` | Skip running service startup command | `false` |
| `working_directory` | Working directory for the action | `.` |
| `auto_commit` | Automatically commit test changes | `true` |
| `commit_message` | Commit message for test changes | `Skyramp Testbot: test maintenance suggestions` |
| `post_pr_comment` | Post summary as PR comment | `true` |
| `enable_debug` | Enable debug logging | `false` |
| `config_file` | Path to Skyramp workspace config file | `.skyramp.yml` |

## Workspace Configuration (.skyramp.yml)

You can configure Test Bot at the project level by creating a `.skyramp.yml` file in your repository root. Values in this file take precedence over workflow defaults.

```yaml
# .skyramp.yml
test_directory: "tests"
test_file_pattern: "tests/**/*"
service_startup_command: "docker compose up -d"
skyramp_executor_version: "v1.3.3"
skyramp_mcp_version: "latest"
node_version: "lts/*"
skip_service_startup: false
working_directory: "."
auto_commit: true
commit_message: "Skyramp Testbot: test maintenance suggestions"
post_pr_comment: true
enable_debug: false
```

### Configuration Precedence

1. **.skyramp.yml values** - project-level configuration (highest priority)
2. **GitHub Action inputs** - workflow file values or defaults

This allows teams to define project-specific settings that override workflow defaults without modifying the workflow file.

> **Note:** Secrets (`skyramp_license_file` and `cursor_api_key`) must always be provided via GitHub Secrets and cannot be configured in .skyramp.yml.

For detailed configuration options, see [docs/configuration.md](docs/configuration.md).

## Outputs

| Output | Description |
|--------|-------------|
| `test_summary` | Full summary of test maintenance actions |
| `tests_modified` | Number of tests modified |
| `tests_created` | Number of tests created |
| `tests_executed` | Number of tests executed |

## Usage Examples

### Basic Usage with Cursor (Default)

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
```

### Using GitHub Copilot CLI

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    copilot_api_key: ${{ secrets.COPILOT_PAT }}
```

### Custom Service Startup Command

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    service_startup_command: 'npm run start:services'
```

### Without Auto-commit (Manual Review)

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    auto_commit: false
```

### Custom Test Directory Location

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    test_directory: 'api/tests'
    test_file_pattern: 'api/tests/**/*'
```

### Using Outputs

```yaml
- uses: skyramp/test-bot@v1
  id: skyramp
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}

- name: Check Results
  run: |
    echo "Tests Modified: ${{ steps.skyramp.outputs.tests_modified }}"
    echo "Tests Created: ${{ steps.skyramp.outputs.tests_created }}"
    echo "Tests Executed: ${{ steps.skyramp.outputs.tests_executed }}"
```

## Triggering Other Workflows

By default, commits made by GitHub Actions using `GITHUB_TOKEN` don't trigger other workflows (this is GitHub's built-in recursion prevention). If you want test-bot's commits to trigger your CI/CD pipelines, linters, or other workflows, you need to use a Personal Access Token (PAT).

### Setup Steps

1. **Create a fine-grained PAT** scoped to your repository with `Contents: Read and Write` permission at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens). Set an expiration date and rotate regularly.
2. **Add it as a secret** named `PAT_TOKEN` in your repository settings
3. **Update your workflow** to use the PAT at checkout and add recursion prevention:

```yaml
jobs:
  test-maintenance:
    runs-on: ubuntu-latest
    # Prevent infinite loops - on push events, skip if triggered by test-bot's own commits
    # head_commit is only available on push events; pull_request events are handled by the action-level check
    if: github.event_name != 'push' || github.event.head_commit.author.name != 'Skyramp Test Bot'

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.PAT_TOKEN }}  # Use PAT instead of GITHUB_TOKEN

      - uses: skyramp/test-bot@v1
        with:
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
```

See [examples/trigger-workflows.yml](examples/trigger-workflows.yml) for a complete example.

### How It Works

The recursion prevention has two layers:
1. **Job-level condition**: On `push` events, skips the entire job if the commit was made by test-bot
2. **Action-level detection**: The action detects self-triggers (using `git log` for `pull_request` events where `head_commit` is unavailable) and exits gracefully

This ensures test-bot never runs on its own commits while allowing other workflows to run normally.

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
- Try enabling debug mode: `enable_debug: true`
- For Copilot: Ensure npm is working correctly

**License validation errors**
- Ensure license content is properly stored in GitHub Secrets
- Check that license file is not expired
- Verify secret name matches input parameter

**Service startup issues**
- Verify docker-compose.yml exists in repository
- Check that Docker is available in runner
- Use `skip_service_startup: true` if services not needed
- Customize with `service_startup_command` for different startup methods

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

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

- **Issues**: [GitHub Issues](https://github.com/skyramp/test-bot/issues)
- **Documentation**: [docs/](docs/)
- **Website**: [skyramp.dev](https://skyramp.dev)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

Built with:
- [Cursor CLI](https://cursor.com) - AI-powered agent capabilities
- [GitHub Copilot CLI](https://github.com/features/copilot/cli) - GitHub's AI coding assistant
- [GitHub Actions](https://github.com/features/actions) - CI/CD automation

---

Made with ⚡ by [Skyramp](https://skyramp.dev)
