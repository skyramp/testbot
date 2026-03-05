import * as core from '@actions/core'
import type { ResolvedConfig, TargetDeploymentDetails } from './types'
import { exec, sleep, withGroup, secondsToMilliseconds } from './utils'

/**
 * Parse structured JSON output from the last non-empty line of setup command stdout.
 * Convention: setup scripts emit log output freely, then output JSON as the last line.
 */
export function parseTargetDeploymentDetails(stdout: string): TargetDeploymentDetails | null {
  const lines = stdout.split('\n')
  let lastLine = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed) {
      lastLine = trimmed
      break
    }
  }

  if (!lastLine.startsWith('{')) return null

  try {
    const parsed = JSON.parse(lastLine)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as TargetDeploymentDetails
  } catch {
    return null
  }
}

/**
 * Start user-defined services (e.g., docker compose up).
 * Returns parsed JSON from the setup command's stdout (last line), or null.
 */
export async function startServices(config: ResolvedConfig, workingDir: string): Promise<TargetDeploymentDetails | null> {
  return await withGroup('Starting services', async () => {
    if (config.skipTargetSetup) {
      core.notice('Skipping service startup (skip_target_setup=true)')
      return null
    }

    let setupStdout = ''
    core.info(`Running command: ${config.targetSetupCommand}`)
    try {
      const { stdout } = await exec('bash', ['-c', config.targetSetupCommand], { cwd: workingDir })
      setupStdout = stdout
      core.notice('Services started successfully')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      core.error(`Service startup command failed: ${errMsg}`)
      throw new Error(
        `Service startup failed — all subsequent tests will likely fail. Command: ${config.targetSetupCommand}`,
        { cause: err },
      )
    }

    // Wait for services to be ready
    core.info(`Running health check: ${config.targetReadyCheckCommand}`)
    const startTime = Date.now()
    const timeoutMs = secondsToMilliseconds(config.targetReadyCheckTimeout)
    const pollInterval = 2
    let attempt = 0

    while (Date.now() - startTime < timeoutMs) {
      attempt++
      const { exitCode } = await exec('bash', ['-c', config.targetReadyCheckCommand], {
        cwd: workingDir,
        ignoreReturnCode: true,
      })
      if (exitCode === 0) {
        core.notice(`Health check passed on attempt ${attempt}`)
        return parseTargetDeploymentDetails(setupStdout)
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      core.info(`Health check attempt ${attempt} failed (${elapsed}s / ${config.targetReadyCheckTimeout}s), retrying in ${pollInterval}s...`)
      await sleep(pollInterval)
    }

    core.warning(`Health check timed out after ${config.targetReadyCheckTimeout}s, continuing anyway...`)

    // Run diagnostics command to help debug service startup issues
    try {
      core.info('--- Diagnostics ---')
      await exec('bash', ['-c', config.targetReadyCheckDiagnosticsCommand], {
        cwd: workingDir,
        ignoreReturnCode: true,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      core.warning(`Could not retrieve diagnostics: ${errMsg}`)
    }

    return parseTargetDeploymentDetails(setupStdout)
  })
}

/**
 * Tear down user-defined services (e.g., docker compose down).
 * Non-fatal: failures log a warning but never throw.
 */
export async function teardownServices(config: ResolvedConfig, workingDir: string): Promise<void> {
  await withGroup('Tearing down services', async () => {
    if (config.skipTargetTeardown) {
      core.notice('Skipping service teardown (skip_target_teardown=true)')
      return
    }

    if (!config.targetTeardownCommand) {
      core.info('No target_teardown_command configured, skipping teardown')
      return
    }

    core.info(`Running teardown command: ${config.targetTeardownCommand}`)
    try {
      await exec('bash', ['-c', config.targetTeardownCommand], { cwd: workingDir })
      core.notice('Services torn down successfully')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      core.warning(`Service teardown command failed (non-fatal): ${errMsg}`)
    }
  })
}

/**
 * Run the auth token command and return the token. Sets SKYRAMP_TEST_TOKEN env var.
 */
export async function generateAuthToken(config: ResolvedConfig, workingDir: string): Promise<string> {
  if (!config.authTokenCommand) return ''

  core.startGroup('Generating authentication token')

  const { stdout, exitCode } = await exec('bash', ['-c', config.authTokenCommand], {
    cwd: workingDir,
    ignoreReturnCode: true,
  })

  if (exitCode !== 0) {
    core.endGroup()
    throw new Error('Auth token command failed')
  }

  const token = stdout.trim()
  if (!token) {
    core.warning('Auth token command produced empty output')
  } else {
    core.setSecret(token)
    core.exportVariable('SKYRAMP_TEST_TOKEN', token)
    core.notice('Authentication token generated successfully')
  }

  core.endGroup()
  return token
}
