import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exec } from '../utils'
import type { ActionInputs, ResolvedConfig } from '../types'

vi.mock('../utils', () => ({
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  sleep: vi.fn(),
  debug: vi.fn(),
  withGroup: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  withRetry: vi.fn(async (fn: () => Promise<unknown>, opts: { retries: number }) => {
    for (let attempt = 1; attempt <= opts.retries; attempt++) {
      try { return await fn() } catch (err) {
        if (attempt === opts.retries) throw err
      }
    }
  }),
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
  targetSetupCommand: 'echo ok',
  authTokenCommand: '',
  targetTeardownCommand: '',
  skipTargetTeardown: false,
  skyrampExecutorVersion: 'v1.3.15',
  skyrampMcpVersion: 'latest',
  skyrampMcpSource: 'npm',
  skyrampMcpGithubRef: '',
  nodeVersion: 'lts/*',
  skipTargetSetup: false,
  targetReadyCheckCommand: 'sleep 1',
  targetReadyCheckTimeout: 30,
  targetReadyCheckDiagnosticsCommand: 'docker ps',
  autoCommit: false,
  commitMessage: '',
  postPrComment: true,
  testExecutionTimeout: 300,
  testbotMaxRetries: 3,
  testbotRetryDelay: 10,
  testbotTimeout: 10,
  targetSetupRetries: 3,
  targetSetupRetryDelay: 10,
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
  targetSetupCommand: 'echo ok',
  authTokenCommand: '',
  targetTeardownCommand: '',
  skipTargetTeardown: false,
  skyrampExecutorVersion: 'v1.3.15',
  skyrampMcpVersion: 'latest',
  skyrampMcpSource: 'npm',
  skyrampMcpGithubToken: '',
  skyrampMcpGithubRef: '',
  nodeVersion: 'lts/*',
  skipTargetSetup: false,
  targetReadyCheckCommand: 'sleep 1',
  targetReadyCheckTimeout: 30,
  targetReadyCheckDiagnosticsCommand: 'docker ps',
  workingDirectory: '.',
  autoCommit: false,
  commitMessage: '',
  postPrComment: true,
  testExecutionTimeout: 300,
  testbotMaxRetries: 3,
  testbotRetryDelay: 10,
  testbotTimeout: 10,
  targetSetupRetries: 3,
  targetSetupRetryDelay: 10,
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

  it('installs npm packages in isolated temp dir, not repo working dir', async () => {
    const config = { ...baseConfig, skyrampMcpSource: 'npm' as const }

    await installMcp(config, baseInputs, '/tmp/skyramp')

    const npmInstallCall = mockExec.mock.calls.find(
      ([cmd, args]) => cmd === 'npm' && args?.[0] === 'install'
    )
    expect(npmInstallCall).toBeDefined()
    expect(npmInstallCall![2]).toMatchObject({ cwd: '/tmp/skyramp/mcp' })
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

  it('returns node command for npm source', async () => {
    const config = { ...baseConfig, skyrampMcpSource: 'npm' as const }

    const result = await installMcp(config, baseInputs, '/work')

    expect(result.command).toBe('node')
    expect(result.args).toContain('build/index.js')
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
      .rejects.toThrow("skyrampMcpGithubToken is required when skyrampMcpSource is 'github'")
  })

  it('retries npm install on transient failure and succeeds', async () => {
    const config = { ...baseConfig, skyrampMcpSource: 'npm' as const }

    let npmCallCount = 0
    mockExec.mockImplementation(async (cmd) => {
      if (cmd === 'npm') {
        npmCallCount++
        if (npmCallCount === 1) throw new Error('502 Bad Gateway')
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await expect(installMcp(config, baseInputs, '/work')).resolves.toBeDefined()
    expect(npmCallCount).toBe(2)
  })

  it('retries github clone on transient failure and succeeds', async () => {
    const config = {
      ...baseConfig,
      skyrampMcpSource: 'github' as const,
      skyrampMcpGithubRef: 'main',
    }
    const inputs = { ...baseInputs, skyrampMcpGithubToken: 'ghp_test123' }

    let gitCloneCount = 0
    mockExec.mockImplementation(async (cmd, args) => {
      if (cmd === 'git' && args?.includes('clone')) {
        gitCloneCount++
        if (gitCloneCount === 1) throw new Error('Connection reset by peer')
      }
      if (cmd === 'git' && args?.includes('rev-parse')) {
        return { exitCode: 0, stdout: 'abc123\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await expect(installMcp(config, inputs, '/work')).resolves.toBeDefined()
    expect(gitCloneCount).toBe(2)
  })
})
