/**
 * Startup error classification, formatting, and reporting utilities.
 *
 * Centralises all logic for turning a raw setup-command failure into an
 * actionable PR comment: error pattern matching → human-readable summary →
 * fix suggestions → rendered Markdown.
 */

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown by `startServices` when the target setup command exits non-zero.
 * Carries the raw stdout/stderr so callers can include output in PR comments
 * without having to re-run the command.
 */
export class StartupError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stdout: string,
    public readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'StartupError'
  }
}

// ── Classification ────────────────────────────────────────────────────────────

export type StartupErrorKind =
  | 'PORT_CONFLICT'
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_AUTH_FAILURE'
  | 'DOCKER_UNAVAILABLE'
  | 'OOM_KILLED'
  | 'STALE_CONTAINER'
  | 'NETWORK_NOT_FOUND'
  | 'MISSING_FILE'
  | 'PERMISSION_DENIED'
  | 'COMMAND_NOT_FOUND'
  | 'APP_STARTUP_ERROR'
  | 'UNKNOWN'

export interface StartupErrorAnalysis {
  kind: StartupErrorKind
  summary: string
  fixes: string[]
}

interface ErrorPattern {
  pattern: RegExp
  kind: StartupErrorKind
  summary: string
  fixes: string[]
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    pattern: /port is already allocated|bind.*address already in use|address already in use/i,
    kind: 'PORT_CONFLICT',
    summary: 'A required port is already in use on the runner.',
    fixes: [
      'Add a `docker compose down` (or equivalent cleanup) step **before** your startup command.',
      'Find and stop the conflicting process: `lsof -i :<port> && kill <pid>`.',
      'Change the host port mapping in your `docker-compose.yml`.',
    ],
  },
  {
    pattern: /pull access denied|repository does not exist|manifest.*not found|manifest unknown/i,
    kind: 'IMAGE_NOT_FOUND',
    summary: 'A Docker image could not be pulled — the tag may not exist or the image may be private.',
    fixes: [
      'Verify the image name and tag in your `docker-compose.yml`.',
      'If the image is private, add a `docker login` step before startup.',
      'Build the image from source rather than pulling a pre-published tag.',
    ],
  },
  {
    pattern: /unauthorized.*authentication required|Login.*Required/i,
    kind: 'IMAGE_AUTH_FAILURE',
    summary: 'Docker registry authentication failed.',
    fixes: [
      'Add a `docker login` step using a registry token stored as a GitHub secret.',
      'Verify the registry credentials are correct and have not expired.',
    ],
  },
  {
    pattern: /Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock.*no such file/i,
    kind: 'DOCKER_UNAVAILABLE',
    summary: 'The Docker daemon is not reachable on the runner.',
    fixes: [
      'Ensure the runner has Docker installed and the daemon is running.',
      'For GitHub-hosted runners, use `ubuntu-latest` which ships with Docker.',
      'Check that no earlier step disables or uninstalls Docker.',
    ],
  },
  {
    pattern: /OOMKilled|exit code 137/i,
    kind: 'OOM_KILLED',
    summary: 'A container was killed because it exceeded the available memory.',
    fixes: [
      'Increase the container memory limit in `docker-compose.yml` (`mem_limit`).',
      'Use a larger GitHub Actions runner (e.g. `ubuntu-latest-8-cores`).',
      'Reduce the number of services started in parallel.',
    ],
  },
  {
    pattern: /container name.*is already in use|name.*already in use by container/i,
    kind: 'STALE_CONTAINER',
    summary: 'A container with the required name is already running from a previous workflow run.',
    fixes: [
      'Add `docker compose down` or `docker rm -f <name>` before your startup command.',
      'Use `docker compose up --force-recreate` to replace existing containers.',
    ],
  },
  {
    pattern: /network.*not found|network.*does not exist/i,
    kind: 'NETWORK_NOT_FOUND',
    summary: 'A Docker network referenced in the compose file does not exist.',
    fixes: [
      'Add the network definition to `docker-compose.yml` under the `networks:` key.',
      'Pre-create the network: `docker network create <name>`.',
    ],
  },
  {
    pattern: /no such file or directory/i,
    kind: 'MISSING_FILE',
    summary: 'A required file or directory was not found.',
    fixes: [
      'Verify all referenced paths exist and are committed to the repository.',
      'Check that the `workingDirectory` action input points to the correct location.',
      'Ensure the checkout step runs before the testbot step.',
    ],
  },
  {
    pattern: /permission denied/i,
    kind: 'PERMISSION_DENIED',
    summary: 'A permission denied error occurred during startup.',
    fixes: [
      'Make the startup script executable: `git update-index --chmod=+x <script>`.',
      'Check file and directory permissions in the repository.',
    ],
  },
  {
    pattern: /command not found|not found.*command/i,
    kind: 'COMMAND_NOT_FOUND',
    summary: 'A required command was not found on the runner.',
    fixes: [
      'Install the required tool in a step before the testbot step.',
      'Check that the command name is spelled correctly and is in `$PATH`.',
    ],
  },
  {
    // Python tracebacks, FastAPI/uvicorn, Node.js/Vite, JVM exceptions
    pattern: /Traceback \(most recent call last\)|NameError:|ImportError:|ModuleNotFoundError:|SyntaxError:|AttributeError:|IndentationError:|TypeError:|ValueError:|ReferenceError:|Application startup failed|Error: Cannot find module|Cannot find package|error during build:|✘ \[ERROR\]|\[plugin:vite:|Exception in thread "main"/i,
    kind: 'APP_STARTUP_ERROR',
    summary: 'The application crashed during startup due to a code error.',
    fixes: [
      'Check the error line in the container logs above for the root cause.',
      'Run the container locally (`docker compose up`) to reproduce and debug.',
      'Ensure all dependencies are installed and the code is free of syntax errors.',
    ],
  },
]

/**
 * Match raw command output against known error patterns and return a
 * structured analysis.  Falls back to `UNKNOWN` when no pattern matches.
 */
export function analyzeStartupError(output: string): StartupErrorAnalysis {
  for (const { pattern, kind, summary, fixes } of ERROR_PATTERNS) {
    if (pattern.test(output)) {
      return { kind, summary, fixes }
    }
  }
  return {
    kind: 'UNKNOWN',
    summary: 'The startup command exited with a non-zero exit code.',
    fixes: [
      'Review the workflow logs for the root cause.',
      'Run the startup command locally to reproduce and debug the issue.',
      `Check that your \`targetSetupCommand\` is correct.`,
    ],
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Return the last `n` non-blank lines of `text`. */
export function lastLines(text: string, n: number): string {
  return text
    .split('\n')
    .filter(l => l.trim().length > 0)
    .slice(-n)
    .join('\n')
}

/**
 * Extract a window of lines around the crash point from diagnostics output.
 * Finds the first traceback / error marker and returns up to `maxLines` lines
 * starting a couple of lines before it, so the PR comment shows the relevant
 * section rather than the tail of the output (which may be unrelated logs).
 * Falls back to `lastLines(output, maxLines)` when no marker is found.
 */
export function extractCrashContext(output: string, maxLines = 25): string {
  const lines = output.split('\n')
  const CRASH_MARKERS = [
    /Traceback \(most recent call last\)/,
    /NameError:|ImportError:|ModuleNotFoundError:|SyntaxError:|AttributeError:|IndentationError:|TypeError:|ValueError:|ReferenceError:/,
    /Application startup failed/,
    /Error: Cannot find module/,
    /Exception in thread "main"/,
    /✘ \[ERROR\]|error during build:/,
  ]

  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (CRASH_MARKERS.some(p => p.test(lines[i]))) {
      startIdx = i
      break
    }
  }

  if (startIdx === -1) {
    // No known crash marker — look for any line containing error/exception/failed keywords.
    // This surfaces useful diagnostics even when the exact pattern isn't in CRASH_MARKERS,
    // rather than showing healthy infra logs (Redis, otel-collector) at the tail.
    const GENERIC_ERROR = /\b(error|exception|failed|fatal)\b/i
    for (let i = 0; i < lines.length; i++) {
      if (GENERIC_ERROR.test(lines[i])) {
        startIdx = i
        break
      }
    }
  }

  if (startIdx === -1) return lastLines(output, maxLines)

  // Scan forward from the error line to find where unrelated infra logs begin:
  // timestamp-prefixed otel/container lines, docker ps headers, or section separators.
  // Cap the forward scan at maxLines so we never dump the entire file when no
  // boundary is found (e.g. diagnostics command omits docker ps / section headers).
  const INFRA_LOG = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}|^--- logs |^NAMES\s/
  const forwardLimit = Math.min(lines.length, startIdx + maxLines)
  let errorSectionEnd = startIdx + 1
  while (errorSectionEnd < forwardLimit && !INFRA_LOG.test(lines[errorSectionEnd])) {
    errorSectionEnd++
  }

  // Fill the remaining line budget with context before the error line.
  const afterCount = errorSectionEnd - startIdx
  const contextBefore = Math.max(0, maxLines - afterCount)
  const from = Math.max(0, startIdx - contextBefore)
  return lines.slice(from, errorSectionEnd).join('\n').trim()
}

/**
 * Extract the most descriptive error line from app crash output.
 * Returns the first line matching a known error prefix, e.g. `NameError: name 'X' is not defined`.
 * Falls back to an empty string if no line matches.
 */
export function extractAppErrorLine(output: string): string {
  const ERROR_LINE = /^\s*((?:NameError|ImportError|ModuleNotFoundError|SyntaxError|AttributeError|IndentationError|TypeError|ValueError|RuntimeError|KeyError|FileNotFoundError|OSError|ReferenceError|Error): .+)/m
  const m = ERROR_LINE.exec(output)
  return m ? m[1].trim() : ''
}

/**
 * Render a Markdown PR comment body for a startup failure.
 *
 * Includes: error summary, collapsible raw output (last 10 lines), fix
 * suggestions, and a link to the full workflow run log.
 */
export function formatStartupFailureComment(opts: {
  command: string
  stdout: string
  stderr: string
  analysis: StartupErrorAnalysis
  workflowUrl: string
}): string {
  const { command, stdout, stderr, analysis, workflowUrl } = opts

  // Prefer stderr (more useful for diagnosis), fall back to stdout
  const rawOutput = [stderr, stdout].filter(s => s.trim()).join('\n').trim()
  const tail = rawOutput ? lastLines(rawOutput, 10) : ''

  const outputSection = tail
    ? [
      '',
      '<details>',
      '<summary>Debug logs for Service deployment failure</summary>',
      '',
      '```',
      tail,
      '```',
      '</details>',
      '',
    ].join('\n')
    : '\n'

  const fixList = analysis.fixes.map(f => `- ${f}`).join('\n')

  return [
    '### :x: Skyramp Testbot — Service Startup Failed',
    '',
    `**Command:** \`${command}\``,
    '',
    `**Error:** ${analysis.summary}`,
    '',
    '> **Check if the code changes in this PR are causing this failure** — a newly introduced bug, missing dependency, or broken configuration can prevent the service from starting.',
    outputSection,
    '**How to fix:**',
    fixList,
    '',
    `[View full workflow logs ↗](${workflowUrl})`,
  ].join('\n')
}
