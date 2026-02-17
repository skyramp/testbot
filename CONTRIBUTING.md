# Contributing to Skyramp Testbot

Thank you for your interest in contributing to Skyramp Testbot! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for all contributors.

## How Can I Contribute?

### Reporting Bugs

Before creating a bug report:
- Check the [troubleshooting guide](docs/troubleshooting.md)
- Search [existing issues](https://github.com/skyramp/test-bot/issues)
- Try with `enable_debug: true` to gather more information

When reporting a bug, include:
- Action version (e.g., `@v1.0.0`)
- Runner OS and version
- Full error message and logs
- Minimal workflow that reproduces the issue
- Expected vs actual behavior

### Suggesting Enhancements

Enhancement suggestions are welcome! Please:
- Use a clear and descriptive title
- Provide detailed description of the enhancement
- Explain why this enhancement would be useful
- Include examples of how it would work

### Pull Requests

1. **Fork the repository**
   ```bash
   gh repo fork skyramp/test-bot
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes**
   - Follow the coding standards below
   - Add or update tests as needed
   - Update documentation

4. **Test your changes**
   - Test locally with `.github/actions/test-bot`
   - Verify with multiple scenarios
   - Ensure no breaking changes

5. **Commit your changes**
   ```bash
   git commit -m "feat: add new feature"
   ```
   Follow [Conventional Commits](https://www.conventionalcommits.org/)

6. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request**
   - Use a clear title and description
   - Reference related issues
   - Include screenshots if applicable
   - Ensure CI passes

## Development Setup

### Prerequisites

- Git
- Docker
- Node.js (LTS)
- GitHub CLI (optional)

### Local Testing

1. **Create a test repository:**
   ```bash
   mkdir test-repo && cd test-repo
   git init
   ```

2. **Copy action to test repository:**
   ```bash
   mkdir -p .github/actions
   cp -r /path/to/test-bot .github/actions/test-bot
   ```

3. **Create test workflow:**
   ```yaml
   # .github/workflows/test.yml
   name: Test Action
   on: [push]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: ./.github/actions/test-bot
           with:
             skyramp_license_file: ${{ secrets.SKYRAMP_LICENSE }}
             cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
   ```

4. **Push and test:**
   ```bash
   git add .
   git commit -m "test: action changes"
   git push
   ```

## Coding Standards

### YAML Style

- Use 2 spaces for indentation
- Use single quotes for strings (unless escaping needed)
- Add comments for complex logic
- Group related inputs/steps

### Shell Scripts

- Use `set -e` for error handling (via composite action)
- Quote all variables: `"${{ inputs.variable }}"`
- Use meaningful variable names
- Add comments for non-obvious commands
- Use `echo "::group::"` for grouped output

### Documentation

- Use markdown for all documentation
- Include code examples for features
- Keep line length under 100 characters
- Update README when adding inputs/outputs
- Add entries to CHANGELOG.md

### Git Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Examples:
```
feat: add caching support for Cursor CLI installation
fix: resolve path issues in monorepo setups
docs: update troubleshooting guide with license issues
```

## Testing Guidelines

### Test Scenarios

When adding new features, test with:

1. **Basic usage** - Default configuration
2. **Custom inputs** - Non-default values
3. **Edge cases** - Empty diffs, missing files, etc.
4. **Error conditions** - Invalid inputs, failures
5. **Different runners** - ubuntu-latest, ubuntu-22.04

### Test Checklist

- [ ] Action completes successfully
- [ ] Inputs are validated correctly
- [ ] Outputs are populated correctly
- [ ] Error messages are clear
- [ ] Debug mode provides useful info
- [ ] No secrets leaked in logs
- [ ] Paths work with spaces/special chars
- [ ] Retries work for transient failures

## Documentation Updates

When changing functionality, update:

- [ ] `README.md` - If inputs/outputs change
- [ ] `docs/configuration.md` - For new configuration options
- [ ] `docs/troubleshooting.md` - For new issues/solutions
- [ ] `examples/` - Add examples for new features
- [ ] `CHANGELOG.md` - Add entry under [Unreleased]

## Review Process

Pull requests are reviewed for:

1. **Functionality** - Does it work as intended?
2. **Code quality** - Is it maintainable?
3. **Testing** - Is it adequately tested?
4. **Documentation** - Is it well documented?
5. **Compatibility** - Does it break existing usage?

## Release Process

Maintainers follow this process for releases:

1. Update version in CHANGELOG.md
2. Update version references in docs
3. Create and push version tag
4. Create GitHub release
5. Update major/minor version tags

## Questions?

- Check [documentation](docs/)
- Search [existing issues](https://github.com/skyramp/test-bot/issues)
- Ask in [discussions](https://github.com/skyramp/test-bot/discussions)
- Email support@skyramp.com

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

---

Thank you for contributing to Skyramp Testbot!
