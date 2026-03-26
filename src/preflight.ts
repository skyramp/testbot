import * as fs from 'fs'
import * as core from '@actions/core'
import { load as parseYaml } from 'js-yaml'
import type { PreflightIssue, PreflightIssueKind, PreflightResult, TargetDeploymentDetails, WorkspaceServiceInfo } from './types'
import { withGroup, debug, abortAfter } from './utils'

const PROBE_TIMEOUT_MS = 5_000
const MAX_ENDPOINTS = 3

// ── Endpoint extraction ───────────────────────────────────────────────────────

/**
 * Extract candidate API route paths from the added lines of a git diff.
 *
 * Looks for quoted path strings on lines beginning with `+` that look like
 * API routes (contain a `/` separator, no route parameters).  Returns paths
 * sorted shallowest-first (collection/list endpoints before item endpoints)
 * so the probe targets the most likely "does this exist?" endpoint first.
 *
 * Best-effort and framework-agnostic: covers Express, FastAPI, NestJS/n8n
 * decorators, Spring, and plain string literals.  Returns [] when nothing
 * looks like a new route — callers must skip the check gracefully.
 */
export function extractEndpointsFromDiff(diffContent: string): string[] {
  const addedLines = diffContent
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))

  const candidates = new Set<string>()
  // Match any single- or double-quoted string that contains a `/`
  const pathLiteral = /['"`]([^'"`\s]*\/[^'"`\s]*)['"`]/g

  for (const line of addedLines) {
    // Reset lastIndex so the global RegExp starts at the beginning of each line
    pathLiteral.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pathLiteral.exec(line)) !== null) {
      const raw = m[1]
      // Ignore absolute URLs like "https://example.com/path"
      if (raw.includes('://')) continue
      // Require a leading `/` so we only consider route-like strings
      if (!raw.startsWith('/')) continue
      const path = raw
      // Skip route-param segments — probing them needs real IDs
      if (path.includes(':') || path.includes('{') || path.includes('*')) continue
      // Skip file-system-looking paths and version strings
      if (path.includes('..') || /\/v\d+\.\d+/.test(path)) continue
      // Skip obvious static assets / docs (images, html, markdown, etc.)
      if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|html?|md|txt|pdf)(\?|$)/i.test(path)) continue
      candidates.add(path)
    }
  }

  return [...candidates]
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, MAX_ENDPOINTS)
}

/**
 * Extract the set of changed file paths from the diff's file headers
 * (`diff --git a/<path> b/<path>`).
 *
 * Returns an empty set when the diff has no file headers (e.g. an empty diff),
 * in which case callers should fall back to probing all services.
 */
export function extractChangedPaths(diffContent: string): Set<string> {
  const paths = new Set<string>()
  const pattern = /^diff --git a\/(\S+)/gm
  let m: RegExpExecArray | null
  while ((m = pattern.exec(diffContent)) !== null) {
    paths.add(m[1])
  }
  return paths
}

/**
 * Derive the source root directory for a service from its workspace config.
 *
 * Uses the parent directory of `testDirectory` as a proxy for where the service's
 * source lives.  Falls back to `serviceName` for services that declare no
 * test directory.  Returns `null` for root-level services (testDirectory = "tests"
 * with no parent), which are treated as matching everything.
 *
 * Examples:
 *   testDirectory: "backend/tests"        → "backend"
 *   testDirectory: "services/auth/tests"  → "services/auth"
 *   testDirectory: "tests"                → null  (root-level, matches all)
 *   testDirectory: undefined              → serviceName
 */
export function deriveServiceSourceRoot(svc: { serviceName: string; testDirectory?: string }): string | null {
  if (!svc.testDirectory) return svc.serviceName
  const lastSlash = svc.testDirectory.lastIndexOf('/')
  if (lastSlash <= 0) return null  // root-level: "tests" or "test"
  return svc.testDirectory.slice(0, lastSlash)
}

/**
 * Return true when a service's source root is a path prefix of at least one
 * changed file in the diff.  Root-level services (no resolvable source root)
 * always match.
 */
export function serviceOwnsChangedPaths(
  svc: { serviceName: string; testDirectory?: string },
  changedPaths: Set<string>,
): boolean {
  const root = deriveServiceSourceRoot(svc)
  if (!root) return true  // root-level service — matches everything
  return [...changedPaths].some(p => p === root || p.startsWith(root + '/'))
}

// ── HTTP probing ──────────────────────────────────────────────────────────────

interface ProbeOutcome {
  statusCode: number   // 0 = unreachable
  error?: string
}

export async function probeUrl(url: string, authToken: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeOutcome> {
  const { signal, cancel } = abortAfter(timeoutMs)

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (authToken) {
    headers['Authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`
  }

  try {
    const res = await fetch(url, { method: 'GET', headers, signal })
    cancel()
    return { statusCode: res.status }
  } catch (err) {
    cancel()
    const msg = err instanceof Error ? err.message : String(err)
    return { statusCode: 0, error: msg.includes('abort') ? 'timeout' : msg }
  }
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Classify a probe result for a single endpoint.
 *
 * Returns a PreflightIssue when something is wrong, null when the endpoint
 * looks healthy enough to proceed.  The service is assumed to be reachable
 * (startServices health check already confirmed this before preflight runs).
 */
export function classifyProbe(
  path: string,
  outcome: ProbeOutcome,
): PreflightIssue | null {
  if (outcome.statusCode === 0) {
    return {
      kind: 'NOT_DEPLOYED',
      endpoint: path,
      message:
        `${path} is unreachable (${outcome.error ?? 'connection refused or timed out'}). ` +
        `The route may not be registered or the service may have stopped.`,
      recommendation:
        'Confirm the route is registered, the server restarted after the code change, ' +
        'and the service is still running.',
    }
  }

  const kind: PreflightIssueKind | null =
    outcome.statusCode === 404 ? 'STALE_IMAGE' :
    outcome.statusCode === 401 || outcome.statusCode === 403 ? 'AUTH_FAILURE' :
    outcome.statusCode >= 500 ? 'UNHEALTHY' :
    null

  if (!kind) return null   // 2xx, 201, 204, 400, 405, 422 — endpoint exists

  const messages: Record<PreflightIssueKind, string> = {
    STALE_IMAGE:
      `${path} returned 404. The endpoint was not found — the service may be running a stale image ` +
      `that does not include this route, or the auth layer may be returning 404 instead of 401/403.`,
    AUTH_FAILURE:
      `${path} returned ${outcome.statusCode}. The endpoint exists but the auth token is missing or invalid.`,
    UNHEALTHY:
      `${path} returned ${outcome.statusCode}. The endpoint exists but the service is returning server errors.`,
    NOT_DEPLOYED: '',   // handled above
  }

  const recommendations: Record<PreflightIssueKind, string> = {
    STALE_IMAGE:
      'If the route is newly added: rebuild and redeploy the service from the current branch source. ' +
      'If the service requires authentication: check that authTokenCommand produces a valid token — ' +
      'some APIs return 404 instead of 401/403 for unauthenticated requests.',
    AUTH_FAILURE:
      'Check that authTokenCommand produces a valid token with the required permissions.',
    UNHEALTHY:
      'Check service logs. The endpoint may have a startup or configuration problem.',
    NOT_DEPLOYED: '',
  }

  return { kind, endpoint: path, statusCode: outcome.statusCode, message: messages[kind], recommendation: recommendations[kind] }
}

// ── OpenAPI path resolution ───────────────────────────────────────────────────

/**
 * Match extracted diff segments against an OpenAPI path list, returning fully-
 * qualified paths.  Parameterised paths (containing `{`) are excluded since
 * they cannot be probed without a real ID.
 */
function matchSegmentsToSpecPaths(segments: string[], specPaths: string[]): string[] {
  const unparam = specPaths.filter(p => !p.includes('{'))
  const resolved = new Set<string>()
  for (const seg of segments) {
    for (const sp of unparam) {
      if (sp === seg || sp.endsWith(seg)) resolved.add(sp)
    }
  }
  return [...resolved].slice(0, MAX_ENDPOINTS)
}

/** Parse an OpenAPI spec (JSON or YAML) and return its `paths` keys, or null. */
function parseSpecPaths(raw: string): string[] | null {
  // Try JSON first (fast path for .json files / responses)
  let spec: { paths?: Record<string, unknown> } | null = null
  try {
    spec = JSON.parse(raw) as { paths?: Record<string, unknown> }
  } catch {
    // fall through to YAML
  }
  if (!spec) {
    try {
      spec = parseYaml(raw) as { paths?: Record<string, unknown> }
    } catch {
      return null
    }
  }
  if (!spec || typeof spec !== 'object') return null
  const paths = Object.keys(spec.paths ?? {})
  return paths.length > 0 ? paths : null
}

/**
 * Load an OpenAPI spec from a local file path or a remote URL and return
 * its path keys.  Supports both JSON and YAML formats.  Returns null when
 * unavailable or unparseable.
 */
async function loadSpecPaths(source: string, authToken: string): Promise<string[] | null> {
  // Local file path
  if (!source.startsWith('http://') && !source.startsWith('https://')) {
    try {
      const raw = fs.readFileSync(source, 'utf8')
      return parseSpecPaths(raw)
    } catch {
      return null
    }
  }

  // Remote URL
  const { signal, cancel } = abortAfter(3_000)
  const headers: Record<string, string> = { Accept: 'application/json, application/yaml, text/yaml, */*' }
  if (authToken) {
    headers['Authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`
  }
  try {
    const res = await fetch(source, { headers, signal })
    cancel()
    if (!res.ok) return null
    const raw = await res.text()
    return parseSpecPaths(raw)
  } catch {
    cancel()
    return null
  }
}

/**
 * Attempt to expand partial route segments (extracted from a diff) into full
 * paths by cross-referencing the service's OpenAPI spec.
 *
 * Resolution order:
 *   1. `schemaPath` from workspace.yml — a local file path or URL to the spec.
 *   2. `${baseUrl}/openapi.json`, `/openapi.yaml`, `/openapi.yml` — tried in order.
 *   3. Code-analysis heuristic — scans the diff for prefix declarations
 *      (e.g. `prefix="/products"`, `app.include_router(…, prefix="/api/v1")`)
 *      and composes candidate full paths from the prefix chain.
 *   4. LLM analysis — asks claude-haiku to reason over the diff and trace the
 *      full router prefix chain.  Only runs when `anthropicApiKey` is provided.
 *   5. Raw `segments` — returned unchanged if all resolution attempts fail.
 *
 * This handles frameworks like FastAPI where a method decorator only contains
 * the sub-path (`"/search"`) while the full path (`"/api/v1/products/search"`)
 * is composed at router-mount time and never appears in the diff.
 */
export async function resolvePathsViaOpenApi(
  baseUrl: string,
  segments: string[],
  authToken: string,
  opts: { schemaPath?: string; diffContent?: string; anthropicApiKey?: string } = {},
): Promise<string[]> {
  // 1. Try schemaPath from workspace.yml.
  //    Only attach the SUT auth token when the schema host matches the service base URL host.
  //    Sending credentials to a third-party domain would exfiltrate the secret.
  //    Local file paths (non-URL) are safe and always resolve without auth.
  if (opts.schemaPath) {
    let schemaAuth = authToken
    if (opts.schemaPath.startsWith('http://') || opts.schemaPath.startsWith('https://')) {
      try {
        const schemaHost = new URL(opts.schemaPath).host
        const baseHost = new URL(baseUrl).host
        if (schemaHost !== baseHost) schemaAuth = ''
      } catch {
        schemaAuth = ''
      }
    }
    const specPaths = await loadSpecPaths(opts.schemaPath, schemaAuth)
    if (specPaths) {
      const resolved = matchSegmentsToSpecPaths(segments, specPaths)
      if (resolved.length > 0) {
        debug(`Pre-flight: resolved ${segments.join(', ')} → ${resolved.join(', ')} via schemaPath`)
        return resolved
      }
    }
  }

  // 2. Try well-known OpenAPI spec URLs: .json first (FastAPI default), then .yaml / .yml
  for (const suffix of ['/openapi.json', '/openapi.yaml', '/openapi.yml']) {
    const specPaths = await loadSpecPaths(`${baseUrl}${suffix}`, authToken)
    if (specPaths) {
      const resolved = matchSegmentsToSpecPaths(segments, specPaths)
      if (resolved.length > 0) {
        debug(`Pre-flight: resolved ${segments.join(', ')} → ${resolved.join(', ')} via ${baseUrl}${suffix}`)
        return resolved
      }
    }
  }

  // 3. Code-analysis heuristic: extract prefix declarations from the full diff
  //    (context + added lines) and compose candidate full paths.
  if (opts.diffContent) {
    const resolved = resolvePathsFromCode(segments, opts.diffContent)
    if (resolved.length > 0) {
      debug(`Pre-flight: resolved ${segments.join(', ')} → ${resolved.join(', ')} via code analysis`)
      return resolved
    }
  }

  // 4. LLM analysis: ask claude-haiku to reason over the diff and trace the
  //    full router prefix chain.  Only runs when the Anthropic API key is available.
  if (opts.anthropicApiKey && opts.diffContent) {
    const resolved = await resolvePathsViaLlm(segments, opts.diffContent, opts.anthropicApiKey)
    if (resolved && resolved.length > 0) {
      debug(`Pre-flight: resolved ${segments.join(', ')} → ${resolved.join(', ')} via LLM`)
      return resolved
    }
  }

  return segments
}

/**
 * Ask an LLM (claude-haiku) to resolve partial route segments to full paths by
 * reasoning over the git diff, including context lines that contain router prefix
 * declarations not captured by the regex heuristic.
 *
 * This is the highest-fidelity fallback: the model understands framework-specific
 * mounting patterns (FastAPI include_router chains, NestJS module decorators,
 * Spring @RequestMapping, etc.) that static analysis cannot reliably cover.
 *
 * Called only when the `anthropicApiKey` is available and all cheaper resolution
 * strategies have already failed.  Times out after 15 s to avoid blocking the
 * preflight run.  Returns null on any error so the caller can fall through to
 * the raw-segments fallback.
 */
export async function resolvePathsViaLlm(
  segments: string[],
  diffContent: string,
  anthropicApiKey: string,
): Promise<string[] | null> {
  const prompt =
    `You are analyzing a git diff to determine the full HTTP API URL paths for newly added routes.\n\n` +
    `Route segments extracted from the diff (may be partial sub-paths):\n${segments.map(s => `  ${s}`).join('\n')}\n\n` +
    `Git diff (includes context lines with router setup):\n\`\`\`\n${diffContent.slice(0, 8_000)}\n\`\`\`\n\n` +
    `Instructions:\n` +
    `- Trace the full router prefix chain (e.g. app.include_router + APIRouter prefix + method decorator path).\n` +
    `- Return ONLY a JSON array of complete paths, e.g. ["/api/v1/products/search"].\n` +
    `- Exclude paths with route parameters ({id}, :id).\n` +
    `- If you cannot determine the full path for a segment, include it unchanged.\n` +
    `- Maximum ${MAX_ENDPOINTS} paths total.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) return null

    const data = await res.json() as { content: Array<{ type: string; text: string }> }
    const text = data.content.find(b => b.type === 'text')?.text ?? ''

    const match = text.match(/\[[\s\S]*?\]/)
    if (!match) return null

    const paths = JSON.parse(match[0]) as unknown
    if (!Array.isArray(paths)) return null

    return (paths as unknown[])
      .filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
      .filter(p => !p.includes('{') && !p.includes(':'))
      .slice(0, MAX_ENDPOINTS)
  } catch {
    return null
  }
}

/**
 * Scan all diff lines (context + added) for router prefix declarations and
 * compose candidate full paths by prepending discovered prefixes to each segment.
 *
 * Covers common patterns:
 *   - FastAPI:  `APIRouter(prefix="/products")`, `include_router(…, prefix="/api/v1")`
 *   - Express:  `app.use('/api', router)`
 *   - NestJS:   `@Controller('/products')`
 *
 * Only static prefixes are used — dynamic ones (containing `:` or `{`) are skipped.
 * Returns [] when no prefix declarations are found.
 */
export function resolvePathsFromCode(segments: string[], diffContent: string): string[] {
  // All lines (not just added) — context lines carry router setup that isn't changing
  const allLines = diffContent.split('\n').map(l =>
    l.startsWith('+') || l.startsWith('-') || l.startsWith(' ') ? l.slice(1) : l
  )

  const prefixes = new Set<string>()
  // Match prefix= / use( / @Controller( with a quoted path argument.
  // matchAll() is used instead of exec()-in-a-while-loop: matchAll internally clones
  // the regex so lastIndex is never mutated on the shared pattern object across lines.
  const prefixPattern = /(?:prefix\s*=\s*|\.use\s*\(\s*|@Controller\s*\(\s*)['"`](\/[^'"`{}:*\s]+)['"`]/g

  for (const line of allLines) {
    for (const m of line.matchAll(prefixPattern)) {
      prefixes.add(m[1].replace(/\/$/, ''))
    }
  }

  if (prefixes.size === 0) return []

  // Build candidate full paths: try all prefix combinations with each segment
  const candidates = new Set<string>()
  const prefixList = [...prefixes]

  for (const seg of segments) {
    // Direct prefix + segment
    for (const p of prefixList) {
      candidates.add(`${p}${seg}`)
    }
    // Two-level nesting: outer prefix + inner prefix + segment
    for (const outer of prefixList) {
      for (const inner of prefixList) {
        if (outer !== inner) candidates.add(`${outer}${inner}${seg}`)
      }
    }
  }

  // Keep only paths that look plausible (more than 2 segments, no duplication)
  return [...candidates]
    .filter(p => p.split('/').length > 2)
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, MAX_ENDPOINTS)
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Validate that the running SUT contains the endpoint changes introduced in the PR diff.
 *
 * Probes new route paths extracted from the diff against each service's base URL.
 * The service is assumed to be reachable — `startServices` confirms this via the
 * health check before `runPreflightCheck` is called.
 *
 * Skipped (returns ready=true, skipped=true) when:
 *   - No service base URLs are configured
 *   - The diff contains no extractable new routes
 */
export async function runPreflightCheck(opts: {
  /** Raw content of the git diff (caller is responsible for reading from disk). */
  diffContent: string
  services: WorkspaceServiceInfo[]
  authToken: string
  /** Anthropic API key — enables LLM-based path resolution as a final fallback. */
  anthropicApiKey?: string
  /**
   * Parsed JSON output of `targetSetupCommand`, when available.  Pre-flight uses
   * the deployment-reported URLs (service-specific or top-level baseUrl) as the
   * source of truth for which address each service is actually running on — these
   * take precedence over the static workspace.yml values, which may reflect a local
   * development address rather than the address the setup script brought up.
   */
  targetDeploymentDetails?: TargetDeploymentDetails | null
}): Promise<PreflightResult> {
  return withGroup('SUT pre-flight validation', async () => {
    const { diffContent, services, authToken, anthropicApiKey } = opts

    /**
     * Resolve the base URL for a service.
     *
     * Priority: deployment details (service-specific) → deployment details (top-level)
     * → workspace config.  This ensures probes always hit the address the setup
     * command actually brought up, not a potentially-stale workspace.yml value.
     */
    const resolveBaseUrl = (svc: WorkspaceServiceInfo): string | undefined => {
      const d = opts.targetDeploymentDetails
      if (d) {
        const svcUrl = d.services?.[svc.serviceName]?.baseUrl
        if (svcUrl) return svcUrl
        if (d.baseUrl) return d.baseUrl
      }
      return svc.baseUrl
    }

    const probeableServices = services.filter(svc => !!resolveBaseUrl(svc))
    if (probeableServices.length === 0) {
      core.info('No service base URLs configured — skipping pre-flight check')
      return { ready: true, skipped: true, issues: [], probedEndpoints: [] }
    }

    const endpoints = extractEndpointsFromDiff(diffContent)

    if (endpoints.length === 0) {
      core.info('No new API routes detected in diff — skipping pre-flight check')
      return { ready: true, skipped: true, issues: [], probedEndpoints: [] }
    }

    // Only probe services whose source root is a path prefix of a changed file.
    // Uses the full testDirectory-derived path (not just root segment) so that
    // services/auth and services/payment are correctly distinguished even though
    // they share the same top-level root.
    // Falls back to probing all services when the diff has no file headers.
    const changedPaths = extractChangedPaths(diffContent)
    const relevantServices = changedPaths.size === 0
      ? probeableServices
      : probeableServices.filter(svc => serviceOwnsChangedPaths(svc, changedPaths))

    if (relevantServices.length === 0) {
      core.info('No services match the changed files in diff — skipping pre-flight check')
      return { ready: true, skipped: true, issues: [], probedEndpoints: [] }
    }

    // Probe all relevant services concurrently.
    // Within each service: OpenAPI resolution → endpoint probes are sequential
    // (resolution must complete before probing), but the endpoint probes within
    // a service run concurrently via Promise.all.
    const serviceResults = await Promise.all(relevantServices.map(async svc => {
      const svcIssues: PreflightIssue[] = []
      const svcProbed: string[] = []
      const baseUrl = resolveBaseUrl(svc)!.replace(/\/$/, '')
      core.info(`Pre-flight: probing ${endpoints.length} new endpoint(s) against ${baseUrl}`)

      // Expand partial sub-paths (e.g. "/search") to full paths (e.g. "/api/v1/products/search").
      // Resolution order: schemaPath → baseUrl/openapi.json → code analysis → LLM → raw segments.
      const probePaths = await resolvePathsViaOpenApi(baseUrl, endpoints, authToken, {
        schemaPath: svc.schemaPath,
        diffContent,
        anthropicApiKey,
      })

      // Probe all resolved endpoints concurrently
      const probeResults = await Promise.all(probePaths.map(async path => {
        const url = `${baseUrl}${path}`
        const outcome = await probeUrl(url, authToken)
        return { path, url, outcome }
      }))

      for (const { path, url, outcome } of probeResults) {
        svcProbed.push(url)
        debug(`Pre-flight probe ${url}: ${outcome.statusCode}`)
        const issue = classifyProbe(path, outcome)
        if (issue) {
          svcIssues.push(issue)
          core.error(`Pre-flight [${issue.kind}]: ${issue.message}`)
        } else {
          core.notice(`Pre-flight: ${path} → ${outcome.statusCode} ✓`)
        }
      }

      return { svcIssues, svcProbed }
    }))

    const issues = serviceResults.flatMap(r => r.svcIssues)
    const probedEndpoints = serviceResults.flatMap(r => r.svcProbed)

    const ready = issues.length === 0

    if (ready) core.notice('SUT pre-flight check passed')

    return { ready, skipped: false, issues, probedEndpoints }
  })
}
