import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startServices, teardownServices } from '../services'
import { exec } from '../utils'
import type { ResolvedConfig } from '../types'

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

    await expect(startServices(baseConfig, '/work')).resolves.toBeUndefined()
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
