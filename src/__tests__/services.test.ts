import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startServices } from '../services'
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
  serviceStartupCommand: 'docker compose up -d',
  authTokenCommand: '',
  skyrampExecutorVersion: 'v1.3.3',
  skyrampMcpVersion: 'latest',
  skyrampMcpSource: 'npm',
  skyrampMcpGithubRef: '',
  nodeVersion: 'lts/*',
  skipServiceStartup: false,
  healthCheckCommand: 'curl -f http://localhost:8000/health',
  healthCheckTimeout: 30,
  healthCheckDiagnosticsCommand: 'docker ps',
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
    const config = { ...baseConfig, serviceStartupCommand: 'docker compose up -d bad-service' }
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

  it('skips startup when skipServiceStartup is true', async () => {
    const config = { ...baseConfig, skipServiceStartup: true }

    await startServices(config, '/work')

    expect(mockExec).not.toHaveBeenCalled()
  })

  it('succeeds when startup and health check both pass', async () => {
    // startup command succeeds, health check succeeds
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    await expect(startServices(baseConfig, '/work')).resolves.toBeUndefined()
  })
})
