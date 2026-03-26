import { describe, it, expect } from 'vitest'
import { StartupError, analyzeStartupError, formatStartupFailureComment, lastLines } from '../startup-errors'

// ── StartupError ──────────────────────────────────────────────────────────────

describe('StartupError', () => {
  it('is an instance of Error', () => {
    const err = new StartupError('msg', 'cmd', 'out', 'err')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('StartupError')
  })

  it('exposes command, stdout and stderr', () => {
    const err = new StartupError('failed', 'docker compose up', 'starting', 'port in use')
    expect(err.command).toBe('docker compose up')
    expect(err.stdout).toBe('starting')
    expect(err.stderr).toBe('port in use')
  })

  it('preserves the cause', () => {
    const cause = new Error('exit code 1')
    const err = new StartupError('failed', 'cmd', '', '', { cause })
    expect((err as Error & { cause: unknown }).cause).toBe(cause)
  })
})

// ── analyzeStartupError ───────────────────────────────────────────────────────

describe('analyzeStartupError', () => {
  const cases: Array<[string, string, string]> = [
    ['PORT_CONFLICT',       'port is already allocated',                      'port is already in use'],
    ['PORT_CONFLICT',       'bind: address already in use',                   'port is already in use'],
    ['IMAGE_NOT_FOUND',     'pull access denied for myimage',                 'tag may not exist'],
    ['IMAGE_NOT_FOUND',     'manifest for myimage:latest not found',          'tag may not exist'],
    ['IMAGE_NOT_FOUND',     'repository does not exist',                      'tag may not exist'],
    ['IMAGE_AUTH_FAILURE',  'unauthorized: authentication required',          'authentication failed'],
    ['DOCKER_UNAVAILABLE',  'Cannot connect to the Docker daemon',            'daemon is not reachable'],
    ['DOCKER_UNAVAILABLE',  'Is the docker daemon running?',                  'daemon is not reachable'],
    ['OOM_KILLED',          'OOMKilled',                                      'exceeded the available memory'],
    ['OOM_KILLED',          'exit code 137',                                  'exceeded the available memory'],
    ['STALE_CONTAINER',     "container name \"/api\" is already in use",      'already running'],
    ['NETWORK_NOT_FOUND',   'network mynet not found',                        'not exist'],
    ['MISSING_FILE',        'No such file or directory: docker-compose.yml',  'not found'],
    ['PERMISSION_DENIED',   'permission denied: ./start.sh',                  'permission denied'],
    ['COMMAND_NOT_FOUND',   'docker-compose: command not found',              'not found on the runner'],
  ]

  it.each(cases)('classifies %s from output %j', (kind, output, summarySnippet) => {
    const result = analyzeStartupError(output)
    expect(result.kind).toBe(kind)
    expect(result.summary.toLowerCase()).toContain(summarySnippet.toLowerCase())
    expect(result.fixes.length).toBeGreaterThan(0)
  })

  it('falls back to UNKNOWN for unrecognised output', () => {
    const result = analyzeStartupError('some completely unrecognised error')
    expect(result.kind).toBe('UNKNOWN')
    expect(result.fixes.length).toBeGreaterThan(0)
  })

  it('matches against combined stderr + stdout', () => {
    const result = analyzeStartupError('\npull access denied for myimage\n')
    expect(result.kind).toBe('IMAGE_NOT_FOUND')
  })
})

// ── lastLines ─────────────────────────────────────────────────────────────────

describe('lastLines', () => {
  it('returns the last n non-blank lines', () => {
    const text = 'a\nb\nc\nd\ne'
    expect(lastLines(text, 3)).toBe('c\nd\ne')
  })

  it('skips blank lines', () => {
    const text = 'a\n\nb\n\nc'
    expect(lastLines(text, 2)).toBe('b\nc')
  })

  it('returns all lines when fewer than n exist', () => {
    expect(lastLines('a\nb', 10)).toBe('a\nb')
  })

  it('returns empty string for blank input', () => {
    expect(lastLines('', 5)).toBe('')
  })
})

// ── formatStartupFailureComment ───────────────────────────────────────────────

describe('formatStartupFailureComment', () => {
  const base = {
    command: 'docker compose up -d',
    stdout: '',
    stderr: 'Error: port is already allocated',
    analysis: {
      kind: 'PORT_CONFLICT' as const,
      summary: 'A required port is already in use on the runner.',
      fixes: ['Stop conflicting process.', 'Add docker compose down.'],
    },
    workflowUrl: 'https://github.com/org/repo/actions/runs/123',
  }

  it('includes the command', () => {
    expect(formatStartupFailureComment(base)).toContain('docker compose up -d')
  })

  it('includes the error summary', () => {
    expect(formatStartupFailureComment(base)).toContain('A required port is already in use')
  })

  it('includes each fix suggestion', () => {
    const result = formatStartupFailureComment(base)
    expect(result).toContain('Stop conflicting process.')
    expect(result).toContain('Add docker compose down.')
  })

  it('includes the workflow URL', () => {
    expect(formatStartupFailureComment(base)).toContain('https://github.com/org/repo/actions/runs/123')
  })

  it('includes last output lines in a collapsible block', () => {
    const result = formatStartupFailureComment(base)
    expect(result).toContain('<details>')
    expect(result).toContain('port is already allocated')
  })

  it('omits the output block when both stdout and stderr are empty', () => {
    const result = formatStartupFailureComment({ ...base, stdout: '', stderr: '' })
    expect(result).not.toContain('<details>')
  })

  it('truncates to the last 10 lines of output', () => {
    const manyLines = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n')
    const result = formatStartupFailureComment({ ...base, stderr: manyLines })
    expect(result).toContain('line39')   // last line present
    expect(result).not.toContain('line0') // first line truncated
  })

  it('prefers stderr over stdout in the output block', () => {
    const result = formatStartupFailureComment({ ...base, stdout: 'stdout-only', stderr: 'stderr-content' })
    expect(result).toContain('stderr-content')
  })
})
