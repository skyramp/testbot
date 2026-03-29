import './mocks/core'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractEndpointsFromDiff, extractParamHintsFromDiff, extractChangedPaths, deriveServiceSourceRoot, serviceOwnsChangedPaths, classifyProbe, resolvePathsViaOpenApi, resolvePathsViaLlm, resolvePathsFromCode, runPreflightCheck } from '../preflight'
import type { WorkspaceServiceInfo } from '../types'

vi.mock('../utils', async () => {
  const actual = await vi.importActual<typeof import('../utils')>('../utils')
  return {
    ...actual,
    withGroup: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    debug: vi.fn(),
    sleep: vi.fn(async () => {}),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── extractEndpointsFromDiff ──────────────────────────────────────────────────

describe('extractEndpointsFromDiff', () => {
  it('returns empty array for empty diff', () => {
    expect(extractEndpointsFromDiff('')).toEqual([])
  })

  it('extracts paths from NestJS/n8n decorator style', () => {
    const diff = [
      "+@RestController('/scenario/cron')",
      "+  @Get()",
      "+  @Post()",
      "+  @Delete(':workflowId')",   // skipped — has route param
    ].join('\n')

    const result = extractEndpointsFromDiff(diff)
    expect(result).toContain('/scenario/cron')
    expect(result.some(p => p.includes(':workflowId'))).toBe(false)
  })

  it('extracts paths from Express router style', () => {
    const diff = [
      "+router.get('/api/items', handler)",
      "+router.post('/api/items', handler)",
      "+router.get('/api/items/:id', handler)",  // skipped — has route param
    ].join('\n')

    const result = extractEndpointsFromDiff(diff)
    expect(result).toContain('/api/items')
    expect(result.some(p => p.includes(':id'))).toBe(false)
  })

  it('extracts paths from FastAPI decorator style', () => {
    const diff = [
      '+@router.get("/api/v1/flows")',
      '+@router.post("/api/v1/flows")',
      '+@router.get("/api/v1/flows/{flow_id}")',  // skipped — has route param
    ].join('\n')

    const result = extractEndpointsFromDiff(diff)
    expect(result).toContain('/api/v1/flows')
    expect(result.some(p => p.includes('{flow_id}'))).toBe(false)
  })

  it('ignores lines not starting with +', () => {
    const diff = [
      " router.get('/api/items', handler)",   // context line
      "-router.get('/api/old', handler)",     // removed line
      "+router.get('/api/new', handler)",     // added line
    ].join('\n')

    const result = extractEndpointsFromDiff(diff)
    expect(result).toContain('/api/new')
    expect(result).not.toContain('/api/items')
    expect(result).not.toContain('/api/old')
  })

  it('sorts shallowest paths first', () => {
    const diff = [
      "+app.get('/api/v1/users/profile/settings', h)",
      "+app.get('/api/v1/users', h)",
      "+app.get('/api/v1/users/profile', h)",
    ].join('\n')

    const result = extractEndpointsFromDiff(diff)
    expect(result[0]).toBe('/api/v1/users')
    expect(result[1]).toBe('/api/v1/users/profile')
  })

  it('limits results to 3 endpoints', () => {
    const diff = Array.from({ length: 10 }, (_, i) => `+app.get('/api/route${i}', h)`).join('\n')
    expect(extractEndpointsFromDiff(diff).length).toBeLessThanOrEqual(3)
  })

  it('skips paths with glob wildcards', () => {
    const diff = "+app.use('/api/*', middleware)"
    expect(extractEndpointsFromDiff(diff).some(p => p.includes('*'))).toBe(false)
  })

  it('returns ["/"] for Django path() with only parameterised segments', () => {
    const diff = [
      '+    path(',
      '+        "workspaces/<str:slug>/projects/<uuid:project_id>/work-items/stats/",',
      '+        WorkItemStatsAPIEndpoint.as_view(http_method_names=["get"]),',
      '+        name="work-item-stats",',
      '+    ),',
    ].join('\n')
    expect(extractEndpointsFromDiff(diff)).toEqual(['/'])
  })

  it('returns static paths when Django diff also contains probeable routes', () => {
    const diff = [
      '+    path("workspaces/<str:slug>/work-items/stats/", StatsView.as_view()),',
      "+router.get('/api/health', handler)",
    ].join('\n')
    const result = extractEndpointsFromDiff(diff)
    expect(result).toContain('/api/health')
    expect(result).not.toContain('/')  // root fallback not used when static paths exist
  })
})

// ── extractParamHintsFromDiff ─────────────────────────────────────────────────

describe('extractParamHintsFromDiff', () => {
  it('returns empty array when no parameterised routes in diff', () => {
    expect(extractParamHintsFromDiff("+router.get('/api/items', h)")).toEqual([])
  })

  it('returns the stem before the first param segment', () => {
    const diff = "+@router.put(\"/orders/{order_id}\", h)"
    expect(extractParamHintsFromDiff(diff)).toContain('/orders')
  })

  it('returns stem for multi-segment paths with params', () => {
    const diff = "+@router.get('/api/v1/users/{user_id}', h)"
    expect(extractParamHintsFromDiff(diff)).toContain('/api/v1/users')
  })

  it('returns the raw literal for bare /{param} (no useful stem)', () => {
    const diff = "+@router.put(\"/{order_id}\", h)"
    const result = extractParamHintsFromDiff(diff)
    expect(result).toContain('/{order_id}')
  })

  it('handles colon-style params (:id)', () => {
    const diff = "+router.get('/users/:id', h)"
    expect(extractParamHintsFromDiff(diff)).toContain('/users')
  })

  it('returns empty array for lines not starting with +', () => {
    const diff = " router.put('/orders/{id}', h)"   // context line
    expect(extractParamHintsFromDiff(diff)).toEqual([])
  })

  it('deduplicates identical stems', () => {
    const diff = [
      "+@router.put(\"/orders/{order_id}\")",
      "+@router.delete(\"/orders/{order_id}\")",
    ].join('\n')
    const result = extractParamHintsFromDiff(diff)
    expect(result.filter(h => h === '/orders').length).toBe(1)
  })

  it('limits results to MAX_ENDPOINTS (3)', () => {
    const diff = [
      "+router.put('/a/{id}')",
      "+router.put('/b/{id}')",
      "+router.put('/c/{id}')",
      "+router.put('/d/{id}')",
    ].join('\n')
    expect(extractParamHintsFromDiff(diff).length).toBeLessThanOrEqual(3)
  })
})

// ── extractChangedPaths / deriveServiceSourceRoot / serviceOwnsChangedPaths ───

describe('extractChangedPaths', () => {
  it('extracts full file paths from diff --git headers', () => {
    const diff = [
      'diff --git a/backend/src/routers/product.py b/backend/src/routers/product.py',
      'diff --git a/backend/tests/test_product.py b/backend/tests/test_product.py',
    ].join('\n')
    const paths = extractChangedPaths(diff)
    expect(paths.has('backend/src/routers/product.py')).toBe(true)
    expect(paths.has('backend/tests/test_product.py')).toBe(true)
  })

  it('returns empty set for diff with no file headers', () => {
    expect(extractChangedPaths('')).toEqual(new Set())
    expect(extractChangedPaths('+some added line')).toEqual(new Set())
  })
})

describe('deriveServiceSourceRoot', () => {
  it('returns parent directory of testDirectory', () => {
    expect(deriveServiceSourceRoot({ serviceName: 'api', testDirectory: 'backend/tests' })).toBe('backend')
    expect(deriveServiceSourceRoot({ serviceName: 'auth', testDirectory: 'services/auth/tests' })).toBe('services/auth')
  })

  it('returns null for root-level testDirectory (no parent)', () => {
    expect(deriveServiceSourceRoot({ serviceName: 'api', testDirectory: 'tests' })).toBeNull()
  })

  it('falls back to serviceName when testDirectory is absent', () => {
    expect(deriveServiceSourceRoot({ serviceName: 'backend' })).toBe('backend')
  })
})

describe('serviceOwnsChangedPaths', () => {
  it('matches when a changed file is under the service source root', () => {
    const paths = new Set(['backend/src/routers/product.py'])
    expect(serviceOwnsChangedPaths({ serviceName: 'backend', testDirectory: 'backend/tests' }, paths)).toBe(true)
  })

  it('does not match a sibling service under the same top-level root', () => {
    const paths = new Set(['services/auth/src/user.py'])
    expect(serviceOwnsChangedPaths({ serviceName: 'payment', testDirectory: 'services/payment/tests' }, paths)).toBe(false)
  })

  it('matches correctly for deep nested services sharing a root', () => {
    const paths = new Set(['services/auth/src/user.py'])
    expect(serviceOwnsChangedPaths({ serviceName: 'auth', testDirectory: 'services/auth/tests' }, paths)).toBe(true)
  })

  it('always matches root-level services (testDirectory with no parent)', () => {
    const paths = new Set(['anywhere/file.py'])
    expect(serviceOwnsChangedPaths({ serviceName: 'api', testDirectory: 'tests' }, paths)).toBe(true)
  })
})

// ── classifyProbe ─────────────────────────────────────────────────────────────

describe('classifyProbe', () => {
  it('returns null (OK) for 200 on new endpoint', () => {
    expect(classifyProbe('/api/items', { statusCode: 200 })).toBeNull()
  })

  it('returns null (OK) for 201', () => {
    expect(classifyProbe('/api/items', { statusCode: 201 })).toBeNull()
  })

  it('returns null (OK) for 400 — endpoint exists even if request is bad', () => {
    expect(classifyProbe('/api/items', { statusCode: 400 })).toBeNull()
  })

  it('returns null (OK) for 405 — method not allowed means endpoint exists', () => {
    expect(classifyProbe('/api/items', { statusCode: 405 })).toBeNull()
  })

  it('returns STALE_IMAGE for 404', () => {
    const issue = classifyProbe('/api/cron', { statusCode: 404 })
    expect(issue?.kind).toBe('STALE_IMAGE')
    expect(issue?.statusCode).toBe(404)
    expect(issue?.endpoint).toBe('/api/cron')
  })

  it('returns AUTH_FAILURE for 401', () => {
    expect(classifyProbe('/api/cron', { statusCode: 401 })?.kind).toBe('AUTH_FAILURE')
  })

  it('returns AUTH_FAILURE for 403', () => {
    expect(classifyProbe('/api/cron', { statusCode: 403 })?.kind).toBe('AUTH_FAILURE')
  })

  it('returns UNHEALTHY for 500', () => {
    expect(classifyProbe('/api/cron', { statusCode: 500 })?.kind).toBe('UNHEALTHY')
  })

  it('returns UNHEALTHY for 503', () => {
    expect(classifyProbe('/api/cron', { statusCode: 503 })?.kind).toBe('UNHEALTHY')
  })

  it('returns NOT_DEPLOYED when endpoint is unreachable', () => {
    const issue = classifyProbe('/api/cron', { statusCode: 0, error: 'timeout' })
    expect(issue?.kind).toBe('NOT_DEPLOYED')
  })

  it('includes a non-empty recommendation for every issue kind', () => {
    const cases = [0, 404, 401, 500]
    for (const status of cases) {
      const issue = classifyProbe('/p', { statusCode: status })
      expect(issue?.recommendation).toBeTruthy()
    }
  })

  it('returns null (OK) for "/" with 404 — root alive-probe must not be classified as STALE_IMAGE', () => {
    expect(classifyProbe('/', { statusCode: 404 })).toBeNull()
  })

  it('returns null (OK) for "/" with 401 — root alive-probe must not be classified as AUTH_FAILURE', () => {
    expect(classifyProbe('/', { statusCode: 401 })).toBeNull()
  })

  it('returns null (OK) for "/" with 500 — root alive-probe must not be classified as UNHEALTHY', () => {
    expect(classifyProbe('/', { statusCode: 500 })).toBeNull()
  })

  it('returns NOT_DEPLOYED for "/" with statusCode 0 — unreachable service is always a failure', () => {
    expect(classifyProbe('/', { statusCode: 0, error: 'connection refused' })?.kind).toBe('NOT_DEPLOYED')
  })
})

// ── resolvePathsViaOpenApi ────────────────────────────────────────────────────

describe('resolvePathsViaOpenApi', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const spec = (paths: string[]) => ({
    ok: true,
    text: async () => JSON.stringify({ paths: Object.fromEntries(paths.map(p => [p, {}])) }),
  })

  const yamlSpec = (paths: string[]) => ({
    ok: true,
    text: async () => `paths:\n${paths.map(p => `  ${p}: {}`).join('\n')}\n`,
  })

  it('expands a partial segment to the full spec path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => spec(['/api/v1/products/search', '/api/v1/products'])))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '')
    expect(result).toContain('/api/v1/products/search')
  })

  it('falls back to raw segments when spec is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '')
    expect(result).toEqual(['/search'])
  })

  it('falls back to raw segments when no spec path matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => spec(['/api/v1/orders'])))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '')
    expect(result).toEqual(['/search'])
  })

  it('skips parameterised paths from the spec', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => spec(['/api/v1/products/{product_id}', '/api/v1/products/search'])))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '')
    expect(result).not.toContain('/api/v1/products/{product_id}')
    expect(result).toContain('/api/v1/products/search')
  })

  it('falls back gracefully when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/items'], '')
    expect(result).toEqual(['/items'])
  })

  it('passes Authorization header when authToken provided', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => spec([]))
    vi.stubGlobal('fetch', fetchSpy)
    await resolvePathsViaOpenApi('http://localhost:8000', ['/items'], 'tok')
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok')
  })

  it('resolves via baseUrl/openapi.yaml when .json returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/openapi.json')) return { ok: false, status: 404 }
      if (String(url).endsWith('/openapi.yaml')) return yamlSpec(['/api/v1/products/search'])
      return { ok: false, status: 404 }
    }))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '')
    expect(result).toContain('/api/v1/products/search')
  })

  it('resolves via baseUrl/openapi.yml when .json and .yaml both return 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/openapi.json')) return { ok: false, status: 404 }
      if (String(url).endsWith('/openapi.yaml')) return { ok: false, status: 404 }
      if (String(url).endsWith('/openapi.yml')) return yamlSpec(['/api/v1/items/list'])
      return { ok: false, status: 404 }
    }))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/list'], '')
    expect(result).toContain('/api/v1/items/list')
  })

  it('prefers schemaPath over baseUrl/openapi.json when provided', async () => {
    // schemaPath fetch returns the full path; baseUrl/openapi.json should not be called
    const fetchSpy = vi.fn(async (url: string) =>
      url.includes('custom-schema') ? spec(['/api/v1/items']) : spec(['/wrong/path'])
    )
    vi.stubGlobal('fetch', fetchSpy)
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/items'], '', {
      schemaPath: 'http://localhost:8000/custom-schema',
    })
    expect(result).toContain('/api/v1/items')
    // schemaPath was tried first and succeeded — baseUrl/openapi.json not needed
    expect(fetchSpy.mock.calls.length).toBe(1)
  })

  it('sends auth when schemaPath host matches baseUrl host', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => spec(['/api/v1/items']))
    vi.stubGlobal('fetch', fetchSpy)

    await resolvePathsViaOpenApi('http://localhost:8000', ['/items'], 'secret-token', {
      schemaPath: 'http://localhost:8000/schema.json',
    })

    const authHeader = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(authHeader['Authorization']).toContain('secret-token')
  })

  it('omits auth when schemaPath host differs from baseUrl host', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => spec(['/api/v1/items']))
    vi.stubGlobal('fetch', fetchSpy)

    await resolvePathsViaOpenApi('http://localhost:8000', ['/items'], 'secret-token', {
      schemaPath: 'https://external.example.com/openapi.json',
    })

    const authHeader = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(authHeader['Authorization']).toBeUndefined()
  })

  it('parses a YAML spec returned by a schemaPath URL', async () => {
    const yamlContent = 'paths:\n  /api/v1/products/search: {}\n  /api/v1/products: {}\n'
    const fetchSpy = vi.fn(async (url: string) =>
      url.includes('schema.yaml')
        ? { ok: true, text: async () => yamlContent }
        : { ok: false, status: 404 }
    )
    vi.stubGlobal('fetch', fetchSpy)

    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '', {
      schemaPath: 'http://localhost:8000/schema.yaml',
    })

    expect(result).toContain('/api/v1/products/search')
    // schemaPath succeeded — no fallback spec URLs needed
    expect(fetchSpy.mock.calls.length).toBe(1)
  })

  it('falls back to code analysis when spec unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    const diff = [
      ' router = APIRouter(prefix="/products")',
      ' app.include_router(router, prefix="/api/v1")',
      '+@router.get("/search")',
    ].join('\n')
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '', { diffContent: diff })
    expect(result.some(p => p.endsWith('/search'))).toBe(true)
    expect(result.some(p => p.split('/').length > 3)).toBe(true)
  })

  it('falls back to LLM when all other strategies fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('anthropic')) {
        return { ok: true, json: async () => ({ content: [{ type: 'text', text: '["/api/v1/products/search"]' }] }) }
      }
      return { ok: false, status: 503 }
    }))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '', {
      diffContent: '+@router.get("/search")',
      anthropicApiKey: 'test-key',
    })
    expect(result).toContain('/api/v1/products/search')
  })

  it('skips LLM when no anthropicApiKey provided', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 503 }))
    vi.stubGlobal('fetch', fetchSpy)
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/search'], '', {
      diffContent: '+@router.get("/search")',
      // no anthropicApiKey
    })
    // Should return raw segments; Anthropic API must not be called
    expect(result).toEqual(['/search'])
    expect(fetchSpy.mock.calls.every((c: unknown[]) => !String(c[0]).includes('anthropic'))).toBe(true)
  })

  it('does not resolve "/" to arbitrary OpenAPI paths that end with "/"', async () => {
    // '/' is the alive-probe fallback for parameterised-only diffs; it must pass
    // through unchanged so classifyProbe handles it as a reachability check.
    // Without the seg.length > 1 guard, sp.endsWith('/') matches every trailing-
    // slash path in the spec and the probe would hit a random endpoint instead.
    vi.stubGlobal('fetch', vi.fn(async () => spec([
      '/api/workspaces/',
      '/api/projects/',
      '/api/work-items/stats/',
    ])))
    const result = await resolvePathsViaOpenApi('http://localhost:8000', ['/'], '')
    expect(result).toEqual(['/'])
  })
})

// ── resolvePathsViaLlm ────────────────────────────────────────────────────────

describe('resolvePathsViaLlm', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const anthropicResponse = (text: string) => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  })

  it('parses a JSON array from the LLM response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicResponse('["/api/v1/products/search"]')))
    const result = await resolvePathsViaLlm(['/search'], 'diff content', 'test-key')
    expect(result).toEqual(['/api/v1/products/search'])
  })

  it('strips parameterised paths from LLM response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicResponse('["/api/v1/products/{id}", "/api/v1/products/search"]')))
    const result = await resolvePathsViaLlm(['/search'], 'diff', 'key')
    expect(result).not.toContain('/api/v1/products/{id}')
    expect(result).toContain('/api/v1/products/search')
  })

  it('returns null when API returns non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })))
    expect(await resolvePathsViaLlm(['/items'], 'diff', 'key')).toBeNull()
  })

  it('returns null when response contains no JSON array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicResponse('I cannot determine the path.')))
    expect(await resolvePathsViaLlm(['/items'], 'diff', 'key')).toBeNull()
  })

  it('returns null gracefully when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error') }))
    expect(await resolvePathsViaLlm(['/items'], 'diff', 'key')).toBeNull()
  })

  it('sends the Anthropic API key in the x-api-key header', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => anthropicResponse('[]'))
    vi.stubGlobal('fetch', fetchSpy)
    await resolvePathsViaLlm(['/items'], 'diff', 'my-secret-key')
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('my-secret-key')
  })
})

// ── resolvePathsFromCode ──────────────────────────────────────────────────────

describe('resolvePathsFromCode', () => {
  it('composes full paths from FastAPI prefix declarations in context lines', () => {
    const diff = [
      ' router = APIRouter(prefix="/products")',
      ' app.include_router(router, prefix="/api/v1")',
      '+@router.get("/search")',
    ].join('\n')
    const result = resolvePathsFromCode(['/search'], diff)
    expect(result.some(p => p.includes('/products') && p.endsWith('/search'))).toBe(true)
  })

  it('returns empty array when no prefix declarations found', () => {
    const diff = '+def some_function(): pass'
    expect(resolvePathsFromCode(['/search'], diff)).toEqual([])
  })

  it('skips dynamic prefixes containing path params', () => {
    const diff = ' app.use("/api/:version", router)\n+router.get("/items")'
    const result = resolvePathsFromCode(['/items'], diff)
    expect(result.every(p => !p.includes(':version'))).toBe(true)
  })
})

// ── runPreflightCheck ─────────────────────────────────────────────────────────

describe('runPreflightCheck', () => {
  const services: WorkspaceServiceInfo[] = [{ serviceName: 'api', baseUrl: 'http://localhost:8000' }]
  const CRON_DIFF = "+router.get('/api/cron', h)"

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // openapi spec requests return 404 (no spec) so they fall back to raw segments
  // without consuming a slot from the `responses` array.
  const isSpecUrl = (url: string) =>
    ['/openapi.json', '/openapi.yaml', '/openapi.yml'].some(s => String(url).endsWith(s))

  const mockFetch = (responses: Array<{ status: number }>) => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (isSpecUrl(url)) return { status: 404, ok: false }
      return { status: responses[call++]?.status ?? 200 }
    }))
  }

  it('skips when no service base URLs', async () => {
    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services: [], authToken: '' })
    expect(result.skipped).toBe(true)
    expect(result.ready).toBe(true)
  })

  it('skips when diff has no extractable routes', async () => {
    const result = await runPreflightCheck({ diffContent: '+ just some code without paths', services, authToken: '' })
    expect(result.skipped).toBe(true)
  })

  it('skips when diff content is empty', async () => {
    const result = await runPreflightCheck({ diffContent: '', services, authToken: '' })
    expect(result.skipped).toBe(true)
  })

  it('returns NOT_DEPLOYED and ready=false when endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(false)
    expect(result.issues[0].kind).toBe('NOT_DEPLOYED')
  })

  it('returns STALE_IMAGE and ready=false when endpoint → 404', async () => {
    mockFetch([{ status: 404 }, { status: 404 }, { status: 404 }, { status: 404 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(false)
    expect(result.issues.some(i => i.kind === 'STALE_IMAGE')).toBe(true)
  })

  it('returns AUTH_FAILURE issue and ready=false (blocking)', async () => {
    mockFetch([{ status: 401 }, { status: 401 }, { status: 401 }, { status: 401 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(false)
    expect(result.issues.some(i => i.kind === 'AUTH_FAILURE')).toBe(true)
  })

  it('returns UNHEALTHY issue and ready=false when all retries return 500', async () => {
    // PROBE_RETRIES = 3, so 4 calls total (1 initial + 3 retries)
    mockFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(false)
    expect(result.issues.some(i => i.kind === 'UNHEALTHY')).toBe(true)
  })

  it('returns STALE_IMAGE issue and ready=false when all retries return 404', async () => {
    mockFetch([{ status: 404 }, { status: 404 }, { status: 404 }, { status: 404 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(false)
    expect(result.issues.some(i => i.kind === 'STALE_IMAGE')).toBe(true)
  })

  it('returns AUTH_FAILURE issue and ready=false when all retries return 401', async () => {
    mockFetch([{ status: 401 }, { status: 401 }, { status: 401 }, { status: 401 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(false)
    expect(result.issues.some(i => i.kind === 'AUTH_FAILURE')).toBe(true)
  })

  it('returns ready=true when endpoint recovers from a transient 500 on retry', async () => {
    mockFetch([{ status: 500 }, { status: 200 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('returns ready=true when endpoint recovers from a transient 404 on retry', async () => {
    mockFetch([{ status: 404 }, { status: 200 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('returns ready=true and no issues when all endpoints → 200', async () => {
    mockFetch([{ status: 200 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.ready).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('records probed endpoint URLs', async () => {
    mockFetch([{ status: 200 }])

    const result = await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: '' })
    expect(result.probedEndpoints.some(u => u.includes('localhost:8000'))).toBe(true)
  })

  it('sends Authorization header when authToken provided', async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => ({
      status: 200,
      ...(isSpecUrl(String(url)) ? { ok: false } : {}),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    await runPreflightCheck({ diffContent: CRON_DIFF, services, authToken: 'my-token' })

    const calls = fetchSpy.mock.calls
    const headers = calls[calls.length - 1][1]?.headers as Record<string, string>
    expect(headers['Authorization']).toContain('my-token')
  })

  it('skips frontend service when diff only touches backend files', async () => {
    const multiServices: WorkspaceServiceInfo[] = [
      { serviceName: 'backend',  baseUrl: 'http://localhost:8000', testDirectory: 'backend/tests' },
      { serviceName: 'frontend', baseUrl: 'http://localhost:5173', testDirectory: 'frontend/tests' },
      // sibling service under same root — must also be excluded
      { serviceName: 'auth',     baseUrl: 'http://localhost:8001', testDirectory: 'services/auth/tests' },
    ]
    const diff = [
      'diff --git a/backend/src/routers/product.py b/backend/src/routers/product.py',
      "+router.get('/api/search', h)",
    ].join('\n')

    const fetchSpy = vi.fn(async (url: string) => ({
      status: 200,
      ok: !isSpecUrl(String(url)),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const result = await runPreflightCheck({ diffContent: diff, services: multiServices, authToken: '' })

    const probedUrls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(probedUrls.some(u => u.includes('localhost:5173'))).toBe(false)  // frontend excluded
    expect(probedUrls.some(u => u.includes('localhost:8001'))).toBe(false)  // auth (services/auth) excluded
    expect(probedUrls.some(u => u.includes('localhost:8000'))).toBe(true)   // backend probed
    expect(result.skipped).toBe(false)
  })


  // ── targetDeploymentDetails URL resolution ─────────────────────────────────

  it('uses top-level baseUrl from targetDeploymentDetails instead of workspace config', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      status: 200,
      ok: !isSpecUrl(String(url)),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    // Workspace says localhost:8000; deployment reports the actual remote address
    await runPreflightCheck({
      diffContent: CRON_DIFF,
      services: [{ serviceName: 'api', baseUrl: 'http://localhost:8000' }],
      authToken: '',
      targetDeploymentDetails: { baseUrl: 'http://52.11.18.47:8000' },
    })

    const probed = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(probed.some(u => u.startsWith('http://52.11.18.47:8000'))).toBe(true)
    expect(probed.some(u => u.startsWith('http://localhost:8000'))).toBe(false)
  })

  it('uses service-specific baseUrl from targetDeploymentDetails when present', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      status: 200,
      ok: !isSpecUrl(String(url)),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    await runPreflightCheck({
      diffContent: CRON_DIFF,
      services: [{ serviceName: 'backend', baseUrl: 'http://localhost:8000' }],
      authToken: '',
      targetDeploymentDetails: {
        baseUrl: 'http://fallback:8000',
        services: { backend: { baseUrl: 'http://10.0.0.5:8000' } },
      },
    })

    const probed = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    // Service-specific URL takes precedence over top-level baseUrl
    expect(probed.some(u => u.startsWith('http://10.0.0.5:8000'))).toBe(true)
    expect(probed.some(u => u.startsWith('http://fallback:8000'))).toBe(false)
    expect(probed.some(u => u.startsWith('http://localhost:8000'))).toBe(false)
  })

  it('falls back to workspace baseUrl when targetDeploymentDetails has no URL for service', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      status: 200,
      ok: !isSpecUrl(String(url)),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    await runPreflightCheck({
      diffContent: CRON_DIFF,
      services: [{ serviceName: 'api', baseUrl: 'http://localhost:8000' }],
      authToken: '',
      // deployment details present but no URL for this service, no top-level baseUrl
      targetDeploymentDetails: { services: { other: { baseUrl: 'http://10.0.0.5:9000' } } },
    })

    const probed = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(probed.some(u => u.startsWith('http://localhost:8000'))).toBe(true)
  })

  // ── parameterised-only diffs ───────────────────────────────────────────────

  it('probes the collection endpoint when diff only adds a parameterised route with a useful stem', async () => {
    // e.g. PUT "/orders/{order_id}" → stem "/orders" → resolves to /api/v1/orders via spec
    const paramDiff = [
      'diff --git a/backend/src/routers/orders.py b/backend/src/routers/orders.py',
      '+@router.put("/orders/{order_id}", response_model=OrderRead)',
    ].join('\n')
    const backendServices: WorkspaceServiceInfo[] = [
      { serviceName: 'backend', baseUrl: 'http://localhost:8000', testDirectory: 'backend/tests' },
    ]

    const specWithOrders = JSON.stringify({ paths: { '/api/v1/orders': {}, '/api/v1/orders/{order_id}': {} } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/openapi.json')) return { ok: true, text: async () => specWithOrders }
      return { status: 200 }
    }))

    const result = await runPreflightCheck({ diffContent: paramDiff, services: backendServices, authToken: '' })
    expect(result.skipped).toBe(false)
    expect(result.probedEndpoints.some(u => u.includes('/api/v1/orders'))).toBe(true)
    // The parameterised path itself must never be probed
    expect(result.probedEndpoints.some(u => u.includes('{'))).toBe(false)
  })

  it('falls back to alive probe at / when hints cannot be resolved, and reports NOT_DEPLOYED if unreachable', async () => {
    // Bare "/{order_id}" — no spec, no LLM — cannot be resolved to a static path.
    // Service is also unreachable (ECONNREFUSED), so NOT_DEPLOYED should be reported.
    const paramDiff = [
      'diff --git a/backend/src/routers/orders.py b/backend/src/routers/orders.py',
      '+@router.put("/{order_id}", response_model=OrderRead)',
    ].join('\n')
    const backendServices: WorkspaceServiceInfo[] = [
      { serviceName: 'backend', baseUrl: 'http://localhost:8000', testDirectory: 'backend/tests' },
    ]

    // All fetch calls fail — no spec available, and service is unreachable
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    const result = await runPreflightCheck({ diffContent: paramDiff, services: backendServices, authToken: '' })
    // A parameterised URL must never be probed directly
    expect(result.probedEndpoints.some(u => u.includes('{'))).toBe(false)
    // Alive probe at / must have fired
    expect(result.probedEndpoints.some(u => u.endsWith('/'))).toBe(true)
    // Unreachable service must be reported as NOT_DEPLOYED
    expect(result.ready).toBe(false)
    expect(result.issues.some(i => i.kind === 'NOT_DEPLOYED')).toBe(true)
  })

  it('falls back to alive probe at / when hints cannot be resolved, and passes if service responds', async () => {
    const paramDiff = [
      'diff --git a/backend/src/routers/orders.py b/backend/src/routers/orders.py',
      '+@router.put("/{order_id}", response_model=OrderRead)',
    ].join('\n')
    const backendServices: WorkspaceServiceInfo[] = [
      { serviceName: 'backend', baseUrl: 'http://localhost:8000', testDirectory: 'backend/tests' },
    ]

    // spec fetch fails but the alive probe returns 200
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('openapi')) throw new Error('ECONNREFUSED')
      return { status: 200 }
    }))

    const result = await runPreflightCheck({ diffContent: paramDiff, services: backendServices, authToken: '' })
    expect(result.probedEndpoints.some(u => u.includes('{'))).toBe(false)
    expect(result.probedEndpoints.some(u => u.endsWith('/'))).toBe(true)
    expect(result.ready).toBe(true)
  })

})
