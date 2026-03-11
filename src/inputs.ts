import * as core from '@actions/core'
import type { ActionInputs, AgentType } from './types'

export function getInputs(): ActionInputs {
  return {
    skyrampLicenseFile: core.getInput('skyramp_license_file', { required: true }),
    cursorApiKey: core.getInput('cursor_api_key'),
    copilotApiKey: core.getInput('copilot_api_key'),
    anthropicApiKey: core.getInput('anthropic_api_key'),
    testDirectory: core.getInput('test_directory'),
    targetSetupCommand: core.getInput('target_setup_command'),
    authTokenCommand: core.getInput('auth_token_command'),
    targetTeardownCommand: core.getInput('target_teardown_command'),
    skipTargetTeardown: core.getBooleanInput('skip_target_teardown'),
    skyrampExecutorVersion: core.getInput('skyramp_executor_version'),
    skyrampMcpVersion: core.getInput('skyramp_mcp_version'),
    skyrampMcpSource: core.getInput('skyramp_mcp_source') as ActionInputs['skyrampMcpSource'],
    skyrampMcpGithubToken: core.getInput('skyramp_mcp_github_token'),
    skyrampMcpGithubRef: core.getInput('skyramp_mcp_github_ref'),
    nodeVersion: core.getInput('node_version'),
    skipTargetSetup: core.getBooleanInput('skip_target_setup'),
    targetReadyCheckCommand: core.getInput('target_ready_check_command'),
    targetReadyCheckTimeout: (() => {
      const raw = parseInt(core.getInput('target_ready_check_timeout'), 10) || 30
      if (raw < 1) {
        core.warning(`target_ready_check_timeout must be at least 1 second, got ${raw}. Using 1s.`)
        return 1
      }
      return raw
    })(),
    targetReadyCheckDiagnosticsCommand: core.getInput('target_ready_check_diagnostics_command'),
    workingDirectory: core.getInput('working_directory'),
    autoCommit: core.getBooleanInput('auto_commit'),
    commitMessage: core.getInput('commit_message'),
    postPrComment: core.getBooleanInput('post_pr_comment'),
    testExecutionTimeout: parseInt(core.getInput('test_execution_timeout'), 10) || 300,
    testbotMaxRetries: parseInt(core.getInput('testbot_max_retries'), 10) || 3,
    testbotRetryDelay: parseInt(core.getInput('testbot_retry_delay'), 10) || 10,
    testbotTimeout: parseInt(core.getInput('testbot_timeout'), 10) || 60,
    reportCollapsed: core.getBooleanInput('report_collapsed'),
    enableDebug: core.getBooleanInput('enable_debug'),
  }
}

/**
 * Detect which agent CLI to use based on provided inputs.
 *
 * Priority order:
 * 1. cursor_api_key provided → Cursor CLI
 * 2. copilot_api_key provided → Copilot CLI
 * 3. anthropic_api_key provided → Claude Code CLI
 * 4. None → error
 */
export function detectAgentType(inputs: ActionInputs): AgentType {
  const hasCursor = !!inputs.cursorApiKey
  const hasCopilot = !!inputs.copilotApiKey
  const hasClaude = !!inputs.anthropicApiKey

  const count = [hasCursor, hasCopilot, hasClaude].filter(Boolean).length
  if (count > 1) {
    throw new Error('Multiple agent API keys provided. Please provide only one of: cursor_api_key, copilot_api_key, anthropic_api_key.')
  }

  if (hasCursor) {
    core.notice('Using Cursor CLI agent')
    return 'cursor'
  }
  if (hasCopilot) {
    core.notice('Using GitHub Copilot CLI agent')
    return 'copilot'
  }
  if (hasClaude) {
    core.notice('Using Claude Code CLI agent')
    return 'claude'
  }

  throw new Error('No agent API key provided. Please provide one of: cursor_api_key, copilot_api_key, or anthropic_api_key.')
}
