import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentCommand } from '../types'
import { AgentStrategy, SKYRAMP_MCP_SERVER_NAME } from '../types'
import { exec, secondsToMilliseconds } from '../utils'

export class CursorAgent extends AgentStrategy {
  readonly label = 'Cursor'
  readonly binary = 'agent'
  readonly envVar = 'CURSOR_API_KEY'
  readonly apiKeyField = 'cursorApiKey' as const
  readonly supportsNdjsonLog = true

  async install(): Promise<void> {
    await exec('bash', ['-c', 'set -o pipefail; curl https://cursor.com/install -fsS | bash'])
    core.addPath(`${process.env.HOME}/.local/bin`)
    await exec('agent', ['--version'], { silent: true })
  }

  async initialize(): Promise<void> {
    const { exitCode } = await exec('agent', ['mcp', 'enable', SKYRAMP_MCP_SERVER_NAME], { ignoreReturnCode: true })
    if (exitCode !== 0) {
      throw new Error(`Failed to enable MCP server '${SKYRAMP_MCP_SERVER_NAME}' (exit code ${exitCode})`)
    }

    // Verify MCP server is connected
    try {
      const { stdout } = await exec('agent', ['mcp', 'list'])
      if (stdout.includes(SKYRAMP_MCP_SERVER_NAME)) {
        core.notice(`Cursor MCP server verified: ${SKYRAMP_MCP_SERVER_NAME} is listed`)
      } else {
        core.warning(`${SKYRAMP_MCP_SERVER_NAME} not found in MCP server list`)
      }
    } catch {
      core.warning('Could not list MCP servers')
    }
  }

  async configureMcp(
    mcpCommand: string, argsArray: string[], env: Record<string, string>, timeout: number
  ): Promise<void> {
    const configDir = path.join(process.env.HOME ?? '~', '.cursor')
    fs.mkdirSync(configDir, { recursive: true })

    const config = {
      mcpServers: {
        [SKYRAMP_MCP_SERVER_NAME]: {
          command: mcpCommand,
          args: argsArray,
          env,
          timeout: secondsToMilliseconds(timeout),
        },
      },
    }
    fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify(config, null, 2))
  }

  buildCommand(enableDebug: boolean): AgentCommand {
    const args = ['-f', '-p', '--model', 'sonnet-4.5']
    if (enableDebug) {
      args.push('--output-format', 'stream-json')
    }
    return { command: 'agent', args }
  }
}
