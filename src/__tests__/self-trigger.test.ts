import './mocks/core'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockContext, mockExec } = vi.hoisted(() => ({
  mockContext: {
    payload: {} as Record<string, unknown>,
    eventName: 'pull_request',
    repo: { owner: 'test', repo: 'test' },
  },
  mockExec: vi.fn(),
}))

vi.mock('@actions/github', () => ({
  context: mockContext,
}))

vi.mock('../utils', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}))

import { checkSelfTrigger } from '../self-trigger'

beforeEach(() => {
  vi.clearAllMocks()
  mockContext.payload = {}
  mockContext.eventName = 'pull_request'
})

describe('checkSelfTrigger', () => {
  it('detects self-trigger from push event head_commit', async () => {
    mockContext.payload = {
      head_commit: {
        author: { name: 'Skyramp Testbot', email: 'test-bot@skyramp.dev' },
      },
    }

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(true)
    expect(result.botName).toBe('Skyramp Testbot')
    expect(result.botEmail).toBe('test-bot@skyramp.dev')
    // Should NOT fall back to git log when head_commit is present
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('does not skip when push event author differs', async () => {
    mockContext.payload = {
      head_commit: {
        author: { name: 'Jane Developer', email: 'jane@example.com' },
      },
    }

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(false)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('falls back to git log for pull_request events using PR head SHA', async () => {
    mockContext.payload = {
      pull_request: {
        head: { sha: 'abc123def' },
      },
    }
    mockExec
      .mockResolvedValueOnce({ stdout: 'Skyramp Testbot', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'test-bot@skyramp.dev', stderr: '', exitCode: 0 })

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(true)
    // Should use the PR head SHA, not HEAD
    expect(mockExec).toHaveBeenCalledWith(
      'git', ['log', '-1', '--pretty=format:%an', 'abc123def'], { silent: true }
    )
    expect(mockExec).toHaveBeenCalledWith(
      'git', ['log', '-1', '--pretty=format:%ae', 'abc123def'], { silent: true }
    )
  })

  it('does not skip when pull_request author differs', async () => {
    mockContext.payload = {
      pull_request: {
        head: { sha: 'abc123def' },
      },
    }
    mockExec
      .mockResolvedValueOnce({ stdout: 'Human Developer', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'human@example.com', stderr: '', exitCode: 0 })

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(false)
  })

  it('falls back to HEAD when no PR head SHA and no head_commit', async () => {
    mockContext.payload = {}
    mockExec
      .mockResolvedValueOnce({ stdout: 'Someone', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'someone@example.com', stderr: '', exitCode: 0 })

    await checkSelfTrigger()
    expect(mockExec).toHaveBeenCalledWith(
      'git', ['log', '-1', '--pretty=format:%an', 'HEAD'], { silent: true }
    )
  })

  it('requires BOTH name AND email to match for skip', async () => {
    // Name matches but email differs
    mockContext.payload = {
      head_commit: {
        author: { name: 'Skyramp Testbot', email: 'someone-else@example.com' },
      },
    }

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(false)
  })

  it('handles head_commit with missing email gracefully', async () => {
    mockContext.payload = {
      head_commit: {
        author: { name: 'Skyramp Testbot' },
      },
    }

    const result = await checkSelfTrigger()
    // Email defaults to '' which doesn't match 'test-bot@skyramp.dev'
    expect(result.skip).toBe(false)
  })

  it('always returns botName and botEmail constants', async () => {
    mockContext.payload = {}
    mockExec
      .mockResolvedValueOnce({ stdout: 'Anyone', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'any@example.com', stderr: '', exitCode: 0 })

    const result = await checkSelfTrigger()
    expect(result.botName).toBe('Skyramp Testbot')
    expect(result.botEmail).toBe('test-bot@skyramp.dev')
  })

  it('does not skip for workflow_dispatch even when HEAD is a bot commit', async () => {
    mockContext.eventName = 'workflow_dispatch'
    mockContext.payload = {}
    mockExec
      .mockResolvedValueOnce({ stdout: 'Skyramp Testbot', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'test-bot@skyramp.dev', stderr: '', exitCode: 0 })

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(false)
  })

  it('does not skip for workflow_dispatch with bot head_commit', async () => {
    mockContext.eventName = 'workflow_dispatch'
    mockContext.payload = {
      head_commit: {
        author: { name: 'Skyramp Testbot', email: 'test-bot@skyramp.dev' },
      },
    }

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(false)
  })

  it('skips for pull_request events with bot commit', async () => {
    mockContext.eventName = 'pull_request'
    mockContext.payload = {
      pull_request: { head: { sha: 'abc123' } },
    }
    mockExec
      .mockResolvedValueOnce({ stdout: 'Skyramp Testbot', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'test-bot@skyramp.dev', stderr: '', exitCode: 0 })

    const result = await checkSelfTrigger()
    expect(result.skip).toBe(true)
  })
})
