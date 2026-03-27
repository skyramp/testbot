import { describe, it, expect } from 'vitest'
import { StartupError, analyzeStartupError, formatStartupFailureComment, lastLines, extractAppErrorLine, extractCrashContext } from '../startup-errors'

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

  it('classifies APP_STARTUP_ERROR from a Python NameError traceback', () => {
    const output = [
      'Traceback (most recent call last):',
      '  File "main.py", line 10, in <module>',
      "NameError: name 'Redis' is not defined",
    ].join('\n')
    const result = analyzeStartupError(output)
    expect(result.kind).toBe('APP_STARTUP_ERROR')
    expect(result.summary).toContain('code error')
  })

  it('classifies APP_STARTUP_ERROR from a Python ImportError', () => {
    const result = analyzeStartupError("ImportError: cannot import name 'foo' from 'bar'")
    expect(result.kind).toBe('APP_STARTUP_ERROR')
  })

  it('classifies APP_STARTUP_ERROR from a Node.js module error', () => {
    const result = analyzeStartupError("Error: Cannot find module './config'")
    expect(result.kind).toBe('APP_STARTUP_ERROR')
  })

  it('classifies APP_STARTUP_ERROR from a JVM exception', () => {
    const result = analyzeStartupError('Exception in thread "main" java.lang.NullPointerException')
    expect(result.kind).toBe('APP_STARTUP_ERROR')
  })

  it('classifies APP_STARTUP_ERROR from uvicorn application startup failed', () => {
    const result = analyzeStartupError('ERROR:    Application startup failed. Exiting.')
    expect(result.kind).toBe('APP_STARTUP_ERROR')
  })

  it('classifies APP_STARTUP_ERROR from a Vite ReferenceError', () => {
    const result = analyzeStartupError('ReferenceError: document is not defined')
    expect(result.kind).toBe('APP_STARTUP_ERROR')
  })

  it('classifies APP_STARTUP_ERROR from a Vite build error', () => {
    const result = analyzeStartupError("error during build:\nReferenceError: window is not defined")
    expect(result.kind).toBe('APP_STARTUP_ERROR')
  })

  it('classifies APP_STARTUP_ERROR from a Vite plugin error', () => {
    const result = analyzeStartupError("[plugin:vite:css] Failed to resolve import 'styles.css'")
    expect(result.kind).toBe('APP_STARTUP_ERROR')
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

// ── extractAppErrorLine ───────────────────────────────────────────────────────

describe('extractAppErrorLine', () => {
  it('extracts a NameError line from a Python traceback', () => {
    const output = [
      'Traceback (most recent call last):',
      '  File "main.py", line 10, in <module>',
      "NameError: name 'Redis' is not defined",
    ].join('\n')
    expect(extractAppErrorLine(output)).toBe("NameError: name 'Redis' is not defined")
  })

  it('extracts an ImportError line', () => {
    const output = "ImportError: cannot import name 'foo'"
    expect(extractAppErrorLine(output)).toBe("ImportError: cannot import name 'foo'")
  })

  it('extracts an indented error line', () => {
    const output = "  TypeError: unsupported operand"
    expect(extractAppErrorLine(output)).toBe("TypeError: unsupported operand")
  })

  it('returns empty string when no known error prefix is found', () => {
    expect(extractAppErrorLine('some unrecognised error output')).toBe('')
  })
})

// ── extractCrashContext ───────────────────────────────────────────────────────

describe('extractCrashContext', () => {
  const redisLogs = Array.from({ length: 20 }, (_, i) => `redis log line ${i}`).join('\n')
  const traceback = [
    'Traceback (most recent call last):',
    '  File "main.py", line 10, in <module>',
    "NameError: name 'Redis' is not defined",
  ].join('\n')

  it('stops at the first timestamp-prefixed infra log after the error, not beyond', () => {
    // Mirrors the real demoshop file: NameError on line N, otel timestamps immediately after
    const otelLine = '2026-03-27T17:52:47.914Z\tinfo\tservice.go:241\tStarting otelcol...'
    const output = [
      '│ /api_insight/crud/orders.py:2 in <module>',
      '│   2 def update_order(cache: Redis, ...)',
      "NameError: name 'Redis' is not defined",
      otelLine,
      otelLine,
      otelLine,
    ].join('\n')
    const result = extractCrashContext(output, 20)
    expect(result).toContain('NameError')
    expect(result).not.toContain('Starting otelcol')
  })

  it('stops at --- logs section separators after the error', () => {
    const output = [
      'Traceback (most recent call last):',
      '  File "main.py", line 1',
      "NameError: name 'x' is not defined",
      '--- logs redis ---',
      ...Array.from({ length: 10 }, (_, i) => `redis log ${i}`),
    ].join('\n')
    const result = extractCrashContext(output, 20)
    expect(result).toContain('NameError')
    expect(result).not.toContain('redis log')
  })

  it('includes context lines before the error (fills budget backwards)', () => {
    const output = `context line A\ncontext line B\n${traceback}`
    const result = extractCrashContext(output, 25)
    expect(result).toContain('context line A')
    expect(result).toContain('Traceback')
  })

  it('matches on error line when no Traceback header is present', () => {
    const output = `some log\n${redisLogs}\nNameError: name 'x' is not defined\nmore logs`
    const result = extractCrashContext(output, 10)
    expect(result).toContain('NameError')
  })

  it('uses generic error keyword fallback when no CRASH_MARKER matches', () => {
    // Error buried before healthy infra logs — generic fallback must not show the tail
    const output = [
      '--- logs backend ---',
      'starting backend...',
      'connection failed: ECONNREFUSED 127.0.0.1:5432',
      'backend exited',
      '--- logs redis ---',
      ...Array.from({ length: 10 }, (_, i) => `redis log ${i}`),
    ].join('\n')
    const result = extractCrashContext(output, 10)
    expect(result).toContain('connection failed')
    // Stops at the --- logs redis --- separator, so no redis logs
    expect(result).not.toContain('redis log 9')
  })

  it('caps output to maxLines when no infra boundary is found after the error', () => {
    // No timestamps, no --- logs, no NAMES — boundary never fires
    const manyLinesAfter = Array.from({ length: 50 }, (_, i) => `extra line ${i}`).join('\n')
    const output = `NameError: name 'x' is not defined\n${manyLinesAfter}`
    const result = extractCrashContext(output, 10)
    const lineCount = result.split('\n').filter(l => l.trim()).length
    expect(lineCount).toBeLessThanOrEqual(10)
    expect(result).toContain('NameError')
  })

  it('falls back to lastLines when no crash marker or error keyword is found', () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const result = extractCrashContext(output, 5)
    expect(result).toContain('line 29')
    expect(result).not.toContain('line 0')
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
