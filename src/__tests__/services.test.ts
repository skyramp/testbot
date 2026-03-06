import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startServices, teardownServices, parseTargetDeploymentDetails } from '../services'
import { exec } from '../utils'
import type { ResolvedConfig, TargetDeploymentDetails } from '../types'

vi.mock('../utils', () => ({
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  sleep: vi.fn(),
  withGroup: vi.fn(async (_name: string, fn: () => Promise<void>) => fn()),
  secondsToMilliseconds: (s: number) => s * 1000,
}))

const baseConfig: ResolvedConfig = {
  testDirectory: 'tests',
  targetSetupCommand: 'docker compose up -d',
  authTokenCommand: '',
  targetTeardownCommand: '',
  skipTargetTeardown: false,
  skyrampExecutorVersion: 'v1.3.3',
  skyrampMcpVersion: 'latest',
  skyrampMcpSource: 'npm',
  skyrampMcpGithubRef: '',
  nodeVersion: 'lts/*',
  skipTargetSetup: false,
  targetReadyCheckCommand: 'curl -f http://localhost:8000/health',
  targetReadyCheckTimeout: 30,
  targetReadyCheckDiagnosticsCommand: 'docker ps',
  autoCommit: false,
  commitMessage: '',
  postPrComment: true,
  testExecutionTimeout: 300,
  testbotMaxRetries: 3,
  testbotRetryDelay: 10,
  testbotTimeout: 10,
  reportCollapsed: false,
  enableDebug: false,
  services: [],
}

describe('startServices', () => {
  const mockExec = vi.mocked(exec)

  beforeEach(() => {
    vi.clearAllMocks()
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('throws on service startup command failure', async () => {
    mockExec.mockRejectedValueOnce(new Error("The process '/usr/bin/bash' failed with exit code 1"))

    await expect(startServices(baseConfig, '/work'))
      .rejects.toThrow('Service startup failed — all subsequent tests will likely fail')
  })

  it('includes the failing command in the error message', async () => {
    const config = { ...baseConfig, targetSetupCommand: 'docker compose up -d bad-service' }
    mockExec.mockRejectedValueOnce(new Error('exit code 1'))

    await expect(startServices(config, '/work'))
      .rejects.toThrow('docker compose up -d bad-service')
  })

  it('preserves the original error as cause', async () => {
    const originalErr = new Error('exit code 1')
    mockExec.mockRejectedValueOnce(originalErr)

    try {
      await startServices(baseConfig, '/work')
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).cause).toBe(originalErr)
    }
  })

  it('skips startup when skipTargetSetup is true', async () => {
    const config = { ...baseConfig, skipTargetSetup: true }

    await startServices(config, '/work')

    expect(mockExec).not.toHaveBeenCalled()
  })

  it('succeeds when startup and health check both pass', async () => {
    // startup command succeeds, health check succeeds
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    await expect(startServices(baseConfig, '/work')).resolves.toBeNull()
  })
})

describe('teardownServices', () => {
  const mockExec = vi.mocked(exec)

  beforeEach(() => {
    vi.clearAllMocks()
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('is a no-op when targetTeardownCommand is empty', async () => {
    const config = { ...baseConfig, targetTeardownCommand: '' }

    await teardownServices(config, '/work')

    expect(mockExec).not.toHaveBeenCalled()
  })

  it('skips teardown when skipTargetTeardown is true', async () => {
    const config = { ...baseConfig, targetTeardownCommand: 'docker compose down', skipTargetTeardown: true }

    await teardownServices(config, '/work')

    expect(mockExec).not.toHaveBeenCalled()
  })

  it('runs the teardown command successfully', async () => {
    const config = { ...baseConfig, targetTeardownCommand: 'docker compose down -v' }

    await teardownServices(config, '/work')

    expect(mockExec).toHaveBeenCalledWith('bash', ['-c', 'docker compose down -v'], { cwd: '/work' })
  })

  it('does not throw on command failure (non-fatal)', async () => {
    const config = { ...baseConfig, targetTeardownCommand: 'docker compose down' }
    mockExec.mockRejectedValueOnce(new Error('exit code 1'))

    await expect(teardownServices(config, '/work')).resolves.toBeUndefined()
  })
})

describe('parseTargetDeploymentDetails', () => {
  it('returns null when stdout is empty', () => {
    expect(parseTargetDeploymentDetails('')).toBeNull()
  })

  it('returns parsed JSON when last line has top-level baseUrl', () => {
    const stdout = 'Starting services...\nReady.\n{"baseUrl": "http://52.11.18.47:8000"}\n'
    const result = parseTargetDeploymentDetails(stdout)
    expect(result).toEqual({ baseUrl: 'http://52.11.18.47:8000' })
  })

  it('returns parsed JSON with services map for multi-service output', () => {
    const json = JSON.stringify({
      services: {
        backend: { baseUrl: 'http://52.11.18.47:8000' },
        frontend: { baseUrl: 'http://52.11.18.47:5173' },
      },
    })
    expect(parseTargetDeploymentDetails(json)).toEqual({
      services: {
        backend: { baseUrl: 'http://52.11.18.47:8000' },
        frontend: { baseUrl: 'http://52.11.18.47:5173' },
      },
    })
  })

  it('returns null when stdout is not JSON', () => {
    expect(parseTargetDeploymentDetails('Services started successfully')).toBeNull()
  })

  it('returns null when JSON is an array', () => {
    expect(parseTargetDeploymentDetails('[1, 2, 3]')).toBeNull()
  })

  it('ignores non-JSON log lines before final JSON line', () => {
    const stdout = [
      'Pulling images...',
      'Container api started',
      'Health check passed',
      '{"baseUrl": "http://10.0.0.1:3000"}',
    ].join('\n')
    expect(parseTargetDeploymentDetails(stdout)).toEqual({ baseUrl: 'http://10.0.0.1:3000' })
  })

  it('handles trailing empty lines', () => {
    const stdout = '{"baseUrl": "http://localhost:8000"}\n\n\n'
    expect(parseTargetDeploymentDetails(stdout)).toEqual({ baseUrl: 'http://localhost:8000' })
  })
})

describe('setup output baseUrl overrides', () => {
  it('top-level baseUrl applies to all services', () => {
    const services = [
      { serviceName: 'api', baseUrl: 'http://localhost:8000' },
      { serviceName: 'worker', baseUrl: 'http://localhost:9000' },
    ]
    const setupOutput: TargetDeploymentDetails = { baseUrl: 'http://52.11.18.47:8000' }

    for (const svc of services) {
      const svcOverride = setupOutput.services?.[svc.serviceName]
      const newBaseUrl = svcOverride?.baseUrl ?? setupOutput.baseUrl
      if (newBaseUrl && svc.baseUrl) svc.baseUrl = newBaseUrl
    }

    expect(services[0].baseUrl).toBe('http://52.11.18.47:8000')
    expect(services[1].baseUrl).toBe('http://52.11.18.47:8000')
  })

  it('per-service override applies only to matching service', () => {
    const services = [
      { serviceName: 'backend', baseUrl: 'http://localhost:8000' },
      { serviceName: 'frontend', baseUrl: 'http://localhost:5173' },
    ]
    const setupOutput: TargetDeploymentDetails = {
      services: {
        backend: { baseUrl: 'http://52.11.18.47:8000' },
      },
    }

    for (const svc of services) {
      const svcOverride = setupOutput.services?.[svc.serviceName]
      const newBaseUrl = svcOverride?.baseUrl ?? setupOutput.baseUrl
      if (newBaseUrl && svc.baseUrl) svc.baseUrl = newBaseUrl
    }

    expect(services[0].baseUrl).toBe('http://52.11.18.47:8000')
    expect(services[1].baseUrl).toBe('http://localhost:5173')
  })

  it('per-service takes priority over top-level baseUrl', () => {
    const services = [
      { serviceName: 'backend', baseUrl: 'http://localhost:8000' },
      { serviceName: 'frontend', baseUrl: 'http://localhost:5173' },
    ]
    const setupOutput: TargetDeploymentDetails = {
      baseUrl: 'http://52.11.18.47:8000',
      services: {
        frontend: { baseUrl: 'http://52.11.18.47:5173' },
      },
    }

    for (const svc of services) {
      const svcOverride = setupOutput.services?.[svc.serviceName]
      const newBaseUrl = svcOverride?.baseUrl ?? setupOutput.baseUrl
      if (newBaseUrl && svc.baseUrl) svc.baseUrl = newBaseUrl
    }

    expect(services[0].baseUrl).toBe('http://52.11.18.47:8000')
    expect(services[1].baseUrl).toBe('http://52.11.18.47:5173')
  })
})
