import * as core from '@actions/core'
import type { ResolvedConfig } from './types'
import { exec, sleep, withGroup, secondsToMilliseconds } from './utils'

/**
 * Start user-defined services (e.g., docker compose up).
 */
export async function startServices(config: ResolvedConfig, workingDir: string): Promise<void> {
  await withGroup('Starting services', async () => {
    if (config.skipServiceStartup) {
      core.notice('Skipping service startup (skip_service_startup=true)')
      return
    }

    core.info(`Running command: ${config.serviceStartupCommand}`)
    try {
      await exec('bash', ['-c', config.serviceStartupCommand], { cwd: workingDir })
      core.notice('Services started successfully')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      core.error(`Service startup command failed: ${errMsg}`)
      throw new Error(
        `Service startup failed — all subsequent tests will likely fail. Command: ${config.serviceStartupCommand}`,
        { cause: err },
      )
    }

    // Wait for services to be ready
    core.info(`Running health check: ${config.healthCheckCommand}`)
    const startTime = Date.now()
    const timeoutMs = secondsToMilliseconds(config.healthCheckTimeout)
    const pollInterval = 2
    let attempt = 0

    while (Date.now() - startTime < timeoutMs) {
      attempt++
      const { exitCode } = await exec('bash', ['-c', config.healthCheckCommand], {
        cwd: workingDir,
        ignoreReturnCode: true,
      })
      if (exitCode === 0) {
        core.notice(`Health check passed on attempt ${attempt}`)
        return
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      core.info(`Health check attempt ${attempt} failed (${elapsed}s / ${config.healthCheckTimeout}s), retrying in ${pollInterval}s...`)
      await sleep(pollInterval)
    }

    core.warning(`Health check timed out after ${config.healthCheckTimeout}s, continuing anyway...`)

    // Run diagnostics command to help debug service startup issues
    try {
      core.info('--- Diagnostics ---')
      await exec('bash', ['-c', config.healthCheckDiagnosticsCommand], {
        cwd: workingDir,
        ignoreReturnCode: true,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      core.warning(`Could not retrieve diagnostics: ${errMsg}`)
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
