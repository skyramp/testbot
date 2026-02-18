import './mocks/core'
import { describe, it, expect } from 'vitest'
import { buildPrompt, buildAgentCommand } from '../agent'

describe('buildPrompt', () => {
  it('includes all template fields', () => {
    const prompt = buildPrompt({
      prTitle: 'Add product search',
      prBody: 'Implements search endpoint',
      testDirectory: 'tests/python',
      summaryPath: '/tmp/summary.json',
      authToken: 'Bearer abc123',
    })

    expect(prompt).toContain('<title>Add product search</title>')
    expect(prompt).toContain('<description>Implements search endpoint</description>')
    expect(prompt).toContain('<test_directory>tests/python</test_directory>')
    expect(prompt).toContain('<summary_output_file>/tmp/summary.json</summary_output_file>')
    expect(prompt).toContain('<auth_token>Bearer abc123</auth_token>')
    expect(prompt).toContain('skyramp_testbot prompt')
  })

  it('includes auth token in AUTHENTICATION section', () => {
    const prompt = buildPrompt({
      prTitle: 'Test',
      prBody: '',
      testDirectory: 'tests',
      summaryPath: '/tmp/summary.json',
      authToken: 'tok-xyz',
    })

    expect(prompt).toContain('AUTHENTICATION:')
    expect(prompt).toContain('use this authentication token: tok-xyz')
  })

  it('handles empty auth token', () => {
    const prompt = buildPrompt({
      prTitle: 'Test',
      prBody: '',
      testDirectory: 'tests',
      summaryPath: '/tmp/summary.json',
      authToken: '',
    })

    expect(prompt).toContain('<auth_token></auth_token>')
    expect(prompt).toContain('If the token is empty, pass an empty string')
  })
})

describe('buildAgentCommand', () => {
  it('returns cursor command', () => {
    const cmd = buildAgentCommand('cursor', false)
    expect(cmd.command).toBe('agent')
    expect(cmd.args).toEqual(['-f', '-p', '--model', 'auto'])
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
