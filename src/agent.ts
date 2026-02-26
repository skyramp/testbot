import * as core from '@actions/core'
import * as fs from 'fs'
import type { AgentCommand, AgentType, ResolvedConfig, WorkspaceServiceInfo } from './types'
import { exec, sleep, withRetry } from './utils'

const AGENT_LABELS: Record<AgentType, string> = {
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  claude: 'Claude Code',
}

/**
 * Install the appropriate agent CLI (Cursor, Copilot, or Claude Code).
 */
export async function installAgentCli(agentType: AgentType): Promise<void> {
  core.startGroup(`Installing ${AGENT_LABELS[agentType]} CLI`)

  if (agentType === 'cursor') {
    // Check if already installed
    try {
      const { stdout } = await exec('agent', ['--version'], { silent: true, ignoreReturnCode: true })
      core.notice(`Cursor CLI already installed (version: ${stdout.trim()})`)
      core.endGroup()
      return
    } catch {
      // Not installed, continue
    }

    await withRetry(
      async () => {
        await exec('bash', ['-c', 'set -o pipefail; curl https://cursor.com/install -fsS | bash'])
        core.addPath(`${process.env.HOME}/.local/bin`)
        // Verify the binary actually exists after install
        await exec('agent', ['--version'], { silent: true })
        core.notice('Cursor CLI installed successfully')
      },
      { retries: 3, delay: 5, label: 'Cursor CLI install' },
    )
  } else if (agentType === 'copilot') {
    try {
      const { stdout } = await exec('copilot', ['--version'], { silent: true, ignoreReturnCode: true })
      core.notice(`GitHub Copilot CLI already installed (version: ${stdout.trim()})`)
      core.endGroup()
      return
    } catch {
      // Not installed, continue
    }

    await withRetry(
      async () => {
        await exec('npm', ['install', '-g', '@github/copilot'])
        core.notice('GitHub Copilot CLI installed successfully')
      },
      { retries: 3, delay: 5, label: 'GitHub Copilot CLI install' },
    )
  } else {
    // Claude Code
    try {
      const { stdout } = await exec('claude', ['--version'], { silent: true, ignoreReturnCode: true })
      core.notice(`Claude Code CLI already installed (version: ${stdout.trim()})`)
      core.endGroup()
      return
    } catch {
      // Not installed, continue
    }

    await withRetry(
      async () => {
        await exec('npm', ['install', '-g', '@anthropic-ai/claude-code'])
        core.notice('Claude Code CLI installed successfully')
      },
      { retries: 3, delay: 5, label: 'Claude Code CLI install' },
    )
  }

  core.endGroup()
}

/**
 * Initialize the agent (enable MCP server, wait for startup).
 */
export async function initializeAgent(agentType: AgentType, _enableDebug: boolean): Promise<void> {
  core.startGroup(`Initializing ${AGENT_LABELS[agentType]} agent`)

  if (agentType === 'cursor') {
    await exec('agent', ['mcp', 'enable', 'skyramp-mcp'])
    await sleep(10)

    // Verify MCP server is connected
    try {
      const { stdout } = await exec('agent', ['mcp', 'list'])
      if (stdout.includes('skyramp-mcp')) {
        core.notice('Cursor MCP server verified: skyramp-mcp is listed')
      } else {
        core.warning('skyramp-mcp not found in MCP server list')
      }
    } catch {
      core.warning('Could not list MCP servers')
    }
  } else if (agentType === 'copilot') {
    await sleep(5)
    try {
      await exec('copilot', ['--version'])
      core.notice('GitHub Copilot CLI initialized successfully')
    } catch {
      core.warning('Could not verify Copilot CLI version')
    }
  } else {
    // Claude Code — MCP is configured via settings.json, no explicit enable needed
    try {
      await exec('claude', ['--version'])
      core.notice('Claude Code CLI initialized successfully')
    } catch {
      core.warning('Could not verify Claude Code CLI version')
    }

    // Verify MCP server is connected
    try {
      const { stdout } = await exec('claude', ['mcp', 'list'])
      if (stdout.includes('Connected')) {
        core.notice('Claude MCP server verified: skyramp-mcp is connected')
      } else {
        core.warning('skyramp-mcp does not appear connected in MCP server list')
      }
    } catch {
      core.warning('Could not verify MCP server connectivity')
    }
  }

  core.endGroup()
}

/**
 * Build the agent command (binary + args) for execution.
 */
export function buildAgentCommand(agentType: AgentType, enableDebug: boolean): AgentCommand {
  if (agentType === 'cursor') {
    const args = ['-f', '-p', '--model', 'sonnet-4.5']
    if (enableDebug) {
      args.push('--output-format', 'stream-json')
    }
    return { command: 'agent', args }
  }

  if (agentType === 'claude') {
    return {
      command: 'claude',
      args: [
        '--dangerously-skip-permissions',
        '--model', 'sonnet',
        '-p',
      ],
    }
  }

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

/**
 * Build the prompt string sent to the agent CLI.
 */
export function buildPrompt(opts: {
  prTitle: string
  prBody: string
  testDirectory: string
  summaryPath: string
  authToken: string
  repositoryPath: string
  services?: WorkspaceServiceInfo[]
}): string {
  const serviceContext = opts.services?.length
    ? buildServiceContext(opts.services)
    : ''

  return `You are the Skyramp TestBot. Read the Skyramp MCP resource at this URI:
skyramp://prompts/testbot?prTitle=${encodeURIComponent(opts.prTitle)}&prDescription=${encodeURIComponent(opts.prBody)}&diffFile=.skyramp_git_diff&testDirectory=${encodeURIComponent(opts.testDirectory)}&summaryOutputFile=${encodeURIComponent(opts.summaryPath)}&repositoryPath=${encodeURIComponent(opts.repositoryPath)}
${serviceContext}
After reading the resource, follow EVERY task returned by it. ALL tasks (Task 1: Recommend New Tests, Task 2: Existing Test Maintenance, Task 3: Submit Report) are MANDATORY. Do NOT skip any task.

AUTHENTICATION:
When executing any tests using the Skyramp MCP execute tool, use this authentication token: ${opts.authToken}
If the token is empty, pass an empty string for the token parameter.`
}

function buildServiceContext(services: WorkspaceServiceInfo[]): string {
  const blocks = services.map(svc => {
    const parts: string[] = [`<service name="${svc.serviceName}">`]
    if (svc.language) parts.push(`  <language>${svc.language}</language>`)
    if (svc.framework) parts.push(`  <framework>${svc.framework}</framework>`)
    if (svc.baseUrl) parts.push(`  <base_url>${svc.baseUrl}</base_url>`)
    if (svc.outputDir) parts.push(`  <output_dir>${svc.outputDir}</output_dir>`)
    parts.push('</service>')
    return parts.join('\n')
  })
  return `<services>\n${blocks.join('\n')}\n</services>`
}

interface RunAgentResult {
  success: boolean
  exitCode: number
}

/**
 * Run the agent with automatic retries on transient errors (e.g., "Connection stalled").
 */
export async function runAgentWithRetry(
  agentCmd: AgentCommand,
  prompt: string,
  config: ResolvedConfig,
  opts: {
    logFile?: string
    stdoutFile?: string
  } = {}
): Promise<RunAgentResult> {
  const maxRetries = config.testbotMaxRetries
  const retryDelay = config.testbotRetryDelay
  const timeoutMs = config.testbotTimeout * 60_000

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let stdout = ''
    let stderr = ''
    let exitCode: number

    try {
      const args = [...agentCmd.args, prompt]
      const result = await exec(agentCmd.command, args, {
        ignoreReturnCode: true,
        silent: !!opts.logFile,
        input: Buffer.from(''),
        timeout: timeoutMs,
      })
      exitCode = result.exitCode
      stdout = result.stdout
      stderr = result.stderr

      // Write log file if requested (debug artifact)
      if (opts.logFile) {
        fs.writeFileSync(opts.logFile, stdout + stderr)
      }

      if (exitCode === 0) {
        // Save stdout capture if requested (report fallback)
        if (opts.stdoutFile) {
          fs.writeFileSync(opts.stdoutFile, stdout)
        }
        return { success: true, exitCode: 0 }
      }
    } catch (err) {
      exitCode = 1
      stderr = String(err)
    }

    // Check for retryable transient errors
    const combined = stdout + stderr
    if (combined.includes('Connection stalled') || combined.includes('timed out')) {
      if (attempt < maxRetries) {
        core.warning(`Agent error (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}s...`)
        await sleep(retryDelay)
        continue
      }
      core.error(`Agent failed after ${maxRetries} attempts`)
    }

    return { success: false, exitCode }
  }

  return { success: false, exitCode: 1 }
}
