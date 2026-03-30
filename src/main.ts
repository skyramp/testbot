import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as path from 'path'
import { DefaultArtifactClient } from '@actions/artifact'
import type { Paths, StartServicesResult, TargetDeploymentDetails } from './types'
import { getInputs, detectAgentType } from './inputs'
import { createAgent } from './agents'
import { loadConfig } from './config'
import { checkSelfTrigger } from './self-trigger'
import { setGitHubToken, postInitialProgress, updateProgress, appendReportToProgress, postStandaloneComment, postValidationError, replaceProgressWithFailure, formatElapsed } from './progress'
import { createProgressTracker, advanceSteps, loadToolPhaseMap } from './progress-tracker'
import { createInitialSteps, ProgressStep } from './progress'
import { installMcp, configureMcp } from './mcp'
import { installAgentCli, initializeAgent, buildAgentCommand, executeAgent } from './agent'
import { startServices, exportServiceBaseUrlEnvVars, generateAuthToken } from './services'
import { StartupError, analyzeStartupError, formatStartupFailureComment, extractAppErrorLine } from './startup-errors'
import { runPreflightCheck } from './preflight'
import { generateGitDiff, configureGitIdentity, autoCommit } from './git'
import { renderReport } from './report'
import { exec, withRetry, withGroup, setDebugEnabled, debug } from './utils'

/**
 * Reply to an unauthorized @skyramp-testbot trigger with a PR comment.
 */
async function replyPermissionDenied(
  octokit: ReturnType<typeof github.getOctokit>,
  author: string,
): Promise<void> {
  const issueNumber = github.context.payload.issue?.number
  if (!issueNumber) return
  try {
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: issueNumber,
      body: `@${author} Sorry, only collaborators with **write** access can trigger Skyramp Testbot.`,
    })
  } catch (err) {
    core.info(`Failed to post permission-denied comment: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function run(): Promise<void> {
  // ── 1. Self-trigger check ───────────────────────────────────────────
  const { skip, botName, botEmail } = await checkSelfTrigger()
  core.setOutput('skipped_self_trigger', String(skip))
  if (skip) return

  // ── 2. Parse & validate inputs ──────────────────────────────────────
  const inputs = getInputs()

  // Provide the GitHub token to the progress module for Octokit calls.
  // node24 actions don't inherit GITHUB_TOKEN as an env var; read it from the action input instead.
  const githubToken = core.getInput('githubToken')
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
      // Verify the commenter has write access to prevent unauthorized triggers
      const commentAuthor = github.context.payload.comment?.user?.login as string | undefined
      if (commentAuthor) {
        const octokit = github.getOctokit(githubToken)
        try {
          const { data: permData } = await octokit.rest.repos.getCollaboratorPermissionLevel({
            ...github.context.repo,
            username: commentAuthor,
          })
          if (!['admin', 'write'].includes(permData.permission)) {
            core.info(`Ignoring @skyramp-testbot from ${commentAuthor} (permission: ${permData.permission})`)
            await replyPermissionDenied(octokit, commentAuthor)
            return
          }
        } catch (error) {
          core.info(
            `Ignoring @skyramp-testbot from ${commentAuthor} — permission check failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
          await replyPermissionDenied(octokit, commentAuthor)
          return
        }
      }

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
    await postValidationError(prNumber, 'skyrampLicenseFile is required but not provided')
    throw new Error('skyrampLicenseFile is required but not provided')
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
    await postValidationError(prNumber, `skyrampMcpSource must be 'npm' or 'github', got '${config.skyrampMcpSource}'`)
    throw new Error(`Invalid skyrampMcpSource: ${config.skyrampMcpSource}`)
  }
  if (config.skyrampMcpSource === 'github' && !inputs.skyrampMcpGithubToken) {
    await postValidationError(prNumber, "skyrampMcpGithubToken is required when skyrampMcpSource is 'github'")
    throw new Error('skyrampMcpGithubToken required for github source')
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
  const steps = createInitialSteps(isCommentTrigger)
  let progressCommentId: number | null = null
  if (config.postPrComment && prNumber) {
    advanceSteps(steps, ProgressStep.Setup, Date.now())
    progressCommentId = await postInitialProgress(prNumber, steps)
    if (progressCommentId) {
      core.saveState('progressCommentId', String(progressCommentId))
      core.saveState('steps', JSON.stringify(steps))
    }
  }

  // ── 7. Inject & validate license ───────────────────────────────────
  await withGroup('Configuring Skyramp license', async () => {
    fs.writeFileSync(paths.licensePath, inputs.skyrampLicenseFile, { mode: 0o600 })
    if (!fs.statSync(paths.licensePath).size) {
      const msg = 'License file is empty or could not be created'
      if (prNumber) {
        await postStandaloneComment(
          prNumber,
          `## :warning: Skyramp Testbot - License Error\n\n**Error:** ${msg}\n\nPlease ensure your \`skyrampLicenseFile\` secret is configured correctly.`
        )
      }
      throw new Error(msg)
    }
    core.notice('License file created successfully')
  })

  // ── 8. Install Skyramp MCP ─────────────────────────────────────────
  const mcp = await installMcp(config, inputs, tempDir)
  mcp.licensePath = paths.licensePath

  // Load tool-to-phase mapping from the MCP package (falls back to defaults)
  loadToolPhaseMap()

  // ── 9. Validate license via MCP/Skyramp ────────────────────────────
  await withGroup('Validating Skyramp license', async () => {
    try {
      await withRetry(
        () => exec('node', ['-e', `
          const { SkyrampClient } = require('@skyramp/skyramp');
          const client = new SkyrampClient();
          client.login().then(r => { console.log(r); }).catch(e => { console.error(e.message); process.exit(1); });
        `], {
          cwd: workingDir,
          env: { LICENSE_FILE: paths.licensePath, CI: 'true' },
        }),
        { retries: 3, delay: 5, label: 'License validation' },
      )
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
  let healthCheckPassed = true
  let healthCheckOutput = ''
  let deploymentDetails: TargetDeploymentDetails | null = null
  try {
    const startResult: StartServicesResult = await startServices(config, workingDir)
    healthCheckPassed = startResult.healthCheckPassed
    healthCheckOutput = startResult.healthCheckOutput
    deploymentDetails = startResult.details
    const setupOutput = startResult.details
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
    const stdout = err instanceof StartupError ? err.stdout : ''
    const stderr = err instanceof StartupError ? err.stderr : ''
    const analysis = analyzeStartupError(`${stderr}\n${stdout}`)
    const workflowUrl =
      `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}` +
      `/${process.env.GITHUB_REPOSITORY ?? github.context.repo.owner + '/' + github.context.repo.repo}` +
      `/actions/runs/${process.env.GITHUB_RUN_ID ?? github.context.runId}`
    const body = formatStartupFailureComment({
      command: config.targetSetupCommand,
      stdout,
      stderr,
      analysis,
      workflowUrl,
    })

    if (progressCommentId) {
      // Replace the stale "Analyzing PR…" spinner with the failure details in-place.
      await replaceProgressWithFailure(progressCommentId, body)
    } else if (prNumber) {
      await postStandaloneComment(prNumber, body)
    }
    throw err
  }

  // ── 13b. Export base URL env vars for test execution ─────────────────
  exportServiceBaseUrlEnvVars(config.services)

  // Dynamic token (from authTokenCommand) takes priority, then fall back
  // to the static SKYRAMP_TEST_TOKEN env var set at the workflow level.
  const dynamicToken = await generateAuthToken(config, workingDir)
  const authToken = dynamicToken || process.env.SKYRAMP_TEST_TOKEN || ''

  // Mask the token so it never appears in logs or uploaded artifacts
  if (authToken) {
    core.setSecret(authToken)
  }

  const tokenSource = dynamicToken ? 'authTokenCommand' : process.env.SKYRAMP_TEST_TOKEN ? 'SKYRAMP_TEST_TOKEN env var' : 'none'
  debug(`Auth token source: ${tokenSource}, length: ${authToken.length}`)

  // ── 14. SUT pre-flight validation ──────────────────────────────────
  // Runs whenever service baseUrls are available; skips internally when none
  // are configured or the diff has no extractable routes.  Guarding on
  // skipTargetSetup would wrongly disable the check for already-running
  // deployments, which is a common reason to set that flag.

  const workflowUrl =
    `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}` +
    `/${process.env.GITHUB_REPOSITORY ?? github.context.repo.owner + '/' + github.context.repo.repo}` +
    `/actions/runs/${process.env.GITHUB_RUN_ID ?? github.context.runId}`

  const formatPreflightFailureBody = (issueBlocks: string[]) => {
    // const tail = diagnostics ? extractCrashContext(diagnostics, 20) : ''
    // const outputSection = tail
    //   ? '\n<details>\n<summary>Debug logs for Pre-flight validation failure</summary>\n\n```\n' + tail + '\n```\n</details>\n'
    //   : ''
    return [
      '### Skyramp Testbot',
      '',
      ':warning: **Your service is returning errors**',
      '',
      'Testbot checked your endpoints before running tests and found issues.',
      '**Check if the code changes in this PR are causing the service to fail** — a newly introduced bug, missing dependency, or misconfiguration can prevent the service from starting or responding correctly.',
      '',
      issueBlocks.join('\n\n---\n\n'),
      '',
      `[View full workflow logs ↗](${workflowUrl})`,
      '',
      '_Fix the issue and push again, or re-run the workflow to retry._',
    ].join('\n')
  }

  const postPreflightFailure = async (body: string) => {
    if (progressCommentId) {
      await replaceProgressWithFailure(progressCommentId, body)
    } else if (prNumber) {
      await postStandaloneComment(prNumber, body)
    }
  }

  // Short-circuit: health check timed out → SUT is known-unready, no HTTP probes needed.
  if (!healthCheckPassed) {
    // Upload diagnostics captured during the health check as a downloadable artifact.
    if (healthCheckOutput) {
      const diagPath = path.join(tempDir, 'preflight-diagnostics.txt')
      fs.writeFileSync(diagPath, healthCheckOutput)
      try {
        const artifact = new DefaultArtifactClient()
        await artifact.uploadArtifact('skyramp-preflight-diagnostics', [diagPath], tempDir)
      } catch (err) {
        core.warning(`Failed to upload preflight diagnostics artifact: ${err}`)
      }
    }

    const appCrashAnalysis = analyzeStartupError(healthCheckOutput)
    const probeableServices = config.services.filter(svc => svc.baseUrl)
    let issueBlocks: string[]

    if (appCrashAnalysis.kind === 'APP_STARTUP_ERROR') {
      // An app crash takes down all services — one consolidated block is clearer than
      // repeating the same error for every service URL individually.
      const errorLine = extractAppErrorLine(healthCheckOutput)
      const affectedUrls = probeableServices.map(svc => svc.baseUrl!).join(', ')
      issueBlocks = [[
        `**Application crash detected:** Services (${affectedUrls}) failed to start due to a code error.`,
        errorLine ? `\n**Error:** \`${errorLine}\`` : '',
        '',
        '**Fix:** ' + appCrashAnalysis.fixes.join(' '),
      ].filter(Boolean).join('\n')]
    } else {
      issueBlocks = probeableServices.map(svc => [
        `**Service not reachable:** Service at ${svc.baseUrl!} did not respond before the health-check timeout. ` +
        `The service may still be starting, or the startup command may not have brought it up at all.`,
        '',
        '**Fix:** Check that `targetSetupCommand` actually starts this service and listens on the expected port. ' +
        'If the command is correct but the service is slow to start, increase `targetReadyCheckTimeout`. ' +
        'For a more reliable readiness signal, configure `targetReadyCheckCommand` to probe a specific health endpoint.',
      ].join('\n'))
    }

    // When an app crash is detected, show the traceback context rather than the
    // tail of the full diagnostics (which may be unrelated container logs).
    // const displayDiagnostics = appCrashAnalysis.kind === 'APP_STARTUP_ERROR'
    //   ? extractCrashContext(healthCheckOutput)
    //   : healthCheckOutput
    await postPreflightFailure(formatPreflightFailureBody(issueBlocks))
    throw new Error('SUT health check timed out — service did not become ready before the configured timeout')
  }

  {
    const diffContent = fs.existsSync(paths.gitDiffPath)
      ? fs.readFileSync(paths.gitDiffPath, 'utf8')
      : ''
    const preflight = await runPreflightCheck({
      diffContent,
      services: config.services,
      authToken,
      anthropicApiKey: inputs.anthropicApiKey,
      targetDeploymentDetails: deploymentDetails,
    })

    if (!preflight.skipped && !preflight.ready) {
      const kindLabel: Record<string, string> = {
        NOT_DEPLOYED: 'Service not reachable',
        STALE_IMAGE:  'Endpoint not found (404)',
        AUTH_FAILURE: 'Authentication failed',
        UNHEALTHY:    'Service unhealthy',
      }
      const issueBlocks = preflight.issues.map(i => {
        const label = kindLabel[i.kind] ?? i.kind
        return [`**${label}:** ${i.message}`, '', `**Fix:** ${i.recommendation}`].join('\n')
      })

      // Collect service diagnostics (docker logs, etc.) to help debug the failure
      let preflightDiagnostics = ''
      if (config.targetReadyCheckDiagnosticsCommand) {
        try {
          const { stdout, stderr } = await exec(
            'bash', ['-c', config.targetReadyCheckDiagnosticsCommand],
            { cwd: workingDir, ignoreReturnCode: true },
          )
          preflightDiagnostics = [stderr, stdout].filter(s => s.trim()).join('\n')
        } catch (err) {
          core.warning(`Could not retrieve preflight diagnostics: ${err}`)
        }
      }

      // Upload diagnostics as a downloadable artifact
      if (preflightDiagnostics) {
        const diagPath = path.join(tempDir, 'preflight-diagnostics.txt')
        fs.writeFileSync(diagPath, preflightDiagnostics)
        try {
          const artifact = new DefaultArtifactClient()
          await artifact.uploadArtifact('skyramp-preflight-diagnostics', [diagPath], tempDir)
        } catch (err) {
          core.warning(`Failed to upload preflight diagnostics artifact: ${err}`)
        }
      }

      await postPreflightFailure(formatPreflightFailureBody(issueBlocks))
      throw new Error(`SUT pre-flight validation failed: ${preflight.issues.map(i => i.kind).join(', ')}`)
    }
  }

  // ── 15. Update progress & start tracker ─────────────────────────────
  advanceSteps(steps, ProgressStep.Analyzing, Date.now())
  if (progressCommentId) {
    await updateProgress(progressCommentId, steps)
  }

  // Debounce: minimum 5s between PR comment updates
  let lastUpdateTime = Date.now()
  const DEBOUNCE_MS = 5000
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const tracker = createProgressTracker({
    logFile: paths.agentLogPath,
    steps,
    pollIntervalMs: 500,
    onStepChange: async (updatedSteps) => {
      // Persist latest steps so the post step has current state on cancellation
      core.saveState('steps', JSON.stringify(updatedSteps))
      if (!progressCommentId) return
      const now = Date.now()
      if (now - lastUpdateTime < DEBOUNCE_MS) {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(async () => {
          if (progressCommentId) {
            await updateProgress(progressCommentId, updatedSteps)
            lastUpdateTime = Date.now()
          }
        }, DEBOUNCE_MS - (now - lastUpdateTime))
        return
      }
      await updateProgress(progressCommentId, updatedSteps)
      lastUpdateTime = now
    },
  })
  tracker.start()

  // ── 16. Run Skyramp Testbot ─────────────────────────────────────────
  // executeAgent handles retries for both transient crashes and empty results (SKYR-3688).
  const { result, summary, commitMessage: reportCommitMessage, report, renderOptions } = await executeAgent({
    agentCmd, agentLabel: agent.label, config, paths, workingDir, authToken,
    prTitle, prBody, baseBranch, userPrompt, prNumber,
    licensePath: paths.licensePath,
  })

  // Stop the progress tracker now that the agent has exited
  tracker.stop()
  // Clear any pending debounce timer so it can't overwrite the final report
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  // Log step timing summary to CI logs and set as action outputs
  core.startGroup('Testbot step timing')
  let totalMs = 0
  for (const s of steps) {
    if (s.startedAt != null && s.completedAt != null) {
      const elapsed = s.completedAt - s.startedAt
      totalMs += elapsed
      core.info(`${s.label}: ${formatElapsed(elapsed)}`)
      core.setOutput(`duration_${s.step}`, String(Math.floor(elapsed / 1000)))
    } else if (s.status === 'completed') {
      core.info(`${s.label}: completed (no timing data)`)
      core.setOutput(`duration_${s.step}`, '0')
    } else {
      core.info(`${s.label}: ${s.status}`)
      core.setOutput(`duration_${s.step}`, '')
    }
  }
  const totalSeconds = Math.floor(totalMs / 1000)
  core.info(`Total: ${formatElapsed(totalMs)}`)
  core.setOutput('duration_total', String(totalSeconds))
  core.endGroup()

  // Persist latest step state for the post step (cancellation detection)
  core.saveState('steps', JSON.stringify(steps))

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

  // When the agent succeeded but produced no output after all retries (SKYR-3688)
  const emptySummary = !summary || summary.trim() === '' || summary.trim() === 'No summary available'
  if (result.success && emptySummary) {
    const noTestsMsg = [
      '<!-- skyramp-testbot -->',
      '### Skyramp Testbot — Internal Error',
      '',
      'Testbot encountered an unexpected internal error: the agent completed successfully but did not produce a report.',
      `This was retried ${config.testbotMaxRetries} times without success.`,
      '',
      'Please file an issue at https://github.com/skyramp/testbot/issues with a link to this workflow run.',
    ].join('\n')
    fs.writeFileSync(paths.combinedResultPath, noTestsMsg)
    core.setOutput('test_summary', noTestsMsg)
    core.error(`Agent produced no report after ${config.testbotMaxRetries} attempts — posting error to PR`)
  }

  // ── 18. Auto-commit test changes ───────────────────────────────────
  // Run before PR comment so commit errors can be included in the report.
  let commitHasChanges = false
  if (config.autoCommit) {
    config.prHeadRef = prHeadRef
    await configureGitIdentity(botName, botEmail)
    const commitResult = await autoCommit(config)
    commitHasChanges = commitResult.hasChanges

    // If commit failed (e.g. pre-commit hook), inject error into Issues Found and re-render
    if (commitResult.commitError) {
      const isHookFailure = /hook/i.test(commitResult.commitError)
      const issueDescription = isHookFailure
        ? `Git pre-commit hook blocked the test commit. Error: \`${commitResult.commitError.split('\n')[0]}\`. Install the missing tool(s) in your testbot workflow (as a step before the Skyramp Testbot action), or configure \`autoCommit: false\` and commit manually.`
        : `Failed to commit generated tests. Error: \`${commitResult.commitError.split('\n')[0]}\`. Check your repository's git hooks or testbot workflow configuration.`

      if (report) {
        report.issuesFound.push({ description: issueDescription })
        const reRendered = renderReport(report, renderOptions)
        fs.writeFileSync(paths.combinedResultPath, reRendered)
        core.setOutput('test_summary', reRendered)
      } else if (fs.existsSync(paths.combinedResultPath)) {
        fs.appendFileSync(paths.combinedResultPath, `\n\n**⚠️ ${issueDescription}**\n`)
      }
      core.warning(`Auto-commit failed: ${commitResult.commitError}`)
    }
  }

  // ── 19. Upload artifacts ─────────────────────────────────────────
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

  // ── 20. Post final PR comment ──────────────────────────────────────
  if (config.postPrComment && prNumber) {
    await withGroup('Posting final PR comment', async () => {
      let posted = false
      if (progressCommentId) {
        posted = await appendReportToProgress(progressCommentId, paths.combinedResultPath, steps)
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

  // Mark run as completed so the post step knows this wasn't a cancellation
  core.saveState('completed', 'true')

  // If the testbot agent failed AND it produced file changes, fail the action.
  // When there are no changes to commit (e.g. setup PR, no testable code),
  // treat it as a graceful no-op so the workflow check stays green.
  // Use commitHasChanges (not commitSha) because a hook failure leaves sha empty but changes exist.
  const actionFailed = !result.success && commitHasChanges
  if (!result.success) {
    if (commitHasChanges) {
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
