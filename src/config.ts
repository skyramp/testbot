import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import { parse as parseYaml } from 'yaml'
import type { ActionInputs, ResolvedConfig } from './types'

/**
 * Load workspace configuration from .skyramp.yml, with action inputs as defaults.
 * Config file values take precedence over action inputs.
 */
export async function loadConfig(inputs: ActionInputs): Promise<ResolvedConfig> {
  const configPath = path.resolve(inputs.workingDirectory, inputs.configFile)
  let fileConfig: Record<string, unknown> = {}

  if (fs.existsSync(configPath)) {
    core.info(`Found ${inputs.configFile}, loading configuration...`)
    const content = fs.readFileSync(configPath, 'utf-8')
    fileConfig = parseYaml(content) ?? {}
  } else {
    core.notice(`No ${inputs.configFile} found, using workflow/default values`)
  }

  const config: ResolvedConfig = {
    testDirectory: getString(fileConfig, 'test_directory', inputs.testDirectory),
    serviceStartupCommand: getString(fileConfig, 'service_startup_command', inputs.serviceStartupCommand),
    authTokenCommand: getString(fileConfig, 'auth_token_command', inputs.authTokenCommand),
    skyrampExecutorVersion: getString(fileConfig, 'skyramp_executor_version', inputs.skyrampExecutorVersion),
    skyrampMcpVersion: getString(fileConfig, 'skyramp_mcp_version', inputs.skyrampMcpVersion),
    skyrampMcpSource: getString(fileConfig, 'skyramp_mcp_source', inputs.skyrampMcpSource) as ResolvedConfig['skyrampMcpSource'],
    skyrampMcpGithubRef: getString(fileConfig, 'skyramp_mcp_github_ref', inputs.skyrampMcpGithubRef),
    nodeVersion: getString(fileConfig, 'node_version', inputs.nodeVersion),
    skipServiceStartup: getBoolean(fileConfig, 'skip_service_startup', inputs.skipServiceStartup),
    autoCommit: getBoolean(fileConfig, 'auto_commit', inputs.autoCommit),
    commitMessage: getString(fileConfig, 'commit_message', inputs.commitMessage),
    postPrComment: getBoolean(fileConfig, 'post_pr_comment', inputs.postPrComment),
    testbotMaxRetries: getNumber(fileConfig, 'testbot_max_retries', inputs.testbotMaxRetries),
    testbotRetryDelay: getNumber(fileConfig, 'testbot_retry_delay', inputs.testbotRetryDelay),
    testbotTimeout: getNumber(fileConfig, 'testbot_timeout', inputs.testbotTimeout),
    enableDebug: getBoolean(fileConfig, 'enable_debug', inputs.enableDebug),
  }

  core.startGroup('Resolved configuration')
  for (const [key, value] of Object.entries(config)) {
    if (key === 'authTokenCommand') {
      core.info(`  ${key}: [REDACTED]`)
    } else {
      core.info(`  ${key}: ${value}`)
    }
  }
  core.endGroup()

  return config
}

function getString(config: Record<string, unknown>, key: string, fallback: string): string {
  const val = config[key]
  if (val != null && val !== '' && typeof val === 'string') return val
  return fallback
}

function getBoolean(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const val = config[key]
  if (typeof val === 'boolean') return val
  if (typeof val === 'string') return val === 'true'
  return fallback
}

function getNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const val = config[key]
  if (typeof val === 'number') return val
  if (typeof val === 'string') {
    const parsed = parseInt(val, 10)
    if (!isNaN(parsed)) return parsed
  }
  return fallback
}
