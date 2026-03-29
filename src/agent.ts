import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentCommand, Paths, ResolvedConfig, WorkspaceServiceInfo } from './types'
import type { AgentStrategy } from './types'
import { SKYRAMP_MCP_SERVER_NAME } from './types'
import { exec, sleep, withRetry, withGroup, debug, secondsToMilliseconds } from './utils'
import { readSummary, parseMetrics } from './report'
import { extractAgentLogSummary, pushAgentUsageEvent } from './telemetry'

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
  /** Raw stdout+stderr from the agent process, used for retryable-error detection. */
  output: string
}

/**
 * Run the agent CLI once (no retries). Returns the exit code and captured output.
 */
async function runAgentOnce(
  agentCmd: AgentCommand,
  prompt: string,
  config: ResolvedConfig,
  opts: { logFile?: string; stdoutFile?: string } = {}
): Promise<RunAgentResult> {
  const timeoutMs = secondsToMilliseconds(config.testbotTimeout * 60)
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
    } catch (err) {
      exitCode = 1
      stderr = String(err)
    } finally {
      if (logStream) {
        logStream.end()
        await new Promise<void>(resolve => logStream!.on('finish', resolve))
      }
    }
    if (exitCode === 0 && opts.stdoutFile) {
      fs.writeFileSync(opts.stdoutFile, stdout)
    }
  } catch (err) {
    exitCode = 1
    stderr = String(err)
  }

  return { success: exitCode === 0, exitCode, output: stdout + stderr }
}

/** Check whether an agent failure contains a transient error worth retrying. */
function isTransientAgentError(output: string): boolean {
  return output.includes('Connection stalled') || output.includes('timed out')
}

export interface ExecuteAgentResult {
  result: { success: boolean; exitCode: number }
  summary: string
  commitMessage?: string
  report?: ReturnType<typeof readSummary>['report']
  renderOptions: ReturnType<typeof readSummary>['renderOptions']
}

/**
 * Execute the agent with a unified retry loop.
 *
 * Retries on two conditions (up to `config.testbotMaxRetries` attempts):
 *   1. Agent CLI crashes with a transient error (e.g. "Connection stalled", "timed out")
 *   2. Agent CLI exits cleanly but produces no report (e.g. API stream interruption, SKYR-3688)
 */
export async function executeAgent(opts: {
  agentCmd: AgentCommand
  agentLabel: string
  config: ResolvedConfig
  paths: Paths
  workingDir: string
  authToken: string
  prTitle: string
  prBody: string
  baseBranch: string
  userPrompt?: string
  prNumber?: number
  licensePath: string
}): Promise<ExecuteAgentResult> {
  const {
    agentCmd, agentLabel, config, paths, workingDir, authToken,
    prTitle, prBody, baseBranch, userPrompt, prNumber, licensePath,
  } = opts

  const maxRetries = config.testbotMaxRetries
  const retryDelay = config.testbotRetryDelay

  let lastResult: RunAgentResult = { success: false, exitCode: 1, output: '' }
  let lastSummary = ''
  let lastCommitMessage: string | undefined
  let lastReport: ReturnType<typeof readSummary>['report']
  let lastRenderOptions: ReturnType<typeof readSummary>['renderOptions'] = {}

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Clean up stale output files so previous attempts don't carry over
    for (const f of [paths.summaryPath, paths.agentStdoutPath, paths.combinedResultPath]) {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true })
    }

    // ── Run agent ──────────────────────────────────────────────────────
    lastResult = await withGroup(`Running Skyramp Testbot (attempt ${attempt}/${maxRetries})`, async () => {
      const localDiffPath = path.join(workingDir, '.skyramp_git_diff')
      fs.copyFileSync(paths.gitDiffPath, localDiffPath)

      process.env.SKYRAMP_AUTH_TOKEN = authToken

      const prompt = buildPrompt({
        prTitle, prBody, baseBranch,
        testDirectory: config.testDirectory,
        summaryPath: paths.summaryPath,
        hasAuthToken: !!authToken,
        repositoryPath: workingDir,
        services: config.services,
        userPrompt, prNumber,
        maxRecommendations: config.maxRecommendations,
        maxGenerate: config.maxGenerate,
      })

      const useNdjsonLog = agentCmd.args.includes('stream-json')
      debug(`Agent command: ${agentCmd.command} ${agentCmd.args.join(' ')}`)
      debug(`Agent log file: ${useNdjsonLog ? paths.agentLogPath : 'none (streaming to console)'}`)
      debug(`Prompt length: ${prompt.length} chars`)

      const agentResult = await runAgentOnce(agentCmd, prompt, config, {
        logFile: useNdjsonLog ? paths.agentLogPath : undefined,
        stdoutFile: useNdjsonLog ? undefined : paths.agentStdoutPath,
      })

      fs.rmSync(localDiffPath, { force: true })

      if (!agentResult.success) {
        core.error(`Skyramp Testbot failed with exit code ${agentResult.exitCode}`)
      } else {
        core.notice('Skyramp Testbot completed successfully')
      }

      // Extract model and token usage from NDJSON logs
      if (useNdjsonLog && fs.existsSync(paths.agentLogPath)) {
        const { model, usage } = await extractAgentLogSummary(paths.agentLogPath)
        if (model) core.notice(`${agentLabel} auto-selected model: ${model}`)
        if (usage) {
          debug(`Agent usage: ${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.cacheReadInputTokens} cache-read, ${usage.cacheCreationInputTokens} cache-create, ${usage.numTurns} turns, $${usage.totalCostUsd.toFixed(4)}`)
          pushAgentUsageEvent(usage, model ?? 'unknown', licensePath).catch(err => debug(`Telemetry push failed: ${err}`))
        }
      }

      return agentResult
    })

    // ── Read summary ───────────────────────────────────────────────────
    const summaryResult = readSummary(paths, config.reportCollapsed, userPrompt || undefined, config.autoCommit)
    parseMetrics(summaryResult.summary)
    lastSummary = summaryResult.summary
    lastCommitMessage = summaryResult.commitMessage
    lastReport = summaryResult.report
    lastRenderOptions = summaryResult.renderOptions

    // ── Decide whether to retry ────────────────────────────────────────
    const emptySummary = !lastSummary || lastSummary.trim() === '' || lastSummary.trim() === 'No summary available'

    // Condition 1: agent crashed with a transient error
    const transientCrash = !lastResult.success && isTransientAgentError(lastResult.output)
    // Condition 2: agent exited cleanly but produced no report (SKYR-3688)
    const emptyResult = lastResult.success && emptySummary

    if ((transientCrash || emptyResult) && attempt < maxRetries) {
      const reason = transientCrash ? 'transient error' : 'no report produced'
      core.warning(`Agent ${reason} (attempt ${attempt}/${maxRetries}). Retrying in ${retryDelay}s...`)
      await sleep(retryDelay)
      continue
    }

    if (transientCrash || emptyResult) {
      core.error(`Agent failed after ${maxRetries} attempts (last: ${transientCrash ? 'transient error' : 'no report'})`)
    }

    break
  }

  return {
    result: { success: lastResult.success, exitCode: lastResult.exitCode },
    summary: lastSummary,
    commitMessage: lastCommitMessage,
    report: lastReport,
    renderOptions: lastRenderOptions,
  }
}
