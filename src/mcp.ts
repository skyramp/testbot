import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import type { ActionInputs, McpPaths, ResolvedConfig } from './types'
import type { AgentStrategy } from './types'
import { exec, debug, withGroup, secondsToMilliseconds } from './utils'


// npm install can stall indefinitely if a postinstall script downloads
// large binaries over a slow connection (e.g. @skyramp/skyramp's 172MB .so).
// 3 minutes is generous for any single npm install.
const NPM_INSTALL_TIMEOUT_MS = secondsToMilliseconds(180)

/**
 * Install the Skyramp MCP server (from npm or github source).
 * Returns the command/args needed to run the MCP server.
 */
export async function installMcp(
  config: ResolvedConfig,
  inputs: ActionInputs,
  tempDir: string
): Promise<McpPaths> {
  return withGroup('Installing Skyramp MCP', async () => {
    let command: string
    let args: string

    // Install into an isolated directory under tempDir so npm never
    // interacts with the target repo's package manager config (e.g.
    // pnpm catalog: protocol, yarn workspaces, etc.).
    const mcpInstallDir = path.join(tempDir, 'mcp')
    fs.mkdirSync(mcpInstallDir, { recursive: true })

    if (config.skyrampMcpSource === 'github') {
      // Validate github token
      if (!inputs.skyrampMcpGithubToken) {
        throw new Error("skyramp_mcp_github_token is required when skyramp_mcp_source is 'github'")
      }

      core.setSecret(inputs.skyrampMcpGithubToken)

      const mcpPkgDir = path.join(mcpInstallDir, 'node_modules', '@skyramp', 'mcp')
      fs.mkdirSync(path.dirname(mcpPkgDir), { recursive: true })

      const repoUrl = `https://x-access-token:${inputs.skyrampMcpGithubToken}@github.com/letsramp/mcp.git`
      const ref = config.skyrampMcpGithubRef

      // Handle branch/tag vs commit SHA
      const isSha = /^[0-9a-fA-F]{7,40}$/.test(ref)
      if (isSha) {
        core.info(`Fetching @skyramp/mcp from github.com/letsramp/mcp at commit ${ref}`)
        await exec('git', ['init', mcpPkgDir])
        await exec('git', ['-C', mcpPkgDir, 'remote', 'add', 'origin', repoUrl])
        await exec('git', ['-C', mcpPkgDir, 'fetch', '--depth', '1', 'origin', ref])
        await exec('git', ['-C', mcpPkgDir, 'checkout', 'FETCH_HEAD'])
      } else {
        core.info(`Cloning @skyramp/mcp from github.com/letsramp/mcp (ref: ${ref})`)
        await exec('git', ['clone', '--depth', '1', '--branch', ref, repoUrl, mcpPkgDir])
      }

      // Log the exact commit SHA
      const { stdout: commitSha } = await exec('git', ['-C', mcpPkgDir, 'rev-parse', 'HEAD'], { silent: true })
      core.notice(`@skyramp/mcp commit: ${commitSha.trim()} (ref: ${ref})`)

      // Remove .git to prevent PAT token persistence
      fs.rmSync(path.join(mcpPkgDir, '.git'), { recursive: true, force: true })

      // Install dependencies and build
      core.info('Installing dependencies and building...')
      await exec('npm', ['install', '--include=dev'], { cwd: mcpPkgDir, timeout: NPM_INSTALL_TIMEOUT_MS })
      await exec('npm', ['run', 'build'], { cwd: mcpPkgDir })

      command = 'node'
      args = path.join(mcpPkgDir, 'build', 'index.js')

      // Expose mcp's dependencies to top-level node resolution
      core.exportVariable('NODE_PATH', path.join(mcpPkgDir, 'node_modules'))
    } else {
      // npm source (default) — install in isolated temp dir to avoid
      // conflicts with the repo's package manager (pnpm catalog:, etc.)
      const pkg = config.skyrampMcpVersion === 'latest'
        ? '@skyramp/mcp'
        : `@skyramp/mcp@${config.skyrampMcpVersion}`

      await exec('npm', ['install', pkg], { cwd: mcpInstallDir, timeout: NPM_INSTALL_TIMEOUT_MS })

      const mcpPkgDir = path.join(mcpInstallDir, 'node_modules', '@skyramp', 'mcp')
      command = 'node'
      args = path.join(mcpPkgDir, 'build', 'index.js')

      // Expose installed packages to top-level node resolution (needed by
      // license validation and any other code that require()s @skyramp/*)
      core.exportVariable('NODE_PATH', path.join(mcpInstallDir, 'node_modules'))
    }

    core.notice(`Skyramp MCP installed successfully (source: ${config.skyrampMcpSource})`)
    return { command, args, licensePath: '' }
  })
}

/**
 * Write the MCP server configuration file for the given agent type.
 */
export async function configureMcp(
  agent: AgentStrategy,
  mcpCommand: string,
  mcpArgs: string,
  licensePath: string,
  testExecutionTimeout: number,
): Promise<void> {
  await withGroup(`Configuring MCP server for ${agent.label}`, async () => {
    const argsArray = mcpArgs.split(' ')
    const env: Record<string, string> = {
      LICENSE_FILE: licensePath,
      CI: 'true',
      SKYRAMP_FEATURE_TESTBOT: '1',
    }

    await agent.configureMcp(mcpCommand, argsArray, env, testExecutionTimeout)

    debug('MCP configuration written')
    core.notice(`MCP server configured for ${agent.label}`)
  })
}
