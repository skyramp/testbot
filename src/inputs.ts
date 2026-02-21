import * as core from '@actions/core'
import type { ActionInputs, AgentType } from './types'

export function getInputs(): ActionInputs {
  return {
    skyrampLicenseFile: core.getInput('skyramp_license_file', { required: true }),
    cursorApiKey: core.getInput('cursor_api_key'),
    copilotApiKey: core.getInput('copilot_api_key'),
    testDirectory: core.getInput('test_directory'),
    serviceStartupCommand: core.getInput('service_startup_command'),
    authTokenCommand: core.getInput('auth_token_command'),
    skyrampExecutorVersion: core.getInput('skyramp_executor_version'),
    skyrampMcpVersion: core.getInput('skyramp_mcp_version'),
    skyrampMcpSource: core.getInput('skyramp_mcp_source') as ActionInputs['skyrampMcpSource'],
    skyrampMcpGithubToken: core.getInput('skyramp_mcp_github_token'),
    skyrampMcpGithubRef: core.getInput('skyramp_mcp_github_ref'),
    nodeVersion: core.getInput('node_version'),
    skipServiceStartup: core.getBooleanInput('skip_service_startup'),
    healthCheckCommand: core.getInput('health_check_command'),
    healthCheckTimeout: (() => {
      const raw = parseInt(core.getInput('health_check_timeout'), 10) || 30
      if (raw < 1) {
        core.warning(`health_check_timeout must be at least 1 second, got ${raw}. Using 1s.`)
        return 1
      }
      return raw
    })(),
    healthCheckDiagnosticsCommand: core.getInput('health_check_diagnostics_command'),
    workingDirectory: core.getInput('working_directory'),
    autoCommit: core.getBooleanInput('auto_commit'),
    commitMessage: core.getInput('commit_message'),
    postPrComment: core.getBooleanInput('post_pr_comment'),
    testExecutionTimeout: parseInt(core.getInput('test_execution_timeout'), 10) || 300,
    testbotMaxRetries: parseInt(core.getInput('testbot_max_retries'), 10) || 3,
    testbotRetryDelay: parseInt(core.getInput('testbot_retry_delay'), 10) || 10,
    testbotTimeout: parseInt(core.getInput('testbot_timeout'), 10) || 10,
    reportCollapsed: core.getBooleanInput('report_collapsed'),
    enableDebug: core.getBooleanInput('enable_debug'),
  }
}

export function detectAgentType(inputs: ActionInputs): AgentType {
  const hasCursor = !!inputs.cursorApiKey
  const hasCopilot = !!inputs.copilotApiKey

  if (hasCursor && hasCopilot) {
    throw new Error('Both cursor_api_key and copilot_api_key provided. Please provide only one.')
  }
  if (!hasCursor && !hasCopilot) {
    throw new Error('Either cursor_api_key or copilot_api_key must be provided.')
  }

  const agentType = hasCursor ? 'cursor' : 'copilot'
  core.notice(`Using ${agentType === 'cursor' ? 'Cursor CLI' : 'GitHub Copilot CLI'} agent`)
  return agentType
}
