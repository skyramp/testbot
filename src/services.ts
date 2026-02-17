import * as core from '@actions/core'
import type { ResolvedConfig } from './types'
import { exec, sleep } from './utils'

/**
 * Start user-defined services (e.g., docker compose up).
 */
export async function startServices(config: ResolvedConfig, workingDir: string): Promise<void> {
  core.startGroup('Starting services')

  if (config.skipServiceStartup) {
    core.notice('Skipping service startup (skip_service_startup=true)')
    core.endGroup()
    return
  }

  core.info(`Running command: ${config.serviceStartupCommand}`)
  try {
    await exec('bash', ['-c', config.serviceStartupCommand], { cwd: workingDir })
    core.notice('Services started successfully')
  } catch {
    core.warning('Service startup command failed, but continuing...')
  }

  // Give services time to initialize
  await sleep(5)
  core.endGroup()
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
