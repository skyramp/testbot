# Troubleshooting Guide

This guide covers common issues and their solutions when using Skyramp Test Bot.

## Table of Contents

- [Installation Issues](#installation-issues)
- [License Issues](#license-issues)
- [Service Startup Issues](#service-startup-issues)
- [Agent Issues](#agent-issues)
- [Network Issues](#network-issues)
- [Permission Issues](#permission-issues)
- [Debug Mode](#debug-mode)

## Installation Issues

### Cursor CLI Installation Fails

**Symptoms:**
```
::error::Failed to install Cursor CLI after 3 attempts
```

**Possible Causes:**
1. Network connectivity issues
2. Installation endpoint unavailable
3. Runner firewall restrictions

**Solutions:**

1. **Check network connectivity:**
   ```yaml
   - name: Test connectivity
     run: curl -I https://cursor.com/install
   ```

2. **Use a different runner:**
   - Try `ubuntu-22.04` instead of `ubuntu-latest`
   - Consider self-hosted runners if corporate firewall is blocking

3. **Enable debug mode to see detailed errors:**
   ```yaml
   - uses: skyramp/test-bot@v1
     with:
       enable_debug: true
   ```

### Node.js Setup Fails

**Symptoms:**
```
Error: Unable to locate executable file: node
```

**Solutions:**

1. **Specify a different Node.js version:**
   ```yaml
   - uses: skyramp/test-bot@v1
     with:
       node_version: '18.x'
   ```

2. **Verify setup-node action version:**
   - The action uses `actions/setup-node@v4`
   - Check for any GitHub Actions service issues

### Skyramp MCP Installation Fails

**Symptoms:**
```
npm ERR! 404 Not Found - GET https://registry.npmjs.org/@skyramp/mcp
```

**Solutions:**

1. **Check npm registry access:**
   ```yaml
   - name: Test npm connectivity
     run: npm ping
   ```

2. **Use a specific MCP version:**
   ```yaml
   - uses: skyramp/test-bot@v1
     with:
       skyramp_mcp_version: '1.0.0'
   ```

## License Issues

### License File Empty or Invalid

**Symptoms:**
```
::error::License file is empty or could not be created
```

**Solutions:**

1. **Verify secret is properly set:**
   - Go to repository Settings → Secrets → Actions
   - Ensure `SKYRAMP_LICENSE` is set and not empty
   - Check for trailing whitespace or newlines

2. **Test secret content:**
   ```yaml
   - name: Check license secret
     env:
       LICENSE: ${{ secrets.SKYRAMP_LICENSE }}
     run: |
       if [ -z "$LICENSE" ]; then
         echo "Secret is empty!"
       else
         echo "Secret length: ${#LICENSE} characters"
       fi
   ```

3. **Ensure proper encoding:**
   - License file should be base64 encoded if binary
   - Use `cat license.lic | base64` to encode
   - Store the base64 string in GitHub Secrets

### License Validation Fails

**Symptoms:**
```
Skyramp MCP returns license validation error
```

**Solutions:**

1. **Check license expiration:**
   - Contact Skyramp support to verify license status
   - Ensure license is valid for CI/CD usage

2. **Verify license file format:**
   - License should be in correct format expected by Skyramp
   - Check with Skyramp documentation

## Service Startup Issues

### Docker Compose Fails

**Symptoms:**
```
::warning::Service startup command failed, but continuing...
```

**Solutions:**

1. **Verify docker-compose.yml exists:**
   ```yaml
   - name: Check compose file
     run: |
       if [ ! -f docker-compose.yml ]; then
         echo "docker-compose.yml not found!"
         exit 1
       fi
   ```

2. **Use explicit path:**
   ```yaml
   - uses: skyramp/test-bot@v1
     with:
       service_startup_command: 'docker compose -f ./docker-compose.yml up -d'
   ```

3. **Check Docker daemon:**
   ```yaml
   - name: Verify Docker
     run: docker ps
   ```

### Custom Service Startup Fails

**Symptoms:**
Service startup command returns non-zero exit code

**Solutions:**

1. **Test command separately:**
   ```yaml
   - name: Test startup command
     run: npm run start:services  # or your command
   ```

2. **Add error handling:**
   ```yaml
   - uses: skyramp/test-bot@v1
     with:
       service_startup_command: 'npm run start:services || echo "Services failed but continuing"'
   ```

3. **Skip service startup if not needed:**
   ```yaml
   - uses: skyramp/test-bot@v1
     with:
       skip_service_startup: true
   ```

## Agent Issues

### Agent Timeout

**Symptoms:**
Agent command hangs or times out

**Solutions:**

1. **Check Cursor API key:**
   - Verify API key is valid
   - Check API quota/limits
   - Ensure key has necessary permissions

2. **Simplify the task:**
   - Reduce number of files in diff
   - Focus on specific test directory
   - Break into smaller PRs

3. **Increase timeout (if possible):**
   - This is handled by the agent itself
   - Contact Cursor support if persistent

### Agent Fails to Enable MCP

**Symptoms:**
```
agent mcp enable skyramp-mcp
Error: Could not enable MCP server
```

**Solutions:**

1. **Verify MCP configuration:**
   ```yaml
   - name: Debug MCP config
     run: cat $HOME/.cursor/mcp.json
   ```

2. **Check MCP server installation:**
   ```yaml
   - name: Test MCP directly
     run: npx -y @skyramp/mcp@latest --version
   ```

3. **Wait longer for initialization:**
   - Current wait time is 10 seconds
   - May need adjustment based on runner performance

### Agent Cannot Access Git Diff

**Symptoms:**
Agent reports it cannot read diff file

**Solutions:**

1. **Verify diff was generated:**
   ```yaml
   - name: Check diff file
     run: |
       if [ -f ${{ runner.temp }}/skyramp/git_diff ]; then
         echo "Diff exists, size: $(wc -l < ${{ runner.temp }}/skyramp/git_diff) lines"
       else
         echo "Diff file missing!"
       fi
   ```

2. **Check file permissions:**
   ```yaml
   - name: Fix permissions
     run: chmod 644 ${{ runner.temp }}/skyramp/git_diff
   ```

## Network Issues

### Docker Pull Fails

**Symptoms:**
```
::error::Failed to pull Skyramp Executor after 3 attempts
```

**Solutions:**

1. **Check Docker Hub access:**
   ```yaml
   - name: Test Docker pull
     run: docker pull hello-world
   ```

2. **Use different registry mirror:**
   - Configure Docker daemon with mirror
   - Use self-hosted runner with better connectivity

3. **Pull image in separate step:**
   ```yaml
   - name: Pre-pull Skyramp Executor
     run: docker pull skyramp/executor:v1.3.3
   ```

## Permission Issues

### Cannot Commit Changes

**Symptoms:**
```
Error: Insufficient permissions to commit
```

**Solutions:**

1. **Add required permissions:**
   ```yaml
   jobs:
     test-maintenance:
       permissions:
         contents: write  # Required for commits
         pull-requests: write  # Required for PR comments
   ```

2. **Use GitHub token with proper scope:**
   - Default `GITHUB_TOKEN` should work
   - For forks, may need different approach

3. **Check branch protection rules:**
   - Some branches may block direct commits
   - Consider using PR from bot

### Cannot Post PR Comment

**Symptoms:**
```
Error: Resource not accessible by integration
```

**Solutions:**

1. **Add pull-requests permission:**
   ```yaml
   permissions:
     pull-requests: write
   ```

2. **Verify PR context:**
   - Action must run on pull_request event
   - PR number must be available

## Debug Mode

### Enabling Debug Mode

To get detailed logs for troubleshooting:

```yaml
- uses: skyramp/test-bot@v1
  with:
    enable_debug: true
```

This will output:
- Git diff content
- MCP configuration
- Active MCP servers
- Summary content
- All internal variables

### GitHub Actions Debug Logs

For even more detail, enable Actions debug logging:

1. Go to repository Settings → Secrets → Actions
2. Add secret: `ACTIONS_STEP_DEBUG` = `true`
3. Add secret: `ACTIONS_RUNNER_DEBUG` = `true`

This provides runner-level debugging information.

## Getting Help

If you've tried these solutions and still have issues:

1. **Check existing issues:** [GitHub Issues](https://github.com/skyramp/test-bot/issues)
2. **Enable debug mode** and include logs in your issue report
3. **Provide minimal reproduction** if possible
4. **Contact support:** support@skyramp.com

## Common Error Messages

### Quick Reference

| Error Message | Common Cause | Quick Fix |
|--------------|--------------|-----------|
| `skyramp_license_file is required` | Missing secret | Add SKYRAMP_LICENSE to secrets |
| `cursor_api_key is required` | Missing secret | Add CURSOR_API_KEY to secrets |
| `License file is empty` | Empty secret value | Check secret content |
| `Failed to install Cursor CLI` | Network/firewall | Check connectivity, try different runner |
| `Service startup command failed` | Missing compose file | Verify docker-compose.yml exists |
| `Test maintenance failed` | Various | Enable debug mode, check agent logs |
| `Resource not accessible` | Missing permissions | Add contents: write, pull-requests: write |

## Reporting Bugs

When reporting issues, please include:

1. **Action version:** (e.g., `@v1.0.0`)
2. **Runner:** (e.g., `ubuntu-latest`)
3. **Error message:** (full error from logs)
4. **Debug logs:** (with `enable_debug: true`)
5. **Minimal workflow:** (that reproduces the issue)
6. **Expected behavior:** (what should happen)

This helps us resolve issues faster.
