import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as path from 'path'
import type { Paths } from './types'
import { getInputs, detectAgentType } from './inputs'
import { loadConfig } from './config'
import { checkSelfTrigger } from './self-trigger'
import { setGitHubToken, postInitialProgress, updateProgress, appendReportToProgress, postStandaloneComment, postValidationError } from './progress'
import { installMcp, configureMcp } from './mcp'
import { installAgentCli, initializeAgent, buildAgentCommand, buildPrompt, runAgentWithRetry } from './agent'
import { startServices, generateAuthToken } from './services'
import { generateGitDiff, configureGitIdentity, autoCommit } from './git'
import { readSummary, parseMetrics } from './report'
import { exec, withRetry, withGroup, setDebugEnabled, debug } from './utils'

async function run(): Promise<void> {
  // ── 1. Self-trigger check ───────────────────────────────────────────
  const { skip, botName, botEmail } = await checkSelfTrigger()
  core.setOutput('skipped_self_trigger', String(skip))
  if (skip) return

  // ── 2. Parse & validate inputs ──────────────────────────────────────
  const inputs = getInputs()
  const prNumber = github.context.payload.pull_request?.number as number | undefined

  // Provide the GitHub token to the progress module for Octokit calls.
  // node24 actions don't inherit GITHUB_TOKEN as an env var; read it from the action input instead.
  const githubToken = core.getInput('github_token')
  setGitHubToken(githubToken)

  let agentType: ReturnType<typeof detectAgentType>
  try {
    agentType = detectAgentType(inputs)
  } catch (err) {
    await postValidationError(prNumber, (err as Error).message)
    throw err
  }

  if (!inputs.skyrampLicenseFile) {
    await postValidationError(prNumber, 'skyramp_license_file is required but not provided')
    throw new Error('skyramp_license_file is required but not provided')
  }

  // ── 3. Load config (.skyramp/workspace.yml merged with inputs) ──────
  const config = await loadConfig(inputs)
  setDebugEnabled(config.enableDebug)

  debug(`Resolved config: ${JSON.stringify({
    testDirectory: config.testDirectory,
    serviceStartupCommand: config.serviceStartupCommand,
    authTokenCommand: config.authTokenCommand ? '<set>' : '<empty>',
    skyrampExecutorVersion: config.skyrampExecutorVersion,
    skyrampMcpVersion: config.skyrampMcpVersion,
    skyrampMcpSource: config.skyrampMcpSource,
    skipServiceStartup: config.skipServiceStartup,
    autoCommit: config.autoCommit,
    commitMessage: config.commitMessage,
    postPrComment: config.postPrComment,
    testbotMaxRetries: config.testbotMaxRetries,
    testbotRetryDelay: config.testbotRetryDelay,
    testbotTimeout: config.testbotTimeout,
    enableDebug: config.enableDebug,
  }, null, 2)}`)

  // Validate MCP source config
  if (config.skyrampMcpSource !== 'npm' && config.skyrampMcpSource !== 'github') {
    await postValidationError(prNumber, `skyramp_mcp_source must be 'npm' or 'github', got '${config.skyrampMcpSource}'`)
    throw new Error(`Invalid skyramp_mcp_source: ${config.skyrampMcpSource}`)
  }
  if (config.skyrampMcpSource === 'github' && !inputs.skyrampMcpGithubToken) {
    await postValidationError(prNumber, "skyramp_mcp_github_token is required when skyramp_mcp_source is 'github'")
    throw new Error('skyramp_mcp_github_token required for github source')
  }

  // ── 4. Setup paths ─────────────────────────────────────────────────
  const tempDir = path.join(process.env.RUNNER_TEMP ?? '/tmp', 'skyramp')
  fs.mkdirSync(tempDir, { recursive: true })

  const paths: Paths = {
    tempDir,
    licensePath: path.join(tempDir, 'skyramp_license.lic'),
    gitDiffPath: path.join(tempDir, 'git_diff'),
    summaryPath: path.join(tempDir, 'testbot-result.txt'),
    agentLogPath: path.join(tempDir, 'agent-log.ndjson'),
    agentStdoutPath: path.join(tempDir, 'agent-stdout.txt'),
    combinedResultPath: path.join(tempDir, 'combined-result.txt'),
  }

  const workingDir = path.resolve(inputs.workingDirectory)

  debug(`Paths: tempDir=${tempDir}, workingDir=${workingDir}`)
  debug(`PR #${prNumber ?? 'N/A'}, event=${github.context.eventName}`)

  // ── 5. Generate git diff ────────────────────────────────────────────
  await generateGitDiff(paths.gitDiffPath, workingDir)

  // ── 6. Post initial progress comment ────────────────────────────────
  let progressCommentId: number | null = null
  if (config.postPrComment && prNumber) {
    progressCommentId = await postInitialProgress(prNumber)
  }

  // ── 7. Inject & validate license ───────────────────────────────────
  await withGroup('Configuring Skyramp license', async () => {
    fs.writeFileSync(paths.licensePath, inputs.skyrampLicenseFile, { mode: 0o600 })
    if (!fs.statSync(paths.licensePath).size) {
      const msg = 'License file is empty or could not be created'
      if (prNumber) {
        await postStandaloneComment(
          prNumber,
          `## :warning: Skyramp Testbot - License Error\n\n**Error:** ${msg}\n\nPlease ensure your \`skyramp_license_file\` secret is configured correctly.`
        )
      }
      throw new Error(msg)
    }
    core.notice('License file created successfully')
  })

  // ── 8. Install Skyramp MCP ─────────────────────────────────────────
  const mcp = await installMcp(config, inputs, workingDir)
  mcp.licensePath = paths.licensePath

  // ── 9. Validate license via MCP/Skyramp ────────────────────────────
  await withGroup('Validating Skyramp license', async () => {
    try {
      await exec('node', ['-e', `
        const { SkyrampClient } = require('@skyramp/skyramp');
        const client = new SkyrampClient();
        client.login().then(r => { console.log(r); }).catch(e => { console.error(e.message); process.exit(1); });
      `], {
        cwd: workingDir,
        env: { LICENSE_FILE: paths.licensePath, CI: 'true' },
      })
      core.notice('License validation successful')
    } catch {
      const msg = 'Skyramp license validation failed'
      if (prNumber) {
        await postStandaloneComment(
          prNumber,
          `## :warning: Skyramp Testbot - License Validation Failed\n\n**Error:** ${msg}\n\nYour Skyramp license may be expired or invalid. Please generate a new license file by running \`skyramp get-license-file\`.`
        )
      }
      throw new Error(msg)
    }
  })

  // ── 10. Pull Skyramp Executor Docker image ─────────────────────────
  await withGroup('Pulling Skyramp Executor Docker image', async () => {
    await withRetry(
      async () => {
        const { exitCode } = await exec(
          'docker', ['pull', `skyramp/executor:${config.skyrampExecutorVersion}`, '--platform', 'linux/amd64'],
          { ignoreReturnCode: true },
        )
        if (exitCode !== 0) throw new Error('docker pull failed')
      },
      { retries: 3, delay: 5, label: 'Docker image pull' },
    )
    core.notice('Successfully pulled Skyramp Executor')
  })

  // ── 11. Install & configure agent CLI ──────────────────────────────
  // Ensure agent API keys are in the process environment for CLI auth
  if (agentType === 'cursor' && inputs.cursorApiKey) {
    core.exportVariable('CURSOR_API_KEY', inputs.cursorApiKey)
  } else if (agentType === 'copilot' && inputs.copilotApiKey) {
    core.exportVariable('GH_TOKEN', inputs.copilotApiKey)
  }

  await installAgentCli(agentType)
  await configureMcp(agentType, mcp.command, mcp.args, mcp.licensePath, config.testExecutionTimeout)
  await initializeAgent(agentType, config.enableDebug)
  const agentCmd = buildAgentCommand(agentType, config.enableDebug)

  // ── 12. Start services & generate auth token ───────────────────────
  await startServices(config, workingDir)
  // Dynamic token (from auth_token_command) takes priority, then fall back
  // to the static SKYRAMP_TEST_TOKEN env var set at the workflow level.
  const dynamicToken = await generateAuthToken(config, workingDir)
  const authToken = dynamicToken || process.env.SKYRAMP_TEST_TOKEN || ''

  const tokenSource = dynamicToken ? 'auth_token_command' : process.env.SKYRAMP_TEST_TOKEN ? 'SKYRAMP_TEST_TOKEN env var' : 'none'
  debug(`Auth token source: ${tokenSource}, length: ${authToken.length}`)

  // ── 13. Update progress (step 2: analyzing changes) ────────────────
  if (progressCommentId) {
    await updateProgress(progressCommentId, 2)
  }

  // ── 14. Run Skyramp Testbot ────────────────────────────────────────
  const result = await withGroup('Running Skyramp Testbot', async () => {
    // Copy git diff to working directory for consistent agent access
    const localDiffPath = path.join(workingDir, '.skyramp_git_diff')
    fs.copyFileSync(paths.gitDiffPath, localDiffPath)

    const prompt = buildPrompt({
      prTitle: github.context.payload.pull_request?.title ?? '',
      prBody: github.context.payload.pull_request?.body ?? '',
      testDirectory: config.testDirectory,
      summaryPath: paths.summaryPath,
      authToken,
      services: config.services,
    })

    const useDebugLog = agentType === 'cursor' && config.enableDebug

    debug(`Agent command: ${agentCmd.command} ${agentCmd.args.join(' ')}`)
    debug(`Agent log file: ${useDebugLog ? paths.agentLogPath : 'none (streaming to console)'}`)
    debug(`Prompt length: ${prompt.length} chars`)

    const agentResult = await runAgentWithRetry(agentCmd, prompt, config, {
      logFile: useDebugLog ? paths.agentLogPath : undefined,
      stdoutFile: useDebugLog ? undefined : paths.agentStdoutPath,
    })

    // Clean up temp diff file
    fs.rmSync(localDiffPath, { force: true })

    if (!agentResult.success) {
      core.error(`Skyramp Testbot failed with exit code ${agentResult.exitCode}`)
      // Don't throw — continue to report/comment phase so partial results are posted
    } else {
      core.notice('Skyramp Testbot completed successfully')
    }

    // Log Cursor's auto-selected model if available
    if (useDebugLog && fs.existsSync(paths.agentLogPath)) {
      const logContent = fs.readFileSync(paths.agentLogPath, 'utf-8')
      const modelMatch = logContent.match(/"model"\s*:\s*"([^"]+)"/)
      if (modelMatch) {
        core.notice(`Cursor auto-selected model: ${modelMatch[1]}`)
      }
    }

    return agentResult
  })

  // ── 15. Read summary & parse metrics ───────────────────────────────
  const { summary, commitMessage: reportCommitMessage } = readSummary(paths)
  parseMetrics(summary)

  // Use agent-provided commit message if available (keeps user input as fallback)
  if (reportCommitMessage) {
    // Sanitize: collapse newlines/control chars to spaces, trim, enforce max length
    let sanitized = reportCommitMessage.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E]/g, '').trim()
    // Avoid double-prefixing if the agent already included the prefix
    if (sanitized.toLowerCase().startsWith('skyramp testbot:')) {
      sanitized = sanitized.slice('skyramp testbot:'.length).trim()
    }
    if (sanitized) {
      config.commitMessage = `Skyramp Testbot: ${sanitized.slice(0, 72)}`
      debug(`Using agent-provided commit message: ${config.commitMessage}`)
    }
  }

  debug(`Summary length: ${summary.length} chars`)
  debug(`Summary file exists: ${fs.existsSync(paths.summaryPath)}`)
  debug(`Agent log file exists: ${fs.existsSync(paths.agentLogPath)}`)
  debug(`Agent stdout file exists: ${fs.existsSync(paths.agentStdoutPath)}`)
  debug(`Combined result file exists: ${fs.existsSync(paths.combinedResultPath)}`)

  // ── 16. Upload agent logs (debug only) ─────────────────────────────
  if (config.enableDebug && fs.existsSync(paths.agentLogPath)) {
    try {
      const { DefaultArtifactClient } = await import('@actions/artifact')
      const artifact = new DefaultArtifactClient()
      await artifact.uploadArtifact('skyramp-agent-logs', [paths.agentLogPath], tempDir, {
        retentionDays: 1,
      })
    } catch (err) {
      core.warning(`Failed to upload agent logs artifact: ${err}`)
    }
  }

  // ── 17. Post final PR comment ──────────────────────────────────────
  if (config.postPrComment && prNumber) {
    await withGroup('Posting final PR comment', async () => {
      if (progressCommentId) {
        const appended = await appendReportToProgress(progressCommentId, paths.combinedResultPath)
        if (appended) {
          core.notice('Progress comment updated with final report')
        } else {
          core.notice('Creating standalone PR comment (failed to update progress comment)')
          await postStandaloneComment(prNumber, paths.combinedResultPath, true)
        }
      } else {
        core.notice('Creating standalone PR comment (no progress comment to update)')
        await postStandaloneComment(prNumber, paths.combinedResultPath, true)
      }
    })
  }

  // ── 18. Auto-commit test changes ───────────────────────────────────
  if (config.autoCommit) {
    await configureGitIdentity(botName, botEmail)
    await autoCommit(config)
  }

  // If the testbot failed, fail the action at the end (after posting results)
  if (!result.success) {
    core.setFailed(`Skyramp Testbot failed with exit code ${result.exitCode}`)
  }
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
