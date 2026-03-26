import * as core from '@actions/core'
import type { ResolvedConfig, TargetDeploymentDetails, WorkspaceServiceInfo, StartServicesResult } from './types'
import { StartupError } from './startup-errors'
import { exec, sleep, withGroup, withRetry, secondsToMilliseconds, debug } from './utils'

/** Fallback health check when no service base URLs are available. */
const NAIVE_HEALTH_CHECK = 'sleep 5'

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
 * Build a default health check command from service base URLs.
 * Generates `curl -sf <url>` for each service; joins with `&&` so all must pass.
 * Returns 'sleep 5' as fallback if no base URLs are available.
 */
export function buildDefaultHealthCheckCommand(services: WorkspaceServiceInfo[]): string {
  const urls = services
    .map(svc => svc.baseUrl)
    .filter((url): url is string => !!url)

  if (urls.length === 0) return NAIVE_HEALTH_CHECK

  // Use unique URLs only (multiple services may share the same base URL)
  const unique = [...new Set(urls)]
  return unique.map(url => `curl -sf ${url}`).join(' && ')
}

/**
 * Start user-defined services (e.g., docker compose up).
 */
export async function startServices(config: ResolvedConfig, workingDir: string): Promise<StartServicesResult> {
  return await withGroup('Starting services', async () => {
    debug(`startServices called.`)
    if (config.skipTargetSetup) {
      core.notice('Skipping service startup (skipTargetSetup=true)')
      return { details: null, healthCheckPassed: true, healthCheckOutput: '' }
    }

    let setupStdout = ''
    core.info(`Running command: ${config.targetSetupCommand}`)

    // Track the last captured output across retries so it is available in StartupError.
    let lastStdout = ''
    let lastStderr = ''
    try {
      const result = await withRetry(
        async () => {
          const r = await exec('bash', ['-c', config.targetSetupCommand], {
            cwd: workingDir,
            ignoreReturnCode: true,
          })
          lastStdout = r.stdout
          lastStderr = r.stderr
          if (r.exitCode !== 0) throw new Error(`exit code ${r.exitCode}`)
          return r
        },
        { retries: config.targetSetupRetries, delay: config.targetSetupRetryDelay, label: 'Service startup' },
      )
      setupStdout = result.stdout
      core.notice('Services started successfully')
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      core.error(`Service startup command failed: ${errMsg}`)
      throw new StartupError(
        `Service startup failed. Command: ${config.targetSetupCommand}`,
        config.targetSetupCommand,
        lastStdout,
        lastStderr,
        { cause: err },
      )
    }

    // Resolve health check command: use explicit config, or auto-generate from service URLs
    const healthCheckCommand = config.targetReadyCheckCommand || buildDefaultHealthCheckCommand(config.services)

    // Wait for services to be ready
    core.info(`Running health check: ${healthCheckCommand}`)
    const startTime = Date.now()
    const timeoutMs = secondsToMilliseconds(config.targetReadyCheckTimeout)
    const pollInterval = 2
    let attempt = 0
    let lastHealthCheckStdout = ''
    let lastHealthCheckStderr = ''

    while (Date.now() - startTime < timeoutMs) {
      attempt++
      const { exitCode, stdout, stderr } = await exec('bash', ['-c', healthCheckCommand], {
        cwd: workingDir,
        ignoreReturnCode: true,
      })
      lastHealthCheckStdout = stdout
      lastHealthCheckStderr = stderr
      if (exitCode === 0) {
        core.notice(`Health check passed on attempt ${attempt}`)
        return { details: parseTargetDeploymentDetails(setupStdout), healthCheckPassed: true, healthCheckOutput: '' }
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      core.info(`Health check attempt ${attempt} failed (${elapsed}s / ${config.targetReadyCheckTimeout}s), retrying in ${pollInterval}s...`)
      await sleep(pollInterval)
    }

    core.warning(
      `Service health check timed out after ${config.targetReadyCheckTimeout}s — ` +
      `pre-flight validation will report NOT_DEPLOYED and halt the agent run.`,
    )

    // Run diagnostics command and capture its output for the PR comment
    let diagnosticsOutput = ''
    if (config.targetReadyCheckDiagnosticsCommand) {
      try {
        core.info('--- Diagnostics ---')
        const { stdout, stderr } = await exec('bash', ['-c', config.targetReadyCheckDiagnosticsCommand], {
          cwd: workingDir,
          ignoreReturnCode: true,
        })
        diagnosticsOutput = [stderr, stdout].filter(s => s.trim()).join('\n')
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        core.warning(`Could not retrieve diagnostics: ${errMsg}`)
      }
    }

    const healthCheckOutput = [
      diagnosticsOutput,
      lastHealthCheckStderr,
      lastHealthCheckStdout,
    ].filter(s => s.trim()).join('\n')

    return { details: parseTargetDeploymentDetails(setupStdout), healthCheckPassed: false, healthCheckOutput }
  })
}

/**
 * Tear down user-defined services (e.g., docker compose down).
 * Non-fatal: failures log a warning but never throw.
 */
export async function teardownServices(config: ResolvedConfig, workingDir: string): Promise<void> {
  await withGroup('Tearing down services', async () => {
    if (config.skipTargetTeardown) {
      core.notice('Skipping service teardown (skipTargetTeardown=true)')
      return
    }

    if (!config.targetTeardownCommand) {
      core.info('No targetTeardownCommand configured, skipping teardown')
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
 * Export SKYRAMP_TEST_BASE_URL / SKYRAMP_TEST_SERVICE_URL_<NAME> env vars
 * so generated tests can resolve their endpoint URLs at runtime.
 *
 * Single service (or all services share the same URL):
 *   exports SKYRAMP_TEST_BASE_URL=<url>
 *
 * Multiple services with distinct URLs:
 *   exports SKYRAMP_TEST_SERVICE_URL_<NAME>=<url> for each service
 */
export function exportServiceBaseUrlEnvVars(services: WorkspaceServiceInfo[]): void {
  const withUrl = services.filter(svc => svc.baseUrl)
  if (withUrl.length === 0) return

  const sanitize = (name: string) => name.toUpperCase().replace(/[-.:\/]/g, '_')

  // Check if all services share the same URL
  const uniqueUrls = new Set(withUrl.map(svc => svc.baseUrl))

  if (uniqueUrls.size <= 1) {
    core.exportVariable('SKYRAMP_TEST_BASE_URL', withUrl[0].baseUrl!)
    core.notice(`Target URL: ${withUrl[0].baseUrl}`)
  } else {
    for (const svc of withUrl) {
      const envVar = `SKYRAMP_TEST_SERVICE_URL_${sanitize(svc.serviceName)}`
      core.exportVariable(envVar, svc.baseUrl!)
      debug(`Exported ${envVar}=${svc.baseUrl}`)
    }
    core.notice(`Target URLs exported for ${withUrl.length} services`)
  }
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
