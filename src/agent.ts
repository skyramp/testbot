import * as core from '@actions/core'
import * as fs from 'fs'
import type { AgentCommand, ResolvedConfig, WorkspaceServiceInfo } from './types'
import type { AgentStrategy } from './types'
import { SKYRAMP_MCP_SERVER_NAME } from './types'
import { exec, sleep, withRetry, withGroup, secondsToMilliseconds } from './utils'

/**
 * Install the appropriate agent CLI.
 */
export async function installAgentCli(agent: AgentStrategy): Promise<void> {
  await withGroup(`Installing ${agent.label} CLI`, async () => {
    // Two failure modes:
    //   - Binary exists but broken → ignoreReturnCode prevents throw, we check exitCode
    //   - Binary missing entirely  → exec throws "unable to locate executable", caught below
    try {
      const { exitCode, stdout } = await exec(agent.binary, ['--version'], { silent: true, ignoreReturnCode: true })
      if (exitCode === 0 && stdout.trim()) {
        core.notice(`${agent.label} CLI already installed (version: ${stdout.trim()})`)
        return
      }
      core.info(`${agent.label} CLI not found (non-zero exit or empty output), will install`)
    } catch (err) {
      core.info(`${agent.label} CLI not found, will install (${err instanceof Error ? err.message : String(err)})`)
    }

    await withRetry(
      async () => {
        await agent.install()
        core.notice(`${agent.label} CLI installed successfully`)
      },
      { retries: 3, delay: 5, label: `${agent.label} CLI install` },
    )
  })
}

/**
 * Initialize the agent (enable MCP server, wait for startup).
 */
export async function initializeAgent(agent: AgentStrategy): Promise<void> {
  await withGroup(`Initializing ${agent.label} agent`, async () => {
    await agent.initialize()
  })
}

/**
 * Build the agent command (binary + args) for execution.
 */
export function buildAgentCommand(agent: AgentStrategy, enableDebug: boolean): AgentCommand {
  return agent.buildCommand(enableDebug)
}

/**
 * Build the prompt string sent to the agent CLI.
 */
export function buildPrompt(opts: {
  prTitle: string
  prBody: string
  baseBranch?: string
  testDirectory: string
  summaryPath: string
  hasAuthToken: boolean
  repositoryPath: string
  services?: WorkspaceServiceInfo[]
  userPrompt?: string
  prNumber?: number
  maxRecommendations?: number
  maxGenerate?: number
}): string {
  const serviceContext = opts.services?.length
    ? buildServiceContext(opts.services)
    : ''

  const baseBranchParam = opts.baseBranch ? `&baseBranch=${encodeURIComponent(opts.baseBranch)}` : ''
  const userPromptParam = opts.userPrompt ? `&userPrompt=${encodeURIComponent(opts.userPrompt)}` : ''
  const prNumberParam = opts.prNumber ? `&prNumber=${opts.prNumber}` : ''
  const maxRecommendationsParam = opts.maxRecommendations != null && Number.isFinite(opts.maxRecommendations)
    ? `&maxRecommendations=${opts.maxRecommendations}`
    : ''
  const maxGenerateParam = opts.maxGenerate != null && Number.isFinite(opts.maxGenerate)
    ? `&maxGenerate=${opts.maxGenerate}`
    : ''

  return `You are the Skyramp TestBot. Read the Skyramp MCP resource at this URI:
${SKYRAMP_MCP_SERVER_NAME}://prompts/testbot?prTitle=${encodeURIComponent(opts.prTitle)}&prDescription=${encodeURIComponent(opts.prBody)}&diffFile=.skyramp_git_diff&testDirectory=${encodeURIComponent(opts.testDirectory)}&summaryOutputFile=${encodeURIComponent(opts.summaryPath)}&repositoryPath=${encodeURIComponent(opts.repositoryPath)}${baseBranchParam}${userPromptParam}${prNumberParam}${maxRecommendationsParam}${maxGenerateParam}
${serviceContext}
After reading the resource, follow EVERY task returned by it. ALL tasks (Task 1: Recommend New Tests, Task 2: Existing Test Maintenance, Task 3: Submit Report) are MANDATORY. Do NOT skip any task.

AUTHENTICATION:
When executing any tests using the Skyramp MCP execute tool, ${opts.hasAuthToken ? 'read the SKYRAMP_AUTH_TOKEN environment variable and pass its value to the tool\'s authToken parameter.' : 'pass an empty string for the token parameter.'}
CRITICAL — GENERATED TEST FILE INTEGRITY:
When the CLI generates a test file, preserve it exactly as-is. The ONLY permitted edit is fixing chaining — replacing literal/hardcoded IDs in path params and request bodies with dynamic response IDs. Do NOT add, remove, or modify auth headers, cookies, tokens, env vars, imports, assertions, or request bodies (other than chaining IDs).`
}

function buildServiceContext(services: WorkspaceServiceInfo[]): string {
  const blocks = services.map(svc => {
    const parts: string[] = [`<service name="${svc.serviceName}">`]
    if (svc.language) parts.push(`  <language>${svc.language}</language>`)
    if (svc.framework) parts.push(`  <framework>${svc.framework}</framework>`)
    if (svc.baseUrl) parts.push(`  <base_url>${svc.baseUrl}</base_url>`)
    if (svc.testDirectory) parts.push(`  <output_dir>${svc.testDirectory}</output_dir>`)
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
  const timeoutMs = secondsToMilliseconds(config.testbotTimeout * 60)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let stdout = ''
    let stderr = ''
    let exitCode: number

    // Open a streaming write to the log file so the progress tracker can tail it
    let logStream: fs.WriteStream | null = null
    if (opts.logFile) {
      logStream = fs.createWriteStream(opts.logFile, { flags: 'w' })
      logStream.on('error', (err) => {
        core.warning(`Log stream error: ${err.message}`)
        logStream = null
      })
    }

    try {
      const args = [...agentCmd.args, prompt]
      const result = await exec(agentCmd.command, args, {
        ignoreReturnCode: true,
        silent: !!opts.logFile,
        input: Buffer.from(''),
        timeout: timeoutMs,
        stdoutStream: logStream ?? undefined,
      })
      exitCode = result.exitCode
      stdout = result.stdout
      stderr = result.stderr

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
    } finally {
      if (logStream) {
        logStream.end()
        await new Promise<void>(resolve => logStream!.on('finish', resolve))
      }
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
