import * as fs from 'fs'
import * as core from '@actions/core'
import { load as parseYaml } from 'js-yaml'
import type { PreflightIssue, PreflightIssueKind, PreflightResult, TargetDeploymentDetails, WorkspaceServiceInfo } from './types'
import { withGroup, debug, abortAfter, sleep } from './utils'

const PROBE_TIMEOUT_MS = 5_000
const MAX_ENDPOINTS = 3
const PROBE_RETRIES = 3
const PROBE_RETRY_DELAY_S = 10

/**
 * Returns true when a probe status code warrants a retry.
 * Mirrors the non-null conditions in classifyProbe: 404, 401, 403, and any 5xx.
 * 2xx, 400, 405, 422, and other non-flagged 4xx codes are treated as stable
 * (the endpoint exists and responded deterministically) and are not retried.
 */
function isRetryableStatus(status: number): boolean {
  return status === 404 || status === 401 || status === 403 || status >= 500
}

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
 * decorators, Spring, Django, and plain string literals.
 *
 * Django `path()` strings lack a leading `/` and use `<type:name>` parameter
 * syntax.  When these are the only route additions in the diff (all paths are
 * parameterised and cannot be probed directly), the function returns `['/']`
 * so that the pre-flight check still runs a basic alive probe rather than
 * skipping entirely.  Returns `[]` only when nothing looks like a new route.
 */
export function extractEndpointsFromDiff(diffContent: string): string[] {
  const addedLines = diffContent
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))

  const candidates = new Set<string>()
  let hasRouteRegistrations = false
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
      // Detect Django-style angle-bracket path parameters (<type:name> or <name>).
      // Django path() strings also lack a leading `/`.  These are unambiguous route
      // registrations even though they cannot be probed directly without real values.
      if (/<\w+[:\w]*>/.test(raw)) {
        hasRouteRegistrations = true
        continue
      }
      // Require a leading `/` so we only consider route-like strings
      // Normalise Django-style relative paths inside path()/re_path() by
      // prepending a leading `/` so they become probeable candidates.
      let path = raw
      if (!path.startsWith('/')) {
        const isDjangoRouteContext = /\b(re_)?path\s*\(/.test(line)
        if (isDjangoRouteContext) {
          path = '/' + path
        }
      }
      // Require a leading `/` so we only consider route-like strings
      if (!path.startsWith('/')) continue
      // Parameterised paths (Express :id, FastAPI/OpenAPI {id}) can't be probed without
      // real values, but they still signal that this PR touches an API route.
      if (path.includes(':') || path.includes('{') || path.includes('*')) {
        hasRouteRegistrations = true
        continue
      }
      // Skip file-system-looking paths and version strings
      if (path.includes('..') || /\/v\d+\.\d+/.test(path)) continue
      // Skip obvious static assets / docs (images, html, markdown, etc.)
      if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|html?|md|txt|pdf)(\?|$)/i.test(path)) continue
      candidates.add(path)
    }
  }

  if (candidates.size > 0) {
    return [...candidates]
      .sort((a, b) => a.split('/').length - b.split('/').length)
      .slice(0, MAX_ENDPOINTS)
  }

  // Diff has route registrations (e.g. Django path() with <type:param> segments,
  // or Express/FastAPI routes with :id / {id} params) but no directly-probeable
  // static paths.  Return '/' so the pre-flight check performs a basic alive probe
  // instead of skipping the service entirely.
  if (hasRouteRegistrations) {
    return ['/']
  }

  return []
}

/**
 * Extract probe hints from parameterised route additions in the diff.
 *
 * When a PR only adds parameterised routes (e.g. `PUT "/{order_id}"`) there are
 * no directly-probeable static paths, but the service can still be validated by
 * probing the parent collection endpoint (e.g. `GET /api/v1/orders`).
 *
 * Returns:
 *   - The static stem before the first path parameter when the path has one
 *     (e.g. `"/users/{id}"` → `"/users"`).  OpenAPI / code-analysis resolution
 *     can expand the stem to the full collection path.
 *   - The raw parameterised literal when the parameter is the first segment
 *     (e.g. `"/{order_id}"`), so that LLM resolution can trace the router
 *     prefix chain and infer the collection endpoint.
 *
 * Returns `[]` when the diff contains no parameterised route additions.
 */
export function extractParamHintsFromDiff(diffContent: string): string[] {
  const addedLines = diffContent
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))

  const hints = new Set<string>()
  const pathLiteral = /['"`]([^'"`\s]*\/[^'"`\s]*)['"`]/g

  for (const line of addedLines) {
    pathLiteral.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pathLiteral.exec(line)) !== null) {
      const raw = m[1]
      if (raw.includes('://')) continue
      if (!raw.startsWith('/')) continue
      // Only interested in parameterised paths
      if (!raw.includes('{') && !raw.includes(':') && !raw.includes('*')) continue

      const segments = raw.split('/')
      const firstParamIdx = segments.findIndex(s => /[{:*]/.test(s))

      if (firstParamIdx > 1) {
        // e.g. "/orders/{id}" → "/orders",  "/api/v1/users/{id}" → "/api/v1/users"
        hints.add(segments.slice(0, firstParamIdx).join('/'))
      } else {
        // Bare param at position 1 (e.g. "/{order_id}") — keep the full literal
        // so that LLM resolution can trace the router prefix chain.
        hints.add(raw)
      }
    }
  }

  return [...hints].slice(0, MAX_ENDPOINTS)
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
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (authToken) {
    headers['Authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`
  }

  let lastOutcome: ProbeOutcome = { statusCode: 0 }

  for (let attempt = 0; attempt <= PROBE_RETRIES; attempt++) {
    if (attempt > 0) {
      debug(`Pre-flight: ${url} returned ${lastOutcome.statusCode}, retrying (${attempt}/${PROBE_RETRIES})...`)
      await sleep(PROBE_RETRY_DELAY_S)
    }

    const { signal, cancel } = abortAfter(timeoutMs)
    try {
      const res = await fetch(url, { method: 'GET', headers, signal })
      cancel()
      lastOutcome = { statusCode: res.status }
      if (!isRetryableStatus(res.status)) return lastOutcome
    } catch (err) {
      cancel()
      const msg = err instanceof Error ? err.message : String(err)
      return { statusCode: 0, error: msg.includes('abort') ? 'timeout' : msg }
    }
  }

  return lastOutcome
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

  // '/' is a pure reachability fallback used when the diff contains only
  // parameterised routes (e.g. Django <type:param>) that cannot be probed
  // directly.  Any HTTP response means the service is alive — a 404 or 401
  // on the root is normal for many APIs and must not be treated as a failure.
  if (path === '/') return null

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
      // endsWith only when seg is a meaningful sub-path (length > 1); a bare '/'
      // would otherwise match every trailing-slash path in the spec.
      if (sp === seg || (seg.length > 1 && sp.endsWith(seg))) resolved.add(sp)
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

  // Filter out any parameterised paths — they cannot be probed without real IDs.
  // This handles the case where hints like "/{order_id}" were passed in and all
  // resolution strategies failed to find the collection endpoint.
  return segments.filter(p => !p.includes('{') && !p.includes(':') && !p.includes('*'))
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
    `- Return ONLY a JSON array of complete, non-parameterised paths, e.g. ["/api/v1/orders"].\n` +
    `- If a segment is parameterised (e.g. "/{order_id}", "/users/{id}"), return the collection endpoint instead — the non-parameterised parent path resolved through the prefix chain (e.g. "/{order_id}" + prefix "/api/v1/orders" → "/api/v1/orders").\n` +
    `- Exclude all paths that still contain route parameters ({id}, :id) in the final result.\n` +
    `- If you cannot determine the full path for a segment, omit it.\n` +
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

    let endpoints = extractEndpointsFromDiff(diffContent)

    if (endpoints.length === 0) {
      // No static paths in the diff — check for parameterised routes (e.g. PUT "/{order_id}").
      // Derive stems or pass raw literals to OpenAPI/LLM resolution so we can probe
      // the parent collection endpoint instead of skipping entirely.
      const paramHints = extractParamHintsFromDiff(diffContent)
      if (paramHints.length === 0) {
        core.info('No new API routes detected in diff — skipping pre-flight check')
        return { ready: true, skipped: true, issues: [], probedEndpoints: [] }
      }
      debug(`Pre-flight: no static routes found; using ${paramHints.length} parameterised hint(s) to resolve collection endpoint(s)`)
      endpoints = paramHints
    } else if (endpoints.length === 1 && endpoints[0] === '/') {
      // extractEndpointsFromDiff returns ['/'] as a reachability fallback when the diff
      // has only parameterised routes (e.g. FastAPI PUT "/{order_id}"). Try to resolve
      // collection endpoints from param hints instead of just doing an alive probe.
      const paramHints = extractParamHintsFromDiff(diffContent)
      if (paramHints.length > 0) {
        debug(`Pre-flight: diff has only parameterised routes; using ${paramHints.length} hint(s) to resolve collection endpoint(s)`)
        endpoints = paramHints
      }
      // If no hints (e.g. pure Django diff without leading '/'), keep ['/'] for alive probe.
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

      // Safety filter: drop any path that still contains a route parameter after resolution
      // (e.g. "/{order_id}" when LLM was unavailable and no other strategy resolved it).
      const probeablePaths = probePaths.filter(p => !p.includes('{') && !p.includes(':') && !p.includes('*'))

      if (probeablePaths.length === 0) {
        // Resolution failed (e.g. bare "/{id}" with no spec and no LLM).
        // Fall back to a root alive-probe so unreachable services are still caught —
        // especially important when skipTargetSetup=true bypasses the health check.
        debug(`Pre-flight: ${svc.serviceName} — could not resolve parameterised hint(s); falling back to alive probe at /`)
        const outcome = await probeUrl(`${baseUrl}/`, authToken)
        svcProbed.push(`${baseUrl}/`)
        // classifyProbe returns null for '/' on any HTTP response (service is alive);
        // only a statusCode of 0 (unreachable) produces NOT_DEPLOYED.
        const issue = classifyProbe('/', outcome)
        if (issue) svcIssues.push(issue)
        return { svcIssues, svcProbed }
      }

      // Probe all resolved endpoints concurrently
      const probeResults = await Promise.all(probeablePaths.map(async path => {
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
