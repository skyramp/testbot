import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ActionInputs } from '../types'
import type { WorkspaceConfig } from '@skyramp/skyramp/src/workspace'

const { mockExists, mockRead, mockGetConfigPath } = vi.hoisted(() => ({
  mockExists: vi.fn<() => Promise<boolean>>(),
  mockRead: vi.fn<() => Promise<WorkspaceConfig>>(),
  mockGetConfigPath: vi.fn<() => string>().mockReturnValue('/mock/.skyramp/workspace.yml'),
}))

vi.mock('@skyramp/skyramp/src/workspace', () => ({
  WorkspaceConfigManager: class {
    exists = mockExists
    read = mockRead
    getConfigPath = mockGetConfigPath
  },
}))

import { loadConfig } from '../config'

/**
 * Simulates action inputs as they come from core.getInput().
 * Fields without a `default:` in action.yml return '' when not set by the user.
 * testDirectory, skyrampExecutorVersion, skyrampMcpVersion have no defaults
 * in action.yml — they're resolved via workspace fallback + hardcoded defaults in config.ts.
 */
function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    skyrampLicenseFile: 'license',
    cursorApiKey: 'key',
    copilotApiKey: '',
    anthropicApiKey: '',
    testDirectory: '',
    targetSetupCommand: 'docker compose up -d',
    authTokenCommand: '',
    targetTeardownCommand: '',
    skipTargetTeardown: false,
    skyrampExecutorVersion: '',
    skyrampMcpVersion: '',
    skyrampMcpSource: 'npm',
    skyrampMcpGithubToken: '',
    skyrampMcpGithubRef: 'main',
    nodeVersion: 'lts/*',
    skipTargetSetup: false,
    targetReadyCheckCommand: '',
    targetReadyCheckTimeout: 30,
    targetReadyCheckDiagnosticsCommand: '',
    workingDirectory: '.',
    autoCommit: true,
    commitMessage: 'test commit',
    postPrComment: true,
    testExecutionTimeout: 300,
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

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfigPath.mockReturnValue('/mock/.skyramp/workspace.yml')
  })

  it('uses hardcoded defaults when no workspace.yml exists and inputs are empty', async () => {
    mockExists.mockResolvedValue(false)

    const config = await loadConfig(makeInputs())

    expect(config.testDirectory).toBe('tests')
    expect(config.targetSetupCommand).toBe('docker compose up -d')
    expect(config.skyrampExecutorVersion).toBe('v1.3.14')
    expect(config.skyrampMcpVersion).toBe('latest')
    expect(config.services).toEqual([])
  })

  it('workspace fills in when workflow inputs are empty', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      metadata: {
        schemaVersion: 'v1',
        executorVersion: 'v2.0.0',
        mcpVersion: '0.1.0',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      services: [{
        serviceName: 'api',
        testDirectory: 'tests/python',
        language: 'python',
        framework: 'pytest',
        api: { baseUrl: 'http://localhost:8000' },
        runtimeDetails: { serverStartCommand: 'docker compose up -d api', runtime: 'docker' },
      }],
    })

    const config = await loadConfig(makeInputs())

    // Workspace fills in empty inputs
    expect(config.testDirectory).toBe('tests/python')
    expect(config.skyrampExecutorVersion).toBe('v2.0.0')
    expect(config.skyrampMcpVersion).toBe('0.1.0')
    // Action input takes precedence over workspace serverStartCommand
    expect(config.targetSetupCommand).toBe('docker compose up -d')
    // All services collected
    expect(config.services).toEqual([{
      serviceName: 'api',
      language: 'python',
      framework: 'pytest',
      baseUrl: 'http://localhost:8000',
      testDirectory: 'tests/python',
    }])
  })

  it('workflow inputs take precedence over workspace values', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      metadata: {
        schemaVersion: 'v1',
        executorVersion: 'v2.0.0',
        mcpVersion: '0.1.0',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      services: [{
        serviceName: 'api',
        testDirectory: 'tests/python',
        language: 'python',
        framework: 'pytest',
        api: { baseUrl: 'http://localhost:8000' },
        runtimeDetails: { serverStartCommand: 'docker compose up -d api', runtime: 'docker' },
      }],
    })

    const config = await loadConfig(makeInputs({
      testDirectory: 'my-tests',
      skyrampExecutorVersion: 'v3.0.0',
      skyrampMcpVersion: '2.0.0',
    }))

    // Workflow inputs win over workspace
    expect(config.testDirectory).toBe('my-tests')
    expect(config.skyrampExecutorVersion).toBe('v3.0.0')
    expect(config.skyrampMcpVersion).toBe('2.0.0')
  })

  it('collects multiple services', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [
        { serviceName: 'frontend', testDirectory: 'tests/js' },
        { serviceName: 'backend', testDirectory: 'tests/python', language: 'python' },
      ],
    })

    const config = await loadConfig(makeInputs())

    expect(config.services).toHaveLength(2)
    expect(config.services[0].serviceName).toBe('frontend')
    expect(config.services[1].serviceName).toBe('backend')
    expect(config.services[1].language).toBe('python')
    // First service used for testDirectory (input is empty)
    expect(config.testDirectory).toBe('tests/js')
  })

  it('warns and uses hardcoded defaults on read error', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockRejectedValue(new Error('YAML parse error'))

    const config = await loadConfig(makeInputs())

    expect(config.testDirectory).toBe('tests')
    expect(config.services).toEqual([])
  })

  it('uses input defaults for fields not present in workspace service', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{ serviceName: 'minimal', testDirectory: '' }],
    })

    const config = await loadConfig(makeInputs({ testDirectory: 'custom-tests' }))

    expect(config.testDirectory).toBe('custom-tests')
    expect(config.targetSetupCommand).toBe('docker compose up -d')
  })

  it('falls back to workspace serverStartCommand when action input is empty', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{
        serviceName: 'api',
        testDirectory: 'tests/python',
        runtimeDetails: { serverStartCommand: 'docker compose up -d api', runtime: 'docker' },
      }],
    })

    const config = await loadConfig(makeInputs({ targetSetupCommand: '' }))

    expect(config.targetSetupCommand).toBe('docker compose up -d api')
  })

  it('uses serverTeardownCommand from workspace.yml when present', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{
        serviceName: 'api',
        testDirectory: 'tests/python',
        runtimeDetails: Object.assign(
          { serverStartCommand: 'docker compose up -d', runtime: 'docker' as const },
          { serverTeardownCommand: 'docker compose down -v' },
        ),
      }],
    })

    const config = await loadConfig(makeInputs())

    expect(config.targetTeardownCommand).toBe('docker compose down -v')
  })

  it('falls back to input default when serverTeardownCommand is absent', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{
        serviceName: 'api',
        testDirectory: 'tests/python',
        runtimeDetails: { serverStartCommand: 'docker compose up -d', runtime: 'docker' },
      }],
    })

    const config = await loadConfig(makeInputs({ targetTeardownCommand: 'npm run teardown' }))

    expect(config.targetTeardownCommand).toBe('npm run teardown')
  })

  it('testbot-specific fields always come from inputs', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{ serviceName: 'api', testDirectory: '' }],
    })

    const config = await loadConfig(makeInputs({
      autoCommit: false,
      testbotTimeout: 20,
      enableDebug: true,
    }))

    expect(config.autoCommit).toBe(false)
    expect(config.testbotTimeout).toBe(20)
    expect(config.enableDebug).toBe(true)
  })
})
