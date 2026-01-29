# Skyramp Test Bot

> Automated test maintenance for your REST APIs using AI-powered agents

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Skyramp%20Test%20Bot-blue?logo=github)](https://github.com/marketplace/actions/skyramp-test-bot)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## Features

- 🤖 **AI-Powered Test Maintenance** - Automatically updates tests when code changes
- 🔍 **Smart Change Detection** - Analyzes git diffs to identify impacted tests
- ✨ **Test Generation** - Creates new tests for uncovered code changes
- ✅ **Automated Test Execution** - Runs tests and validates results
- 💬 **PR Integration** - Posts detailed summaries as PR comments
- 🔄 **Auto-commit** - Optionally commits test changes automatically
- 🎯 **Configurable** - 14 inputs for customization to your workflow

## Quick Start

Add this workflow to your repository:

```yaml
name: Skyramp Test Automation
on: [pull_request]

jobs:
  test-maintenance:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: skyramp/test-bot@v1
        with:
          skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
          cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
```

## Prerequisites

Before using this action, ensure you have:

- [ ] Skyramp license file content stored in GitHub Secrets as `SKYRAMP_LICENSE`
- [ ] Cursor API key stored in GitHub Secrets as `CURSOR_API_KEY`
- [ ] Docker available in your runner (for Skyramp Executor)
- [ ] Node.js compatible project (action installs Node.js automatically)
- [ ] Existing Skyramp tests or a test directory structure

## Inputs

### Required

| Input | Description |
|-------|-------------|
| `skyramp_license_file` | Skyramp license file content (store in GitHub Secrets) |
| `cursor_api_key` | Cursor API key for AI agent access (store in GitHub Secrets) |

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

## Outputs

| Output | Description |
|--------|-------------|
| `test_summary` | Full summary of test maintenance actions |
| `tests_modified` | Number of tests modified |
| `tests_created` | Number of tests created |
| `tests_executed` | Number of tests executed |

## Usage Examples

### Basic Usage with Docker Compose

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
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

## How It Works

1. **Change Detection** - Generates a git diff between the base branch and current PR
2. **License Setup** - Configures Skyramp license from secrets
3. **Environment Setup** - Installs Node.js, Skyramp MCP, and Cursor CLI
4. **MCP Configuration** - Configures the Skyramp MCP server for agent access
5. **Service Startup** - Starts your services using the configured command
6. **AI Analysis** - Cursor agent analyzes changes and identifies test impacts
7. **Test Maintenance** - Updates existing tests or generates new ones using Skyramp MCP
8. **Test Execution** - Runs tests and validates results
9. **Summary Generation** - Creates detailed summary of actions taken
10. **PR Comment** - Posts summary to PR (if enabled)
11. **Auto-commit** - Commits test changes (if enabled)

## Troubleshooting

### Common Issues

**Cursor CLI installation fails**
- Check runner network connectivity
- Verify the installation endpoint is accessible
- Try enabling debug mode: `enable_debug: true`

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
- Check Cursor API key is valid and has quota remaining
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
- **Website**: [skyramp.com](https://skyramp.com)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

Built with:
- [Cursor CLI](https://cursor.com) for AI-powered agent capabilities
- [Skyramp MCP](https://github.com/skyramp/mcp) for test generation and execution
- [GitHub Actions](https://github.com/features/actions) for CI/CD automation

---

Made with ⚡ by [Skyramp](https://skyramp.com)
