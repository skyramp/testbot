import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import type { ActionInputs, AgentType, McpPaths, ResolvedConfig } from './types'
import { SKYRAMP_MCP_SERVER_NAME } from './types'
import { exec, debug, secondsToMilliseconds } from './utils'


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
  workingDir: string
): Promise<McpPaths> {
  core.startGroup('Installing Skyramp MCP')

  let command: string
  let args: string

  if (config.skyrampMcpSource === 'github') {
    // Validate github token
    if (!inputs.skyrampMcpGithubToken) {
      throw new Error("skyramp_mcp_github_token is required when skyramp_mcp_source is 'github'")
    }

    core.setSecret(inputs.skyrampMcpGithubToken)

    const mcpPkgDir = path.join(workingDir, 'node_modules', '@skyramp', 'mcp')
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
    // npm source (default)
    const pkg = config.skyrampMcpVersion === 'latest'
      ? '@skyramp/mcp'
      : `@skyramp/mcp@${config.skyrampMcpVersion}`

    await exec('npm', ['install', pkg], { cwd: workingDir, timeout: NPM_INSTALL_TIMEOUT_MS })

    command = 'npx'
    args = config.skyrampMcpVersion === 'latest'
      ? '-y @skyramp/mcp'
      : `-y @skyramp/mcp@${config.skyrampMcpVersion}`
  }

  core.notice(`Skyramp MCP installed successfully (source: ${config.skyrampMcpSource})`)
  core.endGroup()

  return { command, args, licensePath: '' }
}

/**
 * Write the MCP server configuration file for the given agent type.
 */
export async function configureMcp(
  agentType: AgentType,
  mcpCommand: string,
  mcpArgs: string,
  licensePath: string,
  testExecutionTimeout: number,
): Promise<void> {
  core.startGroup(`Configuring MCP server for ${agentType}`)

  const argsArray = mcpArgs.split(' ')
  const env: Record<string, string> = {
    LICENSE_FILE: licensePath,
    CI: 'true',
    SKYRAMP_FEATURE_TESTBOT: '1',
  }

  if (agentType === 'cursor') {
    const configDir = path.join(process.env.HOME ?? '~', '.cursor')
    fs.mkdirSync(configDir, { recursive: true })

    const config = {
      mcpServers: {
        [SKYRAMP_MCP_SERVER_NAME]: {
          command: mcpCommand,
          args: argsArray,
          env,
          timeout: secondsToMilliseconds(testExecutionTimeout),
        },
      },
    }
    fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify(config, null, 2))
  } else if (agentType === 'claude') {
    // Use `claude mcp add` to register the server properly
    // Note: server name must come before -e flags (CLI parses -e greedily)
    const addArgs = ['mcp', 'add', '--scope', 'user', SKYRAMP_MCP_SERVER_NAME]
    for (const [key, value] of Object.entries(env)) {
      addArgs.push('-e', `${key}=${value}`)
    }
    addArgs.push('--', mcpCommand, ...argsArray)
    await exec('claude', addArgs)
  } else {
    // Copilot
    const homeDir = path.join(process.env.HOME ?? '~', '.copilot')
    fs.mkdirSync(homeDir, { recursive: true })

    const config = {
      mcpServers: {
        [SKYRAMP_MCP_SERVER_NAME]: {
          type: 'local',
          command: mcpCommand,
          args: argsArray,
          tools: ['*'],
          env,
          timeout: secondsToMilliseconds(testExecutionTimeout),
        },
      },
    }

    const configJson = JSON.stringify(config, null, 2)
    fs.writeFileSync(path.join(homeDir, 'mcp-config.json'), configJson)

    // Also write repo-level config for Copilot discovery
    const repoDir = path.join(process.cwd(), '.copilot')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'mcp-config.json'), configJson)
  }

  debug('MCP configuration written')
  core.notice(`MCP server configured for ${agentType}`)
  core.endGroup()
}
