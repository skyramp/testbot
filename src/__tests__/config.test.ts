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

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    skyrampLicenseFile: 'license',
    cursorApiKey: 'key',
    copilotApiKey: '',
    anthropicApiKey: '',
    testDirectory: 'tests',
    targetSetupCommand: 'docker compose up -d',
    authTokenCommand: '',
    targetTeardownCommand: '',
    skipTargetTeardown: false,
    skyrampExecutorVersion: 'v1.3.3',
    skyrampMcpVersion: 'latest',
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

  it('returns input defaults when no workspace.yml exists', async () => {
    mockExists.mockResolvedValue(false)

    const config = await loadConfig(makeInputs())

    expect(config.testDirectory).toBe('tests')
    expect(config.targetSetupCommand).toBe('docker compose up -d')
    expect(config.skyrampExecutorVersion).toBe('v1.3.3')
    expect(config.skyrampMcpVersion).toBe('latest')
    expect(config.services).toEqual([])
  })

  it('extracts all services from workspace.yml', async () => {
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
        outputDir: 'tests/python',
        language: 'python',
        framework: 'pytest',
        api: { baseUrl: 'http://localhost:8000' },
        runtimeDetails: { serverStartCommand: 'docker compose up -d api', runtime: 'docker' },
      }],
    })

    const config = await loadConfig(makeInputs())

    // First service used for operational defaults
    expect(config.testDirectory).toBe('tests/python')
    expect(config.targetSetupCommand).toBe('docker compose up -d api')
    expect(config.skyrampExecutorVersion).toBe('v2.0.0')
    expect(config.skyrampMcpVersion).toBe('0.1.0')
    // All services collected
    expect(config.services).toEqual([{
      serviceName: 'api',
      language: 'python',
      framework: 'pytest',
      baseUrl: 'http://localhost:8000',
      outputDir: 'tests/python',
    }])
  })

  it('collects multiple services', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [
        { serviceName: 'frontend', outputDir: 'tests/js' },
        { serviceName: 'backend', outputDir: 'tests/python', language: 'python' },
      ],
    })

    const config = await loadConfig(makeInputs())

    expect(config.services).toHaveLength(2)
    expect(config.services[0].serviceName).toBe('frontend')
    expect(config.services[1].serviceName).toBe('backend')
    expect(config.services[1].language).toBe('python')
    // First service used for testDirectory
    expect(config.testDirectory).toBe('tests/js')
  })

  it('warns and uses defaults on read error', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockRejectedValue(new Error('YAML parse error'))

    const config = await loadConfig(makeInputs())

    expect(config.testDirectory).toBe('tests')
    expect(config.services).toEqual([])
  })

  it('uses input defaults for fields not present in workspace service', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{ serviceName: 'minimal', outputDir: '' }],
    })

    const config = await loadConfig(makeInputs({ testDirectory: 'custom-tests' }))

    expect(config.testDirectory).toBe('custom-tests')
    expect(config.targetSetupCommand).toBe('docker compose up -d')
  })

  it('uses serverTeardownCommand from workspace.yml when present', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{
        serviceName: 'api',
        outputDir: 'tests/python',
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
        outputDir: 'tests/python',
        runtimeDetails: { serverStartCommand: 'docker compose up -d', runtime: 'docker' },
      }],
    })

    const config = await loadConfig(makeInputs({ targetTeardownCommand: 'npm run teardown' }))

    expect(config.targetTeardownCommand).toBe('npm run teardown')
  })

  it('testbot-specific fields always come from inputs', async () => {
    mockExists.mockResolvedValue(true)
    mockRead.mockResolvedValue({
      services: [{ serviceName: 'api', outputDir: '' }],
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
