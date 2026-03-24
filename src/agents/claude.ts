import * as core from '@actions/core'
import type { ActionInputs, AgentCommand, ResolvedConfig } from '../types'
import { AgentStrategy, SKYRAMP_MCP_SERVER_NAME } from '../types'
import { exec, secondsToMilliseconds } from '../utils'

export class ClaudeAgent extends AgentStrategy {
  readonly label = 'Claude Code'
  readonly binary = 'claude'
  readonly envVar = 'ANTHROPIC_API_KEY'
  readonly apiKeyField = 'anthropicApiKey' as const
  readonly supportsNdjsonLog = true

  async install(): Promise<void> {
    await exec('npm', ['install', '-g', '@anthropic-ai/claude-code'])
  }

  async initialize(): Promise<void> {
    try {
      await exec('claude', ['--version'])
      core.notice('Claude Code CLI initialized successfully')
    } catch {
      core.warning('Could not verify Claude Code CLI version')
    }

    // Verify MCP server is connected
    try {
      const { stdout } = await exec('claude', ['mcp', 'list'])
      const isSkyrampConnected = stdout
        .split('\n')
        .some(line => line.includes(SKYRAMP_MCP_SERVER_NAME) && line.toLowerCase().includes('connected'))

      if (isSkyrampConnected) {
        core.notice(`Claude MCP server verified: ${SKYRAMP_MCP_SERVER_NAME} is connected`)
      } else {
        core.warning(`${SKYRAMP_MCP_SERVER_NAME} does not appear connected in MCP server list`)
      }
    } catch {
      core.warning('Could not verify MCP server connectivity')
    }
  }

  async configureMcp(
    mcpCommand: string, argsArray: string[], env: Record<string, string>, _timeout: number
  ): Promise<void> {
    // Use `claude mcp add` to register the server properly
    // Note: server name must come before -e flags (CLI parses -e greedily)
    const addArgs = ['mcp', 'add', '--scope', 'user', SKYRAMP_MCP_SERVER_NAME]
    for (const [key, value] of Object.entries(env)) {
      addArgs.push('-e', `${key}=${value}`)
    }
    addArgs.push('--', mcpCommand, ...argsArray)
    await exec('claude', addArgs)
  }

  buildCommand(enableDebug: boolean): AgentCommand {
    const args = [
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '-p',
      '--output-format', 'stream-json', // always on for telemetry (token usage)
    ]
    if (enableDebug) {
      args.push('--verbose')
    }
    return { command: 'claude', args }
  }

  exportEnv(inputs: ActionInputs, config: ResolvedConfig): void {
    if (inputs.anthropicApiKey) {
      // Set as subprocess-scoped env var (not core.exportVariable which leaks to subsequent steps)
      process.env.ANTHROPIC_API_KEY = inputs.anthropicApiKey
      // Set MCP tool timeout (in ms) so long-running tools like skyramp_execute_test don't time out
      process.env.MCP_TIMEOUT = String(secondsToMilliseconds(config.testExecutionTimeout))
    }
  }
}
