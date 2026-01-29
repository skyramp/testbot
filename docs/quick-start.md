# Quick Start Guide

Get Skyramp Test Bot running in your repository in under 5 minutes.

## Prerequisites

Before you begin, ensure you have:

1. **Skyramp License** - Contact [Skyramp](https://skyramp.com) for a license
2. **Cursor API Key** - Sign up at [Cursor](https://cursor.com) and get an API key
3. **Docker** - Required for running Skyramp Executor
4. **Existing Tests** - Some Skyramp tests in your repository (or the bot will create them)

## Step 1: Add Secrets

1. Go to your repository on GitHub
2. Navigate to **Settings → Secrets and variables → Actions**
3. Click **New repository secret**
4. Add two secrets:

   **SKYRAMP_LICENSE:**
   - Name: `SKYRAMP_LICENSE`
   - Value: Paste your entire Skyramp license file content

   **CURSOR_API_KEY:**
   - Name: `CURSOR_API_KEY`
   - Value: Your Cursor API key

## Step 2: Create Workflow File

Create `.github/workflows/skyramp-test-bot.yml` in your repository:

```yaml
name: Skyramp Test Automation
on:
  pull_request:
    branches: [main]

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

## Step 3: Commit and Push

```bash
git add .github/workflows/skyramp-test-bot.yml
git commit -m "Add Skyramp Test Bot workflow"
git push origin main
```

## Step 4: Create a Test PR

Make a code change and open a pull request:

```bash
# Create a new branch
git checkout -b test-skyramp-bot

# Make some changes to your API code
echo "// New feature" >> src/api/users.js

# Commit and push
git add src/api/users.js
git commit -m "Add new feature"
git push origin test-skyramp-bot
```

Then open a pull request on GitHub.

## Step 5: Watch It Work

Once the PR is created:

1. Go to the **Actions** tab in your repository
2. You'll see the "Skyramp Test Automation" workflow running
3. Wait for it to complete (typically 2-5 minutes)
4. Check the PR for:
   - A comment with test maintenance summary
   - Committed test changes (if tests were modified)

## What Happens Next?

The bot will:

1. ✅ Analyze your code changes
2. ✅ Identify relevant existing tests
3. ✅ Update tests to match new code
4. ✅ Generate new tests for uncovered changes
5. ✅ Execute all tests
6. ✅ Commit the changes
7. ✅ Post a summary comment on the PR

## Customizing Your Setup

### Change Test Directory

If your tests are not in the `tests/` directory:

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    test_directory: 'api/tests'
    test_file_pattern: 'api/tests/**/*'
```

### Custom Service Startup

If you don't use `docker compose up -d`:

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    service_startup_command: 'npm run start:services'
```

### Disable Auto-commit

If you want to review changes before committing:

```yaml
- uses: skyramp/test-bot@v1
  with:
    skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    auto_commit: false
```

## Troubleshooting

### "License file is empty"

- Verify you copied the entire license file content
- Check for extra whitespace or newlines
- Re-create the secret if needed

### "Cursor CLI installation fails"

- Check your runner has internet access
- Try enabling debug mode: `enable_debug: true`
- See [troubleshooting guide](troubleshooting.md)

### "Service startup command failed"

- Verify your `docker-compose.yml` exists
- Check Docker is available on the runner
- Try `skip_service_startup: true` if services aren't needed

### "No tests modified or created"

This is normal if:
- Changes don't affect testable code
- Tests are already up-to-date
- Changes are in documentation or config files

## Next Steps

- Read the [configuration guide](configuration.md) for advanced options
- Check out [example workflows](../examples/) for more scenarios
- Review [troubleshooting guide](troubleshooting.md) for common issues
- Star the repository and give feedback!

## Getting Help

- **Issues**: [GitHub Issues](https://github.com/skyramp/test-bot/issues)
- **Documentation**: [Full docs](configuration.md)
- **Support**: support@skyramp.com

---

That's it! You now have automated test maintenance running on every pull request.
