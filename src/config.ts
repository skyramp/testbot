import * as core from '@actions/core'
import * as path from 'path'
import {
  WorkspaceConfigManager,
  type WorkspaceConfig,
} from '@skyramp/skyramp/src/workspace'
import type { ActionInputs, ResolvedConfig, WorkspaceServiceInfo } from './types'

/**
 * Load configuration from .skyramp/workspace.yml.
 *
 * Precedence (highest to lowest):
 *   1. Workflow inputs (explicitly set in the GitHub Actions workflow file)
 *   2. Workspace config (.skyramp/workspace.yml)
 *   3. Hardcoded defaults
 */
export async function loadConfig(inputs: ActionInputs): Promise<ResolvedConfig> {
  const workingDir = path.resolve(inputs.workingDirectory)
  const manager = new WorkspaceConfigManager(workingDir)

  const services: WorkspaceServiceInfo[] = []
  let targetSetupCommand = inputs.targetSetupCommand
  let targetTeardownCommand = inputs.targetTeardownCommand
  let testDirectory = inputs.testDirectory
  let executorVersion = inputs.skyrampExecutorVersion
  let mcpVersion = inputs.skyrampMcpVersion

  if (await manager.exists()) {
    core.info(`Found ${manager.getConfigPath()}, loading workspace configuration...`)
    try {
      const wsConfig: WorkspaceConfig = await manager.read()

      // Workspace values fill in gaps left by empty workflow inputs.
      // Workflow inputs always take precedence when non-empty.
      if (wsConfig.metadata) {
        if (!executorVersion && wsConfig.metadata.executorVersion) {
          executorVersion = wsConfig.metadata.executorVersion
        }
        if (!mcpVersion && wsConfig.metadata.mcpVersion) {
          mcpVersion = wsConfig.metadata.mcpVersion
        }
      }

      // Collect all services
      for (const svc of wsConfig.services ?? []) {
        services.push({
          serviceName: svc.serviceName,
          language: svc.language,
          framework: svc.framework,
          baseUrl: svc.api?.baseUrl,
          testDirectory: svc.testDirectory,
        })
      }

      // Use first service for operational defaults when workflow inputs are empty.
      const first = (wsConfig.services ?? [])[0]
      if (first) {
        if (!testDirectory && first.testDirectory) {
          testDirectory = first.testDirectory
        }
        if (!targetSetupCommand && first.runtimeDetails?.serverStartCommand) {
          targetSetupCommand = first.runtimeDetails.serverStartCommand
        }
        const teardown = (first.runtimeDetails as { serverTeardownCommand?: unknown })?.serverTeardownCommand
        if (!targetTeardownCommand && typeof teardown === 'string') {
          targetTeardownCommand = teardown
        }
      }
    } catch (err) {
      core.warning(`Failed to parse ${manager.getConfigPath()}: ${(err as Error).message} — falling back to action input defaults`)
    }
  } else {
    core.notice('No .skyramp/workspace.yml found, using action input defaults')
  }

  // Apply hardcoded defaults for fields that are still empty
  if (!testDirectory) testDirectory = 'tests'
  if (!executorVersion) executorVersion = 'v1.3.12'
  if (!mcpVersion) mcpVersion = 'latest'

  const config: ResolvedConfig = {
    testDirectory,
    targetSetupCommand,
    authTokenCommand: inputs.authTokenCommand,
    targetTeardownCommand,
    skipTargetTeardown: inputs.skipTargetTeardown,
    skyrampExecutorVersion: executorVersion,
    skyrampMcpVersion: mcpVersion,
    skyrampMcpSource: inputs.skyrampMcpSource,
    skyrampMcpGithubRef: inputs.skyrampMcpGithubRef,
    nodeVersion: inputs.nodeVersion,
    skipTargetSetup: inputs.skipTargetSetup,
    targetReadyCheckCommand: inputs.targetReadyCheckCommand,
    targetReadyCheckTimeout: inputs.targetReadyCheckTimeout,
    targetReadyCheckDiagnosticsCommand: inputs.targetReadyCheckDiagnosticsCommand,
    autoCommit: inputs.autoCommit,
    commitMessage: inputs.commitMessage,
    postPrComment: inputs.postPrComment,
    testExecutionTimeout: inputs.testExecutionTimeout,
    testbotMaxRetries: inputs.testbotMaxRetries,
    testbotRetryDelay: inputs.testbotRetryDelay,
    testbotTimeout: inputs.testbotTimeout,
    reportCollapsed: inputs.reportCollapsed,
    enableDebug: inputs.enableDebug,
    services,
  }

  core.startGroup('Resolved configuration')
  for (const [key, value] of Object.entries(config)) {
    if (key === 'authTokenCommand') {
      core.info(`  ${key}: [REDACTED]`)
    } else if (key === 'services') {
      core.info(`  ${key}: ${JSON.stringify(value)}`)
    } else {
      core.info(`  ${key}: ${value}`)
    }
  }
  core.endGroup()

  return config
}
