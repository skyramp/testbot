import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildPrompt, buildAgentCommand, installAgentCli } from '../agent'
import { exec } from '../utils'

vi.mock('../utils', () => ({
  exec: vi.fn(),
  sleep: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<void>) => fn()),
}))

describe('buildPrompt', () => {
  it('includes resource URI with all encoded params', () => {
    const prompt = buildPrompt({
      prTitle: 'Add product search',
      prBody: 'Implements search endpoint',
      testDirectory: 'tests/python',
      summaryPath: '/tmp/summary.json',
      authToken: 'Bearer abc123',
      repositoryPath: '/home/runner/work/repo',
    })

    expect(prompt).toContain('skyramp://prompts/testbot?')
    expect(prompt).toContain('prTitle=Add%20product%20search')
    expect(prompt).toContain('prDescription=Implements%20search%20endpoint')
    expect(prompt).toContain('testDirectory=tests%2Fpython')
    expect(prompt).toContain('summaryOutputFile=%2Ftmp%2Fsummary.json')
    expect(prompt).toContain('repositoryPath=%2Fhome%2Frunner%2Fwork%2Frepo')
  })

  it('includes auth token in AUTHENTICATION section', () => {
    const prompt = buildPrompt({
      prTitle: 'Test',
      prBody: '',
      testDirectory: 'tests',
      summaryPath: '/tmp/summary.json',
      authToken: 'tok-xyz',
      repositoryPath: '.',
    })

    expect(prompt).toContain('AUTHENTICATION:')
    expect(prompt).toContain('use this authentication token: tok-xyz')
  })

  it('handles empty auth token and empty description', () => {
    const prompt = buildPrompt({
      prTitle: 'Test',
      prBody: '',
      testDirectory: 'tests',
      summaryPath: '/tmp/summary.json',
      authToken: '',
      repositoryPath: '.',
    })

    expect(prompt).toContain('prDescription=&')
    expect(prompt).toContain('If the token is empty, pass an empty string')
  })

  it('includes service context for all services', () => {
    const prompt = buildPrompt({
      prTitle: 'Test',
      prBody: '',
      testDirectory: 'tests',
      summaryPath: '/tmp/summary.json',
      authToken: '',
      repositoryPath: '.',
      services: [
        {
          serviceName: 'api',
          language: 'python',
          framework: 'pytest',
          baseUrl: 'http://localhost:8000',
          outputDir: 'tests/python',
        },
        {
          serviceName: 'frontend',
          language: 'typescript',
          framework: 'playwright',
          baseUrl: 'http://localhost:3000',
          outputDir: 'tests/e2e',
        },
      ],
    })

    expect(prompt).toContain('<services>')
    expect(prompt).toContain('<service name="api">')
    expect(prompt).toContain('  <language>python</language>')
    expect(prompt).toContain('  <framework>pytest</framework>')
    expect(prompt).toContain('  <base_url>http://localhost:8000</base_url>')
    expect(prompt).toContain('  <output_dir>tests/python</output_dir>')
    expect(prompt).toContain('<service name="frontend">')
    expect(prompt).toContain('  <language>typescript</language>')
    expect(prompt).toContain('</services>')
  })

  it('omits service context when no services', () => {
    const prompt = buildPrompt({
      prTitle: 'Test',
      prBody: '',
      testDirectory: 'tests',
      summaryPath: '/tmp/summary.json',
      authToken: '',
      repositoryPath: '.',
      services: [],
    })

    expect(prompt).not.toContain('<services>')
    expect(prompt).not.toContain('<service')
  })

  it('only includes non-empty service fields', () => {
    const prompt = buildPrompt({
      prTitle: 'Test',
      prBody: '',
      testDirectory: 'tests',
      summaryPath: '/tmp/summary.json',
      authToken: '',
      repositoryPath: '.',
      services: [{
        serviceName: 'minimal',
        language: 'python',
      }],
    })

    expect(prompt).toContain('<service name="minimal">')
    expect(prompt).toContain('  <language>python</language>')
    expect(prompt).not.toContain('<framework>')
    expect(prompt).not.toContain('<base_url>')
    expect(prompt).not.toContain('<output_dir>')
  })
})

describe('buildAgentCommand', () => {
  it('returns cursor command', () => {
    const cmd = buildAgentCommand('cursor', false)
    expect(cmd.command).toBe('agent')
    expect(cmd.args).toEqual(['-f', '-p', '--model', 'sonnet-4.5'])
  })

  it('returns cursor command with debug flags', () => {
    const cmd = buildAgentCommand('cursor', true)
    expect(cmd.command).toBe('agent')
    expect(cmd.args).toContain('--output-format')
    expect(cmd.args).toContain('stream-json')
  })

  it('returns copilot command', () => {
    const cmd = buildAgentCommand('copilot', false)
    expect(cmd.command).toBe('copilot')
    expect(cmd.args).toContain('--additional-mcp-config')
    expect(cmd.args).toContain('--allow-all-tools')
    expect(cmd.args).toContain('--allow-all-paths')
    expect(cmd.args).toContain('-p')
  })

  it('copilot mcp config path has @ prefix', () => {
    const cmd = buildAgentCommand('copilot', false)
    const mcpIdx = cmd.args.indexOf('--additional-mcp-config')
    expect(cmd.args[mcpIdx + 1]).toMatch(/^@/)
  })
})

describe('installAgentCli', () => {
  const mockExec = vi.mocked(exec)

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.HOME = '/home/runner'
  })

  it('uses pipefail when installing cursor CLI', async () => {
    // First call: agent --version check (not installed)
    mockExec.mockRejectedValueOnce(new Error('not found'))
    // Second call: curl | bash install
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    // Third call: agent --version verification
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '1.0.0', stderr: '' })

    await installAgentCli('cursor')

    // The install command should use pipefail
    expect(mockExec).toHaveBeenCalledWith(
      'bash',
      ['-c', 'set -o pipefail; curl https://cursor.com/install -fsS | bash'],
    )
  })

  it('verifies agent binary exists after install', async () => {
    // First call: agent --version check (not installed)
    mockExec.mockRejectedValueOnce(new Error('not found'))
    // Second call: curl | bash install
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    // Third call: agent --version verification
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '1.0.0', stderr: '' })

    await installAgentCli('cursor')

    // Should verify the binary after install
    expect(mockExec).toHaveBeenCalledWith('agent', ['--version'], { silent: true })
  })

  it('propagates error when post-install verification fails', async () => {
    // First call: agent --version check (not installed)
    mockExec.mockRejectedValueOnce(new Error('not found'))
    // Second call: curl | bash succeeds (but binary not actually installed)
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    // Third call: agent --version verification fails
    mockExec.mockRejectedValueOnce(new Error('Unable to locate executable file: agent'))

    await expect(installAgentCli('cursor')).rejects.toThrow('Unable to locate executable file: agent')
  })

  it('skips install if cursor CLI already present', async () => {
    // agent --version succeeds
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '1.0.0', stderr: '' })

    await installAgentCli('cursor')

    // Should only have called exec once (the version check)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })
})
