import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exec } from '../utils'
import type { ActionInputs, ResolvedConfig } from '../types'

vi.mock('../utils', () => ({
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  debug: vi.fn(),
  withGroup: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  secondsToMilliseconds: (s: number) => s * 1000,
}))

// mcp.ts uses `import * as fs from 'fs'` — mock via the resolved `node:` prefix
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ size: 100 }),
  },
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ size: 100 }),
}))

const baseConfig = {
  testDirectory: 'tests',
  serviceStartupCommand: 'echo ok',
  authTokenCommand: '',
  skyrampExecutorVersion: 'v1.3.3',
  skyrampMcpVersion: 'latest',
  skyrampMcpSource: 'npm',
  skyrampMcpGithubRef: '',
  nodeVersion: 'lts/*',
  skipServiceStartup: false,
  healthCheckCommand: 'sleep 1',
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
} satisfies ResolvedConfig

const baseInputs = {
  skyrampLicenseFile: 'license-content',
  cursorApiKey: '',
  copilotApiKey: '',
  anthropicApiKey: '',
  testDirectory: 'tests',
  serviceStartupCommand: 'echo ok',
  authTokenCommand: '',
  skyrampExecutorVersion: 'v1.3.3',
  skyrampMcpVersion: 'latest',
  skyrampMcpSource: 'npm',
  skyrampMcpGithubToken: '',
  skyrampMcpGithubRef: '',
  nodeVersion: 'lts/*',
  skipServiceStartup: false,
  healthCheckCommand: 'sleep 1',
  healthCheckTimeout: 30,
  healthCheckDiagnosticsCommand: 'docker ps',
  workingDirectory: '.',
  autoCommit: false,
  commitMessage: '',
  postPrComment: true,
  testExecutionTimeout: 300,
  testbotMaxRetries: 3,
  testbotRetryDelay: 10,
  testbotTimeout: 10,
  reportCollapsed: false,
  enableDebug: false,
} satisfies ActionInputs

describe('installMcp', () => {
  const mockExec = vi.mocked(exec)

  // Lazy-import so mocks are in place
  let installMcp: typeof import('../mcp')['installMcp']
  beforeEach(async () => {
    vi.clearAllMocks()
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const mod = await import('../mcp')
    installMcp = mod.installMcp
  })

  it('passes 3-minute timeout to npm install for npm source', async () => {
    const config = { ...baseConfig, skyrampMcpSource: 'npm' as const }

    await installMcp(config, baseInputs, '/work')

    const npmInstallCall = mockExec.mock.calls.find(
      ([cmd, args]) => cmd === 'npm' && args?.[0] === 'install'
    )
    expect(npmInstallCall).toBeDefined()
    expect(npmInstallCall![2]).toMatchObject({ timeout: 3 * 60 * 1000 })
  })

  it('passes 3-minute timeout to npm install for github source', async () => {
    const config = {
      ...baseConfig,
      skyrampMcpSource: 'github' as const,
      skyrampMcpGithubRef: 'develop',
    }
    const inputs = { ...baseInputs, skyrampMcpGithubToken: 'ghp_test123' }

    mockExec.mockImplementation(async (cmd, args) => {
      if (cmd === 'git' && args?.includes('rev-parse')) {
        return { exitCode: 0, stdout: 'abc123def\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await installMcp(config, inputs, '/work')

    const npmInstallCall = mockExec.mock.calls.find(
      ([cmd, args]) => cmd === 'npm' && args?.includes('install')
    )
    expect(npmInstallCall).toBeDefined()
    expect(npmInstallCall![2]).toMatchObject({ timeout: 3 * 60 * 1000 })
  })

  it('propagates timeout error from npm install', async () => {
    const config = { ...baseConfig, skyrampMcpSource: 'npm' as const }

    mockExec.mockImplementation(async (cmd) => {
      if (cmd === 'npm') {
        throw new Error('Command timed out after 3m: npm')
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await expect(installMcp(config, baseInputs, '/work'))
      .rejects.toThrow('Command timed out after 3m: npm')
  })

  it('returns npx command for npm source', async () => {
    const config = { ...baseConfig, skyrampMcpSource: 'npm' as const }

    const result = await installMcp(config, baseInputs, '/work')

    expect(result.command).toBe('npx')
    expect(result.args).toContain('@skyramp/mcp')
  })

  it('returns node command for github source', async () => {
    const config = {
      ...baseConfig,
      skyrampMcpSource: 'github' as const,
      skyrampMcpGithubRef: 'main',
    }
    const inputs = { ...baseInputs, skyrampMcpGithubToken: 'ghp_test123' }

    mockExec.mockImplementation(async (cmd, args) => {
      if (cmd === 'git' && args?.includes('rev-parse')) {
        return { exitCode: 0, stdout: 'abc123def\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    const result = await installMcp(config, inputs, '/work')

    expect(result.command).toBe('node')
    expect(result.args).toContain('build/index.js')
  })

  it('throws when github source missing token', async () => {
    const config = {
      ...baseConfig,
      skyrampMcpSource: 'github' as const,
      skyrampMcpGithubRef: 'develop',
    }

    await expect(installMcp(config, baseInputs, '/work'))
      .rejects.toThrow("skyramp_mcp_github_token is required when skyramp_mcp_source is 'github'")
  })
})
