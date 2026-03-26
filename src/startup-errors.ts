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
    outputSection,
    '**How to fix:**',
    fixList,
    '',
    `[View full workflow logs ↗](${workflowUrl})`,
  ].join('\n')
}
