import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as path from 'path'
import { DefaultArtifactClient } from '@actions/artifact'
import type { Paths } from './types'
import { getInputs, detectAgentType } from './inputs'
import { createAgent } from './agents'
import { loadConfig } from './config'
import { checkSelfTrigger } from './self-trigger'
import { setGitHubToken, postInitialProgress, updateProgress, appendReportToProgress, postStandaloneComment, postValidationError } from './progress'
import { installMcp, configureMcp } from './mcp'
import { installAgentCli, initializeAgent, buildAgentCommand, buildPrompt, runAgentWithRetry } from './agent'
import { startServices, exportServiceBaseUrlEnvVars, generateAuthToken } from './services'
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

  // Provide the GitHub token to the progress module for Octokit calls.
  // node24 actions don't inherit GITHUB_TOKEN as an env var; read it from the action input instead.
  const githubToken = core.getInput('github_token')
  setGitHubToken(githubToken)

  // Determine PR context based on event type
  const isCommentTrigger = github.context.eventName === 'issue_comment'
  const isDispatchTrigger = github.context.eventName === 'workflow_dispatch'
  let prNumber: number | undefined
  let prTitle = ''
  let prBody = ''
  let baseBranch = ''
  // User prompt from @skyramp-testbot comment
  let userPrompt = ''
  // Check run ID for workflow_dispatch — used to report status on the PR
  let checkRunId: number | undefined
  let prHeadSha: string | undefined
  let prHeadRef: string | undefined

  if (isDispatchTrigger) {
    // workflow_dispatch: PR number and selected tests come from inputs
    const inputPrNumber = github.context.payload.inputs?.pr_number
    if (inputPrNumber) {
      prNumber = parseInt(inputPrNumber, 10)
      try {
        const octokit = github.getOctokit(githubToken)
        const { data: pr } = await octokit.rest.pulls.get({
          ...github.context.repo,
          pull_number: prNumber,
        })
        prTitle = pr.title
        prBody = pr.body ?? ''
        baseBranch = pr.base.ref
        prHeadSha = pr.head.sha
        prHeadRef = pr.head.ref
        core.notice(`Retrigger via workflow_dispatch for PR #${prNumber}`)

        // Create a check run on the PR head SHA so the status appears on the PR
        if (prHeadSha) {
          try {
            const { data: check } = await octokit.rest.checks.create({
              ...github.context.repo,
              name: 'Skyramp Testbot (retrigger)',
              head_sha: prHeadSha,
              status: 'in_progress',
              started_at: new Date().toISOString(),
              details_url: `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`,
            })
            checkRunId = check.id
            core.info(`Created check run ${checkRunId} on PR head SHA ${prHeadSha}`)
          } catch (checkErr) {
            core.warning(`Failed to create check run on PR: ${checkErr}`)
          }
        }
      } catch (err) {
        core.warning(`Failed to fetch PR details for workflow_dispatch event: ${err}`)
      }
    }
  } else if (isCommentTrigger) {
    const commentBody = github.context.payload.comment?.body as string | undefined
    if (commentBody?.includes('@skyramp-testbot')) {
      // Extract prompt after @skyramp-testbot
      const match = commentBody.match(/@skyramp-testbot\s+([\s\S]*)/i)
      if (match) {
        userPrompt = match[1].trim()
      }
      prNumber = github.context.payload.issue?.number
      if (prNumber) {
        try {
          const octokit = github.getOctokit(githubToken)
          const { data: pr } = await octokit.rest.pulls.get({
            ...github.context.repo,
            pull_number: prNumber,
          })
          prTitle = pr.title
          prBody = pr.body ?? ''
          baseBranch = pr.base.ref
          prHeadSha = pr.head.sha
        prHeadRef = pr.head.ref
          core.notice(`Triggered via @skyramp-testbot comment on PR #${prNumber}`)

          // Create a check run on the PR head SHA so the status appears on the PR
          if (prHeadSha) {
            try {
              const { data: check } = await octokit.rest.checks.create({
                ...github.context.repo,
                name: 'Skyramp Testbot (@skyramp-testbot)',
                head_sha: prHeadSha,
                status: 'in_progress',
                started_at: new Date().toISOString(),
                details_url: `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`,
              })
              checkRunId = check.id
              core.info(`Created check run ${checkRunId} on PR head SHA ${prHeadSha}`)
            } catch (checkErr) {
              core.warning(`Failed to create check run on PR: ${checkErr}`)
            }
          }
        } catch (err) {
          core.warning(`Failed to fetch PR details for issue_comment event: ${err}`)
        }
      }
    } else {
      core.info('Comment does not mention @skyramp-testbot, skipping.')
      return
    }
  } else {
    prNumber = github.context.payload.pull_request?.number as number | undefined
    prTitle = github.context.payload.pull_request?.title ?? ''
    prBody = github.context.payload.pull_request?.body ?? ''
    baseBranch = github.context.payload.pull_request?.base?.ref ?? ''
  }

  // userPrompt requires prNumber — the skip-analysis flow needs PR comment context
  if (userPrompt && !prNumber) {
    core.setFailed('userPrompt requires a PR context (prNumber). This should not happen for issue_comment events.')
    return
  }

  let agent: ReturnType<typeof createAgent>
  try {
    const agentType = detectAgentType(inputs)
    agent = createAgent(agentType)
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
    targetSetupCommand: config.targetSetupCommand,
    authTokenCommand: config.authTokenCommand ? '<set>' : '<empty>',
    skyrampExecutorVersion: config.skyrampExecutorVersion,
    skyrampMcpVersion: config.skyrampMcpVersion,
    skyrampMcpSource: config.skyrampMcpSource,
    skipTargetSetup: config.skipTargetSetup,
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

  // ── 5. Checkout PR branch for non-pull_request events ──────────────
  // issue_comment and workflow_dispatch checkout the default branch (main),
  // but we need to be on the PR head branch for correct diff and push.
  if (prHeadRef && github.context.eventName !== 'pull_request') {
    await exec('git', ['checkout', prHeadRef], { cwd: workingDir })
    core.info(`Checked out PR head branch: ${prHeadRef}`)
  }

  // ── 6. Generate git diff ────────────────────────────────────────────
  await generateGitDiff(paths.gitDiffPath, workingDir, baseBranch || undefined)

  // ── 6. Post initial progress comment ────────────────────────────────
  let progressCommentId: number | null = null
  if (config.postPrComment && prNumber) {
    progressCommentId = await postInitialProgress(prNumber, isCommentTrigger)
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
  const mcp = await installMcp(config, inputs, tempDir)
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

  // ── 11. Install Playwright browsers ───────────────────────────────
  await withGroup('Installing Playwright browsers', async () => {
    await withRetry(
      async () => {
        // Install globally so we don't create/modify a node_modules/ at the repo root.
        // When MCP source is 'github', the MCP server's dependencies live under
        // <repo>/node_modules/@skyramp/mcp/node_modules/. A bare `npm install` here
        // would see those 600+ packages as extraneous and remove them, breaking MCP.
        await exec('npm', ['install', '-g', '@playwright/test'])
        await exec('playwright', ['install', '--with-deps', 'chromium'])
        core.notice('Playwright chromium browser installed successfully')
      },
      { retries: 2, delay: 5, label: 'Playwright install' },
    )
  })

  // ── 12. Install & configure agent CLI ──────────────────────────────
  agent.exportEnv(inputs, config)

  await installAgentCli(agent)
  await configureMcp(agent, mcp.command, mcp.args, mcp.licensePath, config.testExecutionTimeout)
  await initializeAgent(agent)
  const agentCmd = buildAgentCommand(agent, config.enableDebug)

  // ── 13. Start services & generate auth token ───────────────────────
  try {
    const setupOutput = await startServices(config, workingDir)
    if (setupOutput) {
      if (config.services.length === 0) {
        // No workspace.yml — create service entries from setup output
        if (setupOutput.services) {
          for (const [name, details] of Object.entries(setupOutput.services)) {
            if (details.baseUrl) {
              debug(`Created service '${name}' from setup output: baseUrl=${details.baseUrl}`)
              config.services.push({ serviceName: name, baseUrl: details.baseUrl })
            }
          }
        } else if (setupOutput.baseUrl) {
          debug(`Created default service from setup output: baseUrl=${setupOutput.baseUrl}`)
          config.services.push({ serviceName: 'default', baseUrl: setupOutput.baseUrl })
        }
      } else {
        // Override existing service baseUrls from setup output
        for (const svc of config.services) {
          const svcOverride = setupOutput.services?.[svc.serviceName]
          const newBaseUrl = svcOverride?.baseUrl ?? setupOutput.baseUrl
          if (newBaseUrl && svc.baseUrl) {
            debug(`Overrode service '${svc.serviceName}' baseUrl: ${svc.baseUrl} -> ${newBaseUrl}`)
            svc.baseUrl = newBaseUrl
          }
        }
      }
    }
  } catch (err) {
    const errMsg = (err as Error).message
    if (prNumber) {
      await postStandaloneComment(prNumber, [
        `### :x: Skyramp Testbot — Service Startup Failed`,
        '',
        `**Error:** ${errMsg}`,
        '',
        '**How to fix:**',
        `- Check that your \`target_setup_command\` is correct: \`${config.targetSetupCommand}\``,
        '- Verify the service names in your `docker-compose.yml` (or equivalent) match the command',
        '- Ensure all referenced Docker images exist and can be pulled',
        '- You can test locally by running the command manually',
        '',
        'This setting can be configured in your workflow file (`target_setup_command` input) or in `.skyramp/workspace.yml`.',
      ].join('\n'))
    }
    throw err
  }

  // ── 13b. Export base URL env vars for test execution ─────────────────
  exportServiceBaseUrlEnvVars(config.services)

  // Dynamic token (from auth_token_command) takes priority, then fall back
  // to the static SKYRAMP_TEST_TOKEN env var set at the workflow level.
  const dynamicToken = await generateAuthToken(config, workingDir)
  const authToken = dynamicToken || process.env.SKYRAMP_TEST_TOKEN || ''

  const tokenSource = dynamicToken ? 'auth_token_command' : process.env.SKYRAMP_TEST_TOKEN ? 'SKYRAMP_TEST_TOKEN env var' : 'none'
  debug(`Auth token source: ${tokenSource}, length: ${authToken.length}`)

  // ── 14. Update progress (step 2: analyzing changes) ────────────────
  if (progressCommentId) {
    await updateProgress(progressCommentId, 2, isCommentTrigger)
  }

  // ── 15. Run Skyramp Testbot ─────────────────────────────────────────
  const result = await withGroup('Running Skyramp Testbot', async () => {
    // Copy git diff to working directory for consistent agent access
    const localDiffPath = path.join(workingDir, '.skyramp_git_diff')
    fs.copyFileSync(paths.gitDiffPath, localDiffPath)

    const prompt = buildPrompt({
      prTitle,
      prBody,
      baseBranch,
      testDirectory: config.testDirectory,
      summaryPath: paths.summaryPath,
      authToken,
      repositoryPath: workingDir,
      services: config.services,
      userPrompt,
      prNumber,
    })

    const useDebugLog = agent.supportsNdjsonLog && config.enableDebug

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

    // Log agent's auto-selected model if available in NDJSON logs
    if (useDebugLog && fs.existsSync(paths.agentLogPath)) {
      const logContent = fs.readFileSync(paths.agentLogPath, 'utf-8')
      const modelMatch = logContent.match(/"model"\s*:\s*"([^"]+)"/)
      if (modelMatch) {
        core.notice(`${agent.label} auto-selected model: ${modelMatch[1]}`)
      }
    }

    return agentResult
  })

  // ── 17. Read summary & parse metrics ───────────────────────────────
  const { summary, commitMessage: reportCommitMessage } = readSummary(paths, config.reportCollapsed, userPrompt || undefined)
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

  // ── 18. Upload artifacts ─────────────────────────────────────────
  try {
    const artifact = new DefaultArtifactClient()

    // Upload raw summary + agent stdout so we can diagnose report-format issues
    const reportFiles = [paths.summaryPath, paths.combinedResultPath, paths.agentStdoutPath]
      .filter(f => fs.existsSync(f))
    if (reportFiles.length > 0) {
      await artifact.uploadArtifact('skyramp-testbot-report', reportFiles, tempDir)
    }

    // Upload agent logs when debug is enabled
    if (config.enableDebug && fs.existsSync(paths.agentLogPath)) {
      await artifact.uploadArtifact('skyramp-agent-logs', [paths.agentLogPath], tempDir)
    }
  } catch (err) {
    core.warning(`Failed to upload artifacts: ${err}`)
  }

  // ── 19. Post final PR comment ──────────────────────────────────────
  if (config.postPrComment && prNumber) {
    await withGroup('Posting final PR comment', async () => {
      let posted = false
      if (progressCommentId) {
        posted = await appendReportToProgress(progressCommentId, paths.combinedResultPath, isCommentTrigger)
        if (posted) {
          core.notice('Progress comment updated with final report')
        } else {
          core.warning('Failed to update progress comment, falling back to standalone comment')
          posted = await postStandaloneComment(prNumber, paths.combinedResultPath, true)
        }
      } else {
        core.notice('Creating standalone PR comment (no progress comment to update)')
        posted = await postStandaloneComment(prNumber, paths.combinedResultPath, true)
      }
      if (!posted) {
        core.error('Failed to post testbot report to PR — report is available in action outputs only')
      }
    })
  }

  // ── 20. Auto-commit test changes ───────────────────────────────────
  let commitSha = ''
  if (config.autoCommit) {
    config.prHeadRef = prHeadRef
    await configureGitIdentity(botName, botEmail)
    commitSha = await autoCommit(config)
  }

  // If the testbot agent failed AND it produced file changes, fail the action.
  // When there are no changes to commit (e.g. setup PR, no testable code),
  // treat it as a graceful no-op so the workflow check stays green.
  const actionFailed = !result.success && !!commitSha
  if (!result.success) {
    if (commitSha) {
      core.setFailed(`Skyramp Testbot failed with exit code ${result.exitCode}`)
    } else {
      core.warning(`Skyramp Testbot exited with code ${result.exitCode} but produced no file changes — treating as successful`)
    }
  }

  // Complete the check run on the PR (for workflow_dispatch retriggers)
  if (checkRunId) {
    try {
      const octokit = github.getOctokit(githubToken)
      await octokit.rest.checks.update({
        ...github.context.repo,
        check_run_id: checkRunId,
        status: 'completed',
        conclusion: actionFailed ? 'failure' : 'success',
        completed_at: new Date().toISOString(),
      })
    } catch (err) {
      core.warning(`Failed to update check run: ${err}`)
    }
  }
}

run().catch(async (err) => {
  // Complete the check run as failed on unexpected errors
  // (checkRunId and prHeadSha are in the outer scope but may not be set)
  core.setFailed(err instanceof Error ? err.message : String(err))
})
