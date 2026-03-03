import * as core from '@actions/core'
import * as path from 'path'
import {
  WorkspaceConfigManager,
  type WorkspaceConfig,
} from '@skyramp/skyramp/src/workspace'
import type { ActionInputs, ResolvedConfig, WorkspaceServiceInfo } from './types'

/**
 * Load configuration from .skyramp/workspace.yml,
 * with action inputs as fallback defaults.
 */
export async function loadConfig(inputs: ActionInputs): Promise<ResolvedConfig> {
  const workingDir = path.resolve(inputs.workingDirectory)
  const manager = new WorkspaceConfigManager(workingDir)

  const services: WorkspaceServiceInfo[] = []
  let serviceStartupCommand = inputs.serviceStartupCommand
  let testDirectory = inputs.testDirectory
  let executorVersion = inputs.skyrampExecutorVersion
  let mcpVersion = inputs.skyrampMcpVersion

  if (await manager.exists()) {
    core.info(`Found ${manager.getConfigPath()}, loading workspace configuration...`)
    try {
      const wsConfig: WorkspaceConfig = await manager.read()

      // Extract metadata versions (workspace takes precedence over inputs)
      if (wsConfig.metadata) {
        if (wsConfig.metadata.executorVersion) {
          executorVersion = wsConfig.metadata.executorVersion
        }
        if (wsConfig.metadata.mcpVersion) {
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
          outputDir: svc.outputDir,
        })
      }

      // Use first service for operational defaults
      const first = (wsConfig.services ?? [])[0]
      if (first) {
        if (first.outputDir) {
          testDirectory = first.outputDir
        }
        if (first.runtimeDetails?.serverStartCommand) {
          serviceStartupCommand = first.runtimeDetails.serverStartCommand
        }
      }
    } catch (err) {
      core.warning(`Failed to parse ${manager.getConfigPath()}: ${(err as Error).message} — falling back to action input defaults`)
    }
  } else {
    core.notice('No .skyramp/workspace.yml found, using action input defaults')
  }

  const config: ResolvedConfig = {
    testDirectory,
    serviceStartupCommand,
    authTokenCommand: inputs.authTokenCommand,
    skyrampExecutorVersion: executorVersion,
    skyrampMcpVersion: mcpVersion,
    skyrampMcpSource: inputs.skyrampMcpSource,
    skyrampMcpGithubRef: inputs.skyrampMcpGithubRef,
    nodeVersion: inputs.nodeVersion,
    skipServiceStartup: inputs.skipServiceStartup,
    healthCheckCommand: inputs.healthCheckCommand,
    healthCheckTimeout: inputs.healthCheckTimeout,
    healthCheckDiagnosticsCommand: inputs.healthCheckDiagnosticsCommand,
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
