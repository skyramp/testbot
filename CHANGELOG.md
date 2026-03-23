# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes
- **Action inputs use camelCase** (e.g. `testDirectory`, `targetSetupCommand`, `skyrampLicenseFile`, `githubToken`) to match `.skyramp/workspace.yml` service fields and `ActionInputs` — replace all snake_case input keys in workflows.
- Renamed `service_startup_command` → `targetSetupCommand`
- Renamed `skip_service_startup` → `skipTargetSetup`
- Renamed `health_check_command` → `targetReadyCheckCommand`
- Renamed `health_check_timeout` → `targetReadyCheckTimeout`
- Renamed `health_check_diagnostics_command` → `targetReadyCheckDiagnosticsCommand`

### Added
- `targetTeardownCommand` input for guaranteed service cleanup via GitHub Actions `post` step
- `skipTargetTeardown` input to disable teardown without removing the command
- `dist/post.js` post-step entry point for teardown execution

### Planned
- Caching for Cursor CLI installation
- Enhanced test execution reporting
- Multi-language test support
- Parallel test execution
- Integration with GitHub Checks API
- Notification integrations (Slack, Discord)

## [1.0.0] - 2026-01-29

### Added
- Initial release of Skyramp Testbot
- AI-powered test maintenance using Cursor CLI
- Automatic test generation for code changes
- Smart change detection via git diff analysis
- Integration with Skyramp MCP for test operations
- Auto-commit functionality for test changes
- PR comment integration with detailed summaries
- 14 configurable inputs for customization
- 4 outputs for test metrics
- Comprehensive documentation (README, troubleshooting, configuration)
- Multiple example workflows
- Retry logic for network operations
- Debug mode for troubleshooting
- Idempotent installation checks
- Proper error handling and user feedback
- Security best practices (secrets, permissions, sandboxing)

### Features
- **Required Inputs:**
  - `skyrampLicenseFile` - Skyramp license content
  - `cursorApiKey` - Cursor API key

- **Optional Inputs:**
  - `testDirectory` (default: `tests`)
  - `service_startup_command` (default: `docker compose up -d`)
  - `skyrampExecutorVersion` (default: `v1.3.14`)
  - `skyrampMcpVersion` (default: `latest`)
  - `nodeVersion` (default: `lts/*`)
  - `skip_service_startup` (default: `false`)
  - `workingDirectory` (default: `.`)
  - `autoCommit` (default: `true`)
  - `commitMessage` (default: `Skyramp Testbot: test maintenance suggestions`)
  - `postPrComment` (default: `true`)
  - `enableDebug` (default: `false`)

- **Outputs:**
  - `test_summary` - Full summary text
  - `tests_modified` - Count of modified tests
  - `tests_created` - Count of created tests
  - `tests_executed` - Count of executed tests

### Documentation
- Comprehensive README with quick start guide
- Detailed input/output reference
- 4 usage examples (basic, advanced, manual review, custom paths)
- Troubleshooting guide covering common issues
- Configuration guide with advanced patterns
- Apache 2.0 license

### Infrastructure
- Uses runner temp directory for isolation
- Proper file permissions for license file
- Grouped logs for better readability
- GitHub Actions annotations for errors/warnings
- Retry mechanisms for Docker pulls and installations

## [0.1.0] - 2026-01-28 [PROTOTYPE]

### Added
- Prototype implementation in `api-insight/.github/actions/skyramp/`
- Basic Cursor CLI integration
- Hardcoded paths and values
- Manual Skyramp MCP setup
- Simple git diff generation
- Basic PR commenting

### Known Issues (Fixed in v1.0.0)
- Used `/tmp/` instead of runner temp directory
- No input validation
- No retry logic
- No idempotent installations
- Limited error handling
- No documentation

---

## Version Tagging Strategy

This project maintains three types of tags for each release:

- **Specific version**: `v1.0.0` - Immutable, points to exact release
- **Minor version**: `v1.0` - Moves with new patches (v1.0.1, v1.0.2, etc.)
- **Major version**: `v1` - Moves with new minors (v1.1.0, v1.2.0, etc.)

Users can choose their stability level:
```yaml
uses: skyramp/testbot@v1       # Latest (recommended for development)
uses: skyramp/testbot@v1.0     # Latest patch only
uses: skyramp/testbot@v1.0.0   # Pinned (recommended for production)
```

## Release Process

1. Update CHANGELOG.md with new version and changes
2. Update version references in documentation
3. Create git tag: `git tag -a v1.0.0 -m "Release v1.0.0"`
4. Push tag: `git push origin v1.0.0`
5. Create GitHub release with changelog notes
6. Move/create major and minor version tags:
   ```bash
   git tag -fa v1.0 -m "Release v1.0"
   git tag -fa v1 -m "Release v1"
   git push origin v1.0 v1 --force
   ```

## Support

For questions, issues, or contributions:
- **Issues**: https://github.com/skyramp/testbot/issues
- **Discussions**: https://github.com/skyramp/testbot/discussions
- **Email**: support@skyramp.com

[Unreleased]: https://github.com/skyramp/testbot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/skyramp/testbot/releases/tag/v1.0.0
[0.1.0]: https://github.com/skyramp/api-insight/tree/kslee/demo3/.github/actions/skyramp
