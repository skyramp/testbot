import './mocks/core'
import { describe, it, expect } from 'vitest'
import { detectAgentType } from '../inputs'
import type { ActionInputs } from '../types'

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    skyrampLicenseFile: '',
    cursorApiKey: '',
    copilotApiKey: '',
    testDirectory: 'tests',
    serviceStartupCommand: '',
    authTokenCommand: '',
    skyrampExecutorVersion: '',
    skyrampMcpVersion: '',
    skyrampMcpSource: 'npm',
    skyrampMcpGithubToken: '',
    skyrampMcpGithubRef: '',
    nodeVersion: '',
    skipServiceStartup: false,
    healthCheckCommand: '',
    healthCheckTimeout: 30,
    healthCheckDiagnosticsCommand: '',
    workingDirectory: '.',
    autoCommit: false,
    commitMessage: '',
    postPrComment: true,
    testExecutionTimeout: 300,
    testbotMaxRetries: 3,
    testbotRetryDelay: 10,
    testbotTimeout: 10,
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

  it('throws when both keys are provided', () => {
    const inputs = makeInputs({ cursorApiKey: 'sk-123', copilotApiKey: 'ghp-456' })
    expect(() => detectAgentType(inputs)).toThrow('Both cursor_api_key and copilot_api_key provided')
  })

  it('throws when neither key is provided', () => {
    const inputs = makeInputs()
    expect(() => detectAgentType(inputs)).toThrow('Either cursor_api_key or copilot_api_key must be provided')
  })
})
