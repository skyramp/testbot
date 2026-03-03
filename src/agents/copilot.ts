import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentCommand } from '../types'
import { AgentStrategy, SKYRAMP_MCP_SERVER_NAME } from '../types'
import { exec, secondsToMilliseconds } from '../utils'

export class CopilotAgent extends AgentStrategy {
  readonly label = 'GitHub Copilot'
  readonly binary = 'copilot'
  readonly envVar = 'GH_TOKEN'
  readonly apiKeyField = 'copilotApiKey' as const

  async install(): Promise<void> {
    await exec('npm', ['install', '-g', '@github/copilot'])
  }

  async initialize(): Promise<void> {
    try {
      await exec('copilot', ['--version'])
      core.notice('GitHub Copilot CLI initialized successfully')
    } catch {
      core.warning('Could not verify Copilot CLI version')
    }
  }

  async configureMcp(
    mcpCommand: string, argsArray: string[], env: Record<string, string>, timeout: number
  ): Promise<void> {
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
          timeout: secondsToMilliseconds(timeout),
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

  buildCommand(_enableDebug: boolean): AgentCommand {
    return {
      command: 'copilot',
      args: [
        '--additional-mcp-config',
        `@${process.env.HOME}/.copilot/mcp-config.json`,
        '--allow-all-tools',
        '--allow-all-paths',
        '-p',
      ],
    }
  }
}
