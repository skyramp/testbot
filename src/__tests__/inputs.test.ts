import './mocks/core'
import { describe, it, expect } from 'vitest'
import { detectAgentType } from '../inputs'
import type { ActionInputs } from '../types'

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    skyrampLicenseFile: '',
    cursorApiKey: '',
    copilotApiKey: '',
    anthropicApiKey: '',
    testDirectory: 'tests',
    targetSetupCommand: '',
    authTokenCommand: '',
    targetTeardownCommand: '',
    skipTargetTeardown: false,
    skyrampExecutorVersion: '',
    skyrampMcpVersion: '',
    skyrampMcpSource: 'npm',
    skyrampMcpGithubToken: '',
    skyrampMcpGithubRef: '',
    nodeVersion: '',
    skipTargetSetup: false,
    targetReadyCheckCommand: '',
    targetReadyCheckTimeout: 30,
    targetReadyCheckDiagnosticsCommand: '',
    workingDirectory: '.',
    autoCommit: false,
    commitMessage: '',
    postPrComment: true,
    testExecutionTimeout: 300,
    maxRecommendations: 20,
    maxGenerate: 3,
    testbotMaxRetries: 3,
    testbotRetryDelay: 10,
    testbotTimeout: 10,
    targetSetupRetries: 3,
    targetSetupRetryDelay: 10,
    reportCollapsed: false,
    enableDebug: false,
    ...overrides,
  }
}

describe('detectAgentType', () => {
  it('returns cursor when only cursorApiKey is set', () => {
    const inputs = makeInputs({ cursorApiKey: 'sk-cursor-123' })
    expect(detectAgentType(inputs)).toBe('cursor')
  })

  it('returns copilot when only copilotApiKey is set', () => {
    const inputs = makeInputs({ copilotApiKey: 'ghp-copilot-456' })
    expect(detectAgentType(inputs)).toBe('copilot')
  })

  it('returns claude when only anthropicApiKey is set', () => {
    const inputs = makeInputs({ anthropicApiKey: 'sk-ant-api03-test' })
    expect(detectAgentType(inputs)).toBe('claude')
  })

  it('throws when cursor and copilot keys are provided', () => {
    const inputs = makeInputs({ cursorApiKey: 'sk-123', copilotApiKey: 'ghp-456' })
    expect(() => detectAgentType(inputs)).toThrow('Multiple agent API keys provided')
  })

  it('throws when cursor and claude keys are provided', () => {
    const inputs = makeInputs({ cursorApiKey: 'sk-123', anthropicApiKey: 'sk-ant-api03-test' })
    expect(() => detectAgentType(inputs)).toThrow('Multiple agent API keys provided')
  })

  it('throws when copilot and claude keys are provided', () => {
    const inputs = makeInputs({ copilotApiKey: 'ghp-456', anthropicApiKey: 'sk-ant-api03-test' })
    expect(() => detectAgentType(inputs)).toThrow('Multiple agent API keys provided')
  })

  it('throws when all three keys are provided', () => {
    const inputs = makeInputs({ cursorApiKey: 'sk-123', copilotApiKey: 'ghp-456', anthropicApiKey: 'sk-ant-api03-test' })
    expect(() => detectAgentType(inputs)).toThrow('Multiple agent API keys provided')
  })

  it('throws when no key is provided', () => {
    const inputs = makeInputs()
    expect(() => detectAgentType(inputs)).toThrow('No agent API key provided')
  })
})
