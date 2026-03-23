import * as core from '@actions/core'
import type { ActionInputs, AgentType } from './types'

export function getInputs(): ActionInputs {
  return {
    skyrampLicenseFile: core.getInput('skyrampLicenseFile', { required: true }),
    cursorApiKey: core.getInput('cursorApiKey'),
    copilotApiKey: core.getInput('copilotApiKey'),
    anthropicApiKey: core.getInput('anthropicApiKey'),
    testDirectory: core.getInput('testDirectory'),
    targetSetupCommand: core.getInput('targetSetupCommand'),
    authTokenCommand: core.getInput('authTokenCommand'),
    targetTeardownCommand: core.getInput('targetTeardownCommand'),
    skipTargetTeardown: core.getBooleanInput('skipTargetTeardown'),
    skyrampExecutorVersion: core.getInput('skyrampExecutorVersion'),
    skyrampMcpVersion: core.getInput('skyrampMcpVersion'),
    skyrampMcpSource: core.getInput('skyrampMcpSource') as ActionInputs['skyrampMcpSource'],
    skyrampMcpGithubToken: core.getInput('skyrampMcpGithubToken'),
    skyrampMcpGithubRef: core.getInput('skyrampMcpGithubRef'),
    nodeVersion: core.getInput('nodeVersion'),
    skipTargetSetup: core.getBooleanInput('skipTargetSetup'),
    targetReadyCheckCommand: core.getInput('targetReadyCheckCommand'),
    targetReadyCheckTimeout: (() => {
      const raw = parseInt(core.getInput('targetReadyCheckTimeout'), 10) || 30
      if (raw < 1) {
        core.warning(`targetReadyCheckTimeout must be at least 1 second, got ${raw}. Using 1s.`)
        return 1
      }
      return raw
    })(),
    targetReadyCheckDiagnosticsCommand: core.getInput('targetReadyCheckDiagnosticsCommand'),
    workingDirectory: core.getInput('workingDirectory'),
    autoCommit: core.getBooleanInput('autoCommit'),
    commitMessage: core.getInput('commitMessage'),
    postPrComment: core.getBooleanInput('postPrComment'),
    testExecutionTimeout: parseInt(core.getInput('testExecutionTimeout'), 10) || 300,
    testbotMaxRetries: parseInt(core.getInput('testbotMaxRetries'), 10) || 3,
    testbotRetryDelay: parseInt(core.getInput('testbotRetryDelay'), 10) || 10,
    testbotTimeout: parseInt(core.getInput('testbotTimeout'), 10) || 60,
    reportCollapsed: core.getBooleanInput('reportCollapsed'),
    enableDebug: core.getBooleanInput('enableDebug'),
  }
}

/**
 * Detect which agent CLI to use based on provided inputs.
 *
 * Priority order:
 * 1. cursorApiKey provided → Cursor CLI
 * 2. copilotApiKey provided → Copilot CLI
 * 3. anthropicApiKey provided → Claude Code CLI
 * 4. None → error
 */
export function detectAgentType(inputs: ActionInputs): AgentType {
  const hasCursor = !!inputs.cursorApiKey
  const hasCopilot = !!inputs.copilotApiKey
  const hasClaude = !!inputs.anthropicApiKey

  const count = [hasCursor, hasCopilot, hasClaude].filter(Boolean).length
  if (count > 1) {
    throw new Error('Multiple agent API keys provided. Please provide only one of: cursorApiKey, copilotApiKey, anthropicApiKey.')
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

  throw new Error('No agent API key provided. Please provide one of: cursorApiKey, copilotApiKey, or anthropicApiKey.')
}
