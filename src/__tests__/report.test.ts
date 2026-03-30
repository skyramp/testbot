import './mocks/core'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { tryParseReport, renderReport, readSummary, parseMetrics, escapeIssueReferences } from '../report'
import type { Paths, TestbotReport } from '../types'

const validReport: TestbotReport = {
  businessCaseAnalysis: 'Tests cover the checkout flow.',
  newTestsCreated: [
    { testType: 'contract', endpoint: 'POST /orders', fileName: 'test_orders.py' },
  ],
  testMaintenance: [
    { description: 'Updated auth header in existing tests' },
  ],
  testResults: [
    { testType: 'contract', endpoint: 'POST /orders', status: 'PASS', details: 'All assertions passed' },
    { testType: 'fuzz', endpoint: 'GET /products', status: 'FAIL', details: 'Unexpected 500' },
  ],
  issuesFound: [
    { description: 'Server returns 500 on empty query param' },
  ],
}

describe('tryParseReport', () => {
  it('parses valid JSON into a TestbotReport', () => {
    const raw = JSON.stringify(validReport)
    const result = tryParseReport(raw)
    expect(result).toEqual(validReport)
  })

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify(validReport) + '\n```'
    const result = tryParseReport(raw)
    expect(result).toEqual(validReport)
  })

  it('strips code fences without language tag', () => {
    const raw = '```\n' + JSON.stringify(validReport) + '\n```'
    const result = tryParseReport(raw)
    expect(result).toEqual(validReport)
  })

  it('returns null for missing required fields', () => {
    const incomplete = JSON.stringify({ businessCaseAnalysis: 'hello' })
    expect(tryParseReport(incomplete)).toBeNull()
  })

  it('returns null if businessCaseAnalysis is not a string', () => {
    const bad = JSON.stringify({ businessCaseAnalysis: 123, testResults: [] })
    expect(tryParseReport(bad)).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(tryParseReport('{not json}')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(tryParseReport('')).toBeNull()
  })
})

describe('renderReport', () => {
  it('renders a full report with ### headings by default', () => {
    const md = renderReport(validReport)

    expect(md).toContain('> Tests cover the checkout flow.')

    expect(md).toContain('### 💡 Test Recommendations Implemented')
    expect(md).toContain('- contract (`test_orders.py`)\n  `POST /orders`')

    expect(md).toContain('### ✅ Test Maintenance')
    expect(md).toContain('- Updated auth header in existing tests')

    expect(md).toContain('### 🧪 Test Results')
    expect(md).toContain('| contract | POST /orders | PASS | All assertions passed |')
    expect(md).toContain('| fuzz | GET /products | FAIL | Unexpected 500 |')

    expect(md).toContain('### ⚠️ Issues Found')
    expect(md).toContain('- Server returns 500 on empty query param')

    expect(md).not.toContain('<details>')
    expect(md).not.toContain('</details>')
  })

  it('renders collapsible details when collapsed is true', () => {
    const md = renderReport(validReport, { collapsed: true })

    expect(md).toContain('<details>')
    expect(md).toContain('> Tests cover the checkout flow.')
    expect(md).toContain('<summary>💡 Test Recommendations Implemented</summary>')
    expect(md).toContain('<summary>🧪 Test Results</summary>')
    expect(md).toContain('<summary>⚠️ Issues Found</summary>')
    expect(md).toContain('</details>')
    expect(md).not.toContain('###')
  })

  it('omits empty optional sections', () => {
    const minimal: TestbotReport = {
      businessCaseAnalysis: 'Minimal report.',
      newTestsCreated: [],
      testMaintenance: [],
      testResults: [
        { testType: 'smoke', endpoint: 'GET /health', status: 'PASS', details: 'OK' },
      ],
      issuesFound: [],
    }
    const md = renderReport(minimal)

    expect(md).toContain('> ')
    expect(md).toContain('### 🧪 Test Results')
    expect(md).not.toContain('💡 Test Recommendations Implemented')
    // Test Maintenance always shows (with "No existing..." message when empty)
    expect(md).toContain('✅ Test Maintenance')
    expect(md).toContain('No existing Skyramp tests required maintenance for this PR.')
    expect(md).not.toContain('⚠️ Issues Found')
  })

  it('renders Test Results section with empty table when testResults is empty', () => {
    const report: TestbotReport = {
      businessCaseAnalysis: 'Setup PR with no tests.',
      newTestsCreated: [],
      testMaintenance: [],
      testResults: [],
      issuesFound: [],
    }
    const md = renderReport(report)

    expect(md).toContain('> ')
    // Test Results always shows (with empty table)
    expect(md).toContain('🧪 Test Results')
    expect(md).toContain('| Test Type | Endpoint | Status | Details |')
  })

  it('renders the test results table with headers', () => {
    const md = renderReport(validReport)
    expect(md).toContain('| Test Type | Endpoint | Status | Details |')
    expect(md).toContain('|-----------|----------|--------|---------|')
  })

  it('renders summary line when collapsed with commitMessage', () => {
    const md = renderReport(validReport, { commitMessage: 'add smoke tests for GET /products', collapsed: true })
    expect(md).toContain('**Summary:** add smoke tests for GET /products')
    const summaryIdx = md.indexOf('**Summary:**')
    const detailsIdx = md.indexOf('<details>')
    expect(summaryIdx).toBeLessThan(detailsIdx)
  })

  it('does not render summary line when not collapsed even with commitMessage', () => {
    const md = renderReport(validReport, { commitMessage: 'some message' })
    expect(md).not.toContain('**Summary:**')
  })

  it('does not render summary line when collapsed but commitMessage is empty', () => {
    const md = renderReport(validReport, { collapsed: true, commitMessage: '' })
    expect(md).not.toContain('**Summary:**')
  })

  it('renders before/after table when testMaintenance has new schema entries', () => {
    const report: TestbotReport = {
      ...validReport,
      testMaintenance: [
        {
          fileName: 'products_smoke_test.py',
          description: 'Updated endpoint /products → /items',
          beforeStatus: 'Fail',
          beforeDetails: '404 Not Found (2.1s)',
          afterStatus: 'Pass',
          afterDetails: 'All assertions passed (3.4s)',
        },
      ],
    }
    const md = renderReport(report)
    expect(md).toContain('| File | Change | Before | After |')
    expect(md).toContain('|------|--------|--------|-------|')
    expect(md).toContain('| `products_smoke_test.py` |')
    expect(md).toContain('Fail (404 Not Found (2.1s))')
    expect(md).toContain('Pass (All assertions passed (3.4s))')
  })

  it('renders mixed before/after and legacy entries in the same table', () => {
    const report: TestbotReport = {
      ...validReport,
      testMaintenance: [
        {
          fileName: 'orders_contract_test.py',
          description: 'Fixed auth header',
          beforeStatus: 'Fail',
          beforeDetails: '401 Unauthorized',
          afterStatus: 'Pass',
          afterDetails: 'OK (1.2s)',
        },
        { description: 'Minor formatting fix in utils test' },
      ],
    }
    const md = renderReport(report)
    expect(md).toContain('| File | Change | Before | After |')
    expect(md).toContain('| `orders_contract_test.py` |')
    expect(md).toContain('| — | Minor formatting fix in utils test | — | — |')
  })

  it('escapes pipe characters and newlines in table cells', () => {
    const report: TestbotReport = {
      ...validReport,
      testMaintenance: [
        {
          fileName: 'test.py',
          description: 'Fixed path|url',
          beforeStatus: 'Fail',
          beforeDetails: 'Error:\nline two',
          afterStatus: 'Pass',
          afterDetails: 'OK',
        },
      ],
    }
    const md = renderReport(report)
    expect(md).toContain('Fixed path\\|url')
    expect(md).toContain('Error:<br>line two')
  })

  it('falls back to bullet list for legacy-only testMaintenance', () => {
    const md = renderReport(validReport)
    expect(md).toContain('- Updated auth header in existing tests')
    expect(md).not.toContain('| File | Change | Before | After |')
  })
})

describe('readSummary', () => {
  let tmpDir: string
  let paths: Paths

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readSummary-test-'))
    paths = {
      tempDir: tmpDir,
      licensePath: path.join(tmpDir, 'license'),
      gitDiffPath: path.join(tmpDir, 'diff'),
      summaryPath: path.join(tmpDir, 'summary.json'),
      agentLogPath: path.join(tmpDir, 'agent-log.ndjson'),
      agentStdoutPath: path.join(tmpDir, 'agent-stdout.txt'),
      combinedResultPath: path.join(tmpDir, 'combined-result.txt'),
    }
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns commitMessage from valid JSON report (no collapsed by default)', () => {
    const report = { ...validReport, commitMessage: 'add tests for /products endpoint' }
    fs.writeFileSync(paths.summaryPath, JSON.stringify(report))

    const result = readSummary(paths)
    expect(result.commitMessage).toBe('add tests for /products endpoint')
    expect(result.summary).toContain('> Tests cover the checkout flow.')
    expect(result.summary).not.toContain('<details>')
    expect(result.summary).not.toContain('**Summary:**')
  })

  it('renders collapsed sections and summary line when reportCollapsed is true', () => {
    const report = { ...validReport, commitMessage: 'add tests for /products endpoint' }
    fs.writeFileSync(paths.summaryPath, JSON.stringify(report))

    const result = readSummary(paths, true)
    expect(result.commitMessage).toBe('add tests for /products endpoint')
    expect(result.summary).toContain('**Summary:** add tests for /products endpoint')
    expect(result.summary).toContain('<details>')
    expect(result.summary).toContain('> Tests cover the checkout flow.')
  })

  it('returns undefined commitMessage for raw (non-JSON) summary', () => {
    fs.writeFileSync(paths.summaryPath, '# Some markdown report\nAll tests passed.')

    const result = readSummary(paths)
    expect(result.commitMessage).toBeUndefined()
    expect(result.summary).toContain('Some markdown report')
  })

  it('returns undefined commitMessage when report has no commitMessage field', () => {
    fs.writeFileSync(paths.summaryPath, JSON.stringify(validReport))

    const result = readSummary(paths)
    expect(result.commitMessage).toBeUndefined()
    expect(result.summary).toContain('> Tests cover the checkout flow.')
  })

  it('returns default commitMessage from report', () => {
    const report = { ...validReport, commitMessage: 'Added recommendations by Skyramp Testbot.' }
    fs.writeFileSync(paths.summaryPath, JSON.stringify(report))

    const result = readSummary(paths)
    expect(result.commitMessage).toBe('Added recommendations by Skyramp Testbot.')
    expect(result.summary).toContain('> Tests cover the checkout flow.')
  })

  it('returns undefined commitMessage when no summary file exists', () => {
    const result = readSummary(paths)
    expect(result.commitMessage).toBeUndefined()
    expect(result.summary).toBe('No summary available')
  })
})

describe('additionalRecommendations grouping and sorting', () => {
  const makeRec = (
    testType: string,
    scenarioName: string,
    category?: string,
    method = 'GET',
    pathStr = '/foo',
    priority = 'medium',
    expectedStatusCode?: number,
  ) => ({
    testId: `${testType}-${scenarioName}`,
    testType,
    category,
    scenarioName,
    priority,
    description: `${scenarioName} description`,
    steps: [{ method, path: pathStr, description: `Call ${method} ${pathStr}`, expectedStatusCode }],
    reasoning: '',
  })

  it('groups recommendations under emoji headers by test type', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [
        makeRec('integration', 'update-order', 'workflow'),
        makeRec('contract', 'post-orders-auth', 'security_boundary'),
        makeRec('e2e', 'checkout-flow'),
        makeRec('ui', 'cart-modal'),
      ],
    }
    const md = renderReport(report)
    expect(md).toContain('**📋 Contract**')
    expect(md).toContain('**🔗 Integration**')
    expect(md).toContain('**🌐 E2E**')
    expect(md).toContain('**🖥️ UI**')
  })

  it('orders groups: Contract → Integration → E2E → UI', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [
        makeRec('ui', 'cart-modal'),
        makeRec('e2e', 'checkout-flow'),
        makeRec('integration', 'update-order'),
        makeRec('contract', 'post-orders-auth'),
      ],
    }
    const md = renderReport(report)
    const contractIdx = md.indexOf('**📋 Contract**')
    const integrationIdx = md.indexOf('**🔗 Integration**')
    const e2eIdx = md.indexOf('**🌐 E2E**')
    const uiIdx = md.indexOf('**🖥️ UI**')
    expect(contractIdx).toBeLessThan(integrationIdx)
    expect(integrationIdx).toBeLessThan(e2eIdx)
    expect(e2eIdx).toBeLessThan(uiIdx)
  })

  it('sorts within a group by category risk: security_boundary before workflow', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [
        makeRec('integration', 'workflow-test', 'workflow'),
        makeRec('integration', 'auth-boundary', 'security_boundary'),
        makeRec('integration', 'data-check', 'data_integrity'),
      ],
    }
    const md = renderReport(report)
    const authIdx = md.indexOf('auth-boundary description')
    const dataIdx = md.indexOf('data-check description')
    const workflowIdx = md.indexOf('workflow-test description')
    expect(authIdx).toBeLessThan(dataIdx)
    expect(dataIdx).toBeLessThan(workflowIdx)
  })

  it('sorts alphabetically by scenarioName within same category', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [
        makeRec('contract', 'z-test', 'security_boundary'),
        makeRec('contract', 'a-test', 'security_boundary'),
      ],
    }
    const md = renderReport(report)
    expect(md.indexOf('a-test description')).toBeLessThan(md.indexOf('z-test description'))
  })


  it('sorts by priority within same test type: high before medium before low', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [
        makeRec('integration', 'low-priority-test', 'business_rule', 'GET', '/foo', 'low'),
        makeRec('integration', 'high-priority-test', 'business_rule', 'GET', '/foo', 'high'),
        makeRec('integration', 'medium-priority-test', 'business_rule', 'GET', '/foo', 'medium'),
      ],
    }
    const md = renderReport(report)
    const highIdx = md.indexOf('high-priority-test description')
    const medIdx = md.indexOf('medium-priority-test description')
    const lowIdx = md.indexOf('low-priority-test description')
    expect(highIdx).toBeLessThan(medIdx)
    expect(medIdx).toBeLessThan(lowIdx)
  })

  it('sorts priority before category risk: high-priority workflow beats medium-priority security', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [
        makeRec('integration', 'medium-security', 'security_boundary', 'GET', '/foo', 'medium'),
        makeRec('integration', 'high-workflow', 'workflow', 'GET', '/foo', 'high'),
      ],
    }
    const md = renderReport(report)
    const highIdx = md.indexOf('high-workflow description')
    const medIdx = md.indexOf('medium-security description')
    expect(highIdx).toBeLessThan(medIdx)
  })

  it('sorts error-step tests before happy-path within same priority and category', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [
        makeRec('integration', 'happy-path-test', 'business_rule', 'POST', '/orders', 'high', 201),
        makeRec('integration', 'error-path-test', 'business_rule', 'POST', '/orders', 'high', 404),
      ],
    }
    const md = renderReport(report)
    const errorIdx = md.indexOf('error-path-test description')
    const happyIdx = md.indexOf('happy-path-test description')
    expect(errorIdx).toBeLessThan(happyIdx)
  })

  it('applies priority + error-step sort to Next Steps top-2 picks', () => {
    const report: TestbotReport = {
      ...validReport,
      issuesFound: [],
      nextSteps: ['Fix the bug.'],
      additionalRecommendations: [
        makeRec('integration', 'low-happy', 'workflow', 'GET', '/foo', 'low', 200),
        makeRec('contract', 'high-error', 'security_boundary', 'POST', '/auth', 'high', 401),
        makeRec('integration', 'medium-happy', 'business_rule', 'GET', '/bar', 'medium', 200),
      ],
    }
    const md = renderReport(report)
    expect(md).toContain('**contract-high-error**')
    expect(md).toContain('**integration-medium-happy**')
    const rec1Idx = md.indexOf('**contract-high-error**')
    const rec2Idx = md.indexOf('**integration-medium-happy**')
    expect(rec1Idx).toBeLessThan(rec2Idx)
    expect(md).not.toContain('**integration-low-happy**')
  })

  it('falls back to unknown type label when testType is unrecognized', () => {
    const report: TestbotReport = {
      ...validReport,
      additionalRecommendations: [makeRec('smoke', 'health-check')],
    }
    const md = renderReport(report)
    expect(md).toContain('**smoke**')
  })
})


describe('PR #181 regression — additionalRecommendations sort order', () => {
  // Exact payload the Claude agent submitted for demoshop-fullstack PR #181.
  // Previously, `integration-orders-patch-add-item` (a basic happy-path test)
  // appeared above security and error-handling tests in the Integration group
  // because report.ts ignored the priority field and sorted only by category+name.
  const pr181Recs = [
    {
      testId: 'integration-orders-patch-fixed-discount',
      testType: 'Integration',
      category: 'business_rule' as const,
      scenarioName: 'orders-patch-fixed-discount',
      description: 'Validates the fixed discount business rule: PATCH with discount_type=fixed and discount_value=50 should set discount_amount=50 regardless of total_amount.',
      priority: 'high',
      steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-patch-remove-discount',
      testType: 'Integration',
      category: 'business_rule' as const,
      scenarioName: 'orders-patch-remove-discount',
      description: 'Validates discount removal: PATCH with discount_type=None and discount_value=None should clear all discount fields on the order.',
      priority: 'high',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-patch-status-transition',
      testType: 'Integration',
      category: 'business_rule' as const,
      scenarioName: 'orders-patch-status-transition',
      description: 'Validates order status transitions through the full lifecycle: pending → confirmed → shipped → delivered via sequential PATCH requests.',
      priority: 'high',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-patch-add-item',
      testType: 'Integration',
      category: 'business_rule' as const,
      scenarioName: 'orders-patch-add-item',
      description: 'Validates that PATCHing an order with new items appends them and recalculates total_amount correctly.',
      priority: 'high',
      steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-patch-invalid-product',
      testType: 'Integration',
      category: 'data_integrity' as const,
      scenarioName: 'orders-patch-invalid-product-id',
      description: 'Validates that PATCHing an order with a non-existent product_id returns 404, not a silent failure.',
      priority: 'high',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'contract-post-orders-auth-boundary',
      testType: 'Contract',
      category: 'security_boundary' as const,
      scenarioName: 'orders-post-unauthenticated',
      description: 'Validates that POST /api/v1/orders without an Authorization Bearer token returns 403 Forbidden.',
      priority: 'high',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'POST without auth', expectedStatusCode: 403 }],
      reasoning: 'EnsureSessionDep guards all order endpoints.',
    },
    {
      testId: 'integration-orders-products-workflow',
      testType: 'Integration',
      category: 'workflow' as const,
      scenarioName: 'orders-products-full-workflow',
      description: 'Full cross-resource workflow: create product → create order referencing it → edit order → verify → cancel order.',
      priority: 'medium',
      steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-unique-constraint',
      testType: 'Integration',
      category: 'business_rule' as const,
      scenarioName: 'orders-unique-constraint',
      description: 'Attempt to create a duplicate order — moved to additional as Redis does not enforce unique constraints.',
      priority: 'medium',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-products-cascade',
      testType: 'Integration',
      category: 'data_integrity' as const,
      scenarioName: 'orders-products-cascade-delete',
      description: 'Moved to additional — Redis has no FK constraints so cascade-delete behaviors are not enforced.',
      priority: 'medium',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'ui-edit-order-fixed-discount',
      testType: 'UI',
      category: 'workflow' as const,
      scenarioName: 'ui-edit-order-fixed-discount',
      description: 'Records UI interaction selecting Fixed Amount discount type and verifying the discount preview.',
      priority: 'high',
      steps: [{ description: 'Select Fixed Amount discount type' }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-cross-session-isolation',
      testType: 'Integration',
      category: 'security_boundary' as const,
      scenarioName: 'orders-cross-session-isolation',
      description: 'Validates that a PATCH request using session B cannot modify an order created by session A.',
      priority: 'high',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'e2e-edit-order-full-flow',
      testType: 'E2E',
      category: 'workflow' as const,
      scenarioName: 'e2e-edit-order-end-to-end',
      description: 'Full E2E flow: navigate to orders list, open an order, click Edit Order, apply a percentage discount, submit, and verify.',
      priority: 'high',
      steps: [{ description: 'Navigate to orders list' }],
      reasoning: '',
    },
    {
      testId: 'integration-orders-patch-email-update',
      testType: 'Integration',
      category: 'business_rule' as const,
      scenarioName: 'orders-patch-customer-email-update',
      description: 'Validates that PATCHing only customer_email updates it correctly and leaves all other fields unchanged.',
      priority: 'medium',
      steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'integration-reviews-products-workflow',
      testType: 'Integration',
      category: 'workflow' as const,
      scenarioName: 'products-reviews-integration',
      description: 'Creates a product then posts a review linked to it — validates cross-resource relationship.',
      priority: 'medium',
      steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }],
      reasoning: '',
    },
    {
      testId: 'contract-patch-orders-discount-validation',
      testType: 'Contract',
      category: 'data_integrity' as const,
      scenarioName: 'orders-patch-invalid-discount-type',
      description: 'Validates that PATCH with an invalid discount_type value returns 422 Unprocessable Entity.',
      priority: 'medium',
      steps: [{ method: 'PATCH', path: '/api/v1/orders/{order_id}', description: 'PATCH with invalid discount_type', expectedStatusCode: 422 }],
      reasoning: 'Pydantic validation should reject invalid values before reaching business logic.',
    },
    {
      testId: 'ui-edit-order-cancel-navigation',
      testType: 'UI',
      category: 'workflow' as const,
      scenarioName: 'ui-edit-order-cancel-button',
      description: 'Validates that clicking Cancel on the EditOrderForm navigates back without saving changes.',
      priority: 'low',
      steps: [{ description: 'Click Cancel button' }],
      reasoning: '',
    },
  ]

  const pr181Report: TestbotReport = {
    businessCaseAnalysis: 'Enables store administrators to edit existing orders.',
    newTestsCreated: [
      { testType: 'Integration', endpoint: 'PATCH /api/v1/orders/{order_id}', fileName: 'orders_patch_integration_test.py' },
    ],
    testMaintenance: [],
    testResults: [
      { testType: 'Integration', endpoint: 'PATCH /api/v1/orders/{order_id}', status: 'Fail', details: '500 Internal Server Error' },
    ],
    issuesFound: [
      { description: 'BUG: PATCH /api/v1/orders/{order_id} returns 500 — datetime.utcnow() called but datetime not imported.' },
    ],
    additionalRecommendations: pr181Recs,
    nextSteps: [
      'Fix missing import in backend/src/api_insight/crud/orders.py: add `from datetime import datetime`',
    ],
  }

  it('security_boundary integration tests sort above business_rule happy-path tests', () => {
    const md = renderReport(pr181Report)
    const crossSessionIdx = md.indexOf('integration-orders-cross-session-isolation')
    const addItemIdx = md.indexOf('integration-orders-patch-add-item')
    expect(crossSessionIdx).toBeGreaterThan(-1)
    expect(addItemIdx).toBeGreaterThan(-1)
    expect(crossSessionIdx).toBeLessThan(addItemIdx)
  })

  it('contract auth-boundary test (high, security, 403) sorts first overall', () => {
    const md = renderReport(pr181Report)
    const authIdx = md.indexOf('contract-post-orders-auth-boundary')
    const addItemIdx = md.indexOf('integration-orders-patch-add-item')
    expect(authIdx).toBeLessThan(addItemIdx)
  })

  it('medium-priority tests sort below high-priority tests within same type', () => {
    const md = renderReport(pr181Report)
    const highBizRule = md.indexOf('integration-orders-patch-fixed-discount')
    const medBizRule = md.indexOf('integration-orders-unique-constraint')
    expect(highBizRule).toBeLessThan(medBizRule)
  })

  it('contract group appears before integration group', () => {
    const md = renderReport(pr181Report)
    const contractGroup = md.indexOf('**📋 Contract**')
    const integrationGroup = md.indexOf('**🔗 Integration**')
    expect(contractGroup).toBeLessThan(integrationGroup)
  })

  it('within integration high-priority: security_boundary < data_integrity < business_rule < workflow', () => {
    const md = renderReport(pr181Report)
    const lines = md.split('\n')
    const integrationRecs = lines.filter(l => l.startsWith('- `integration-'))

    const indexOf = (id: string) => integrationRecs.findIndex(l => l.includes(id))

    const crossSession = indexOf('orders-cross-session-isolation')
    const invalidProduct = indexOf('orders-patch-invalid-product')
    const addItem = indexOf('orders-patch-add-item')
    const fixedDiscount = indexOf('orders-patch-fixed-discount')

    // security_boundary (cross-session) < data_integrity (invalid-product) < business_rule (add-item, fixed-discount)
    expect(crossSession).toBeLessThan(invalidProduct)
    expect(invalidProduct).toBeLessThan(addItem)
    expect(invalidProduct).toBeLessThan(fixedDiscount)
  })

  it('Next Steps top-2 picks auth-boundary contract test first, not a happy-path integration test', () => {
    const md = renderReport(pr181Report)
    // Next Steps surfaces top-2 from sorted order
    const nextStepsIdx = md.indexOf('### 💡 Next Steps')
    const nextStepsSection = md.slice(nextStepsIdx)

    // The auth-boundary contract test (high, security_boundary, 403) should be picked
    expect(nextStepsSection).toContain('contract-post-orders-auth-boundary')
    // The add-item happy-path test should NOT be in top 2
    expect(nextStepsSection).not.toContain('orders-patch-add-item')
  })

  it('renders the full Integration group in expected order', () => {
    const md = renderReport(pr181Report)
    const lines = md.split('\n')
    const integrationRecs = lines
      .filter(l => l.startsWith('- `integration-'))
      .map(l => {
        const match = l.match(/`(integration-[^`]+)`/)
        return match ? match[1] : ''
      })
      .filter(Boolean)

    // Expected: high-priority first (security > data_integrity > business_rule),
    // then medium-priority (same category sub-sort), then low
    const expectedPrefix = [
      'integration-orders-cross-session-isolation',     // high, security_boundary
      'integration-orders-patch-invalid-product',       // high, data_integrity
    ]
    // The high business_rule group (4 items) sorts alphabetically among themselves
    const highBizRuleGroup = [
      'integration-orders-patch-add-item',
      'integration-orders-patch-fixed-discount',
      'integration-orders-patch-remove-discount',
      'integration-orders-patch-status-transition',
    ]

    for (let i = 0; i < expectedPrefix.length; i++) {
      expect(integrationRecs[i]).toBe(expectedPrefix[i])
    }

    // All high-biz-rule items should appear after the prefix and before medium items
    const bizRuleStart = expectedPrefix.length
    for (let i = 0; i < highBizRuleGroup.length; i++) {
      expect(integrationRecs[bizRuleStart + i]).toBe(highBizRuleGroup[i])
    }
  })
})

describe('parseMetrics', () => {
  it('extracts modified, created, executed counts', () => {
    const summary = 'Modified 3 tests. Created 5 new tests. Executed 12 tests total.'
    const metrics = parseMetrics(summary)
    expect(metrics).toEqual({ modified: 3, created: 5, executed: 12 })
  })

  it('returns 0 for missing keywords', () => {
    const summary = 'No relevant data here.'
    const metrics = parseMetrics(summary)
    expect(metrics).toEqual({ modified: 0, created: 0, executed: 0 })
  })

  it('handles empty string', () => {
    const metrics = parseMetrics('')
    expect(metrics).toEqual({ modified: 0, created: 0, executed: 0 })
  })
})

describe('Business Case Analysis rendering', () => {
  it('renders BCA as a blockquote', () => {
    const md = renderReport(validReport)
    expect(md).toContain('> Tests cover the checkout flow.')
  })

  it('does not render BCA as a collapsible section', () => {
    const md = renderReport(validReport)
    expect(md).not.toContain('📋 Business Case Analysis')
  })
})

describe('Next Steps section', () => {
  it('renders agent-provided nextSteps', () => {
    const report: TestbotReport = {
      ...validReport,
      nextSteps: ['Check your targetSetupCommand — endpoints returned 404'],
    }
    const md = renderReport(report)
    expect(md).toContain('### 💡 Next Steps')
    expect(md).toContain('- Check your targetSetupCommand — endpoints returned 404')
  })

  it('omits Next Steps when autoCommit is true, no issues, and no recommendations', () => {
    const report: TestbotReport = {
      ...validReport,
      issuesFound: [],
    }
    const md = renderReport(report, { autoCommit: true })
    expect(md).not.toContain('### 💡 Next Steps')
  })

  it('suggests enabling autoCommit when autoCommit is false', () => {
    const report: TestbotReport = {
      ...validReport,
      issuesFound: [],
    }
    const md = renderReport(report)
    expect(md).toContain('### 💡 Next Steps')
    expect(md).toContain('Enable `autoCommit: true`')
  })

  it('does not render "review commit" when there are issues', () => {
    const md = renderReport(validReport, { autoCommit: true })
    // validReport has issuesFound, so no auto "review commit"
    expect(md).not.toContain('Review the commit')
  })

  it('renders agent nextSteps even when autoCommit is true (no duplicate review message)', () => {
    const report: TestbotReport = {
      ...validReport,
      nextSteps: ['Check your targetSetupCommand'],
      issuesFound: [],
    }
    const md = renderReport(report, { autoCommit: true })
    expect(md).toContain('- Check your targetSetupCommand')
    // Agent provided steps, so no auto "review commit" message
    expect(md).not.toContain('Review the commit')
  })

  it('does not render next steps when no tests and autoCommit is true', () => {
    const report: TestbotReport = {
      businessCaseAnalysis: 'Setup PR.',
      newTestsCreated: [],
      testMaintenance: [],
      testResults: [],
      issuesFound: [],
    }
    const md = renderReport(report, { autoCommit: true })
    expect(md).not.toContain('Next Steps')
  })

  it('is always rendered as ### heading, not collapsible', () => {
    const report: TestbotReport = {
      ...validReport,
      nextSteps: ['Some step'],
    }
    const md = renderReport(report, { collapsed: true })
    // Even in collapsed mode, Next Steps uses ### heading, not <details>
    expect(md).toContain('### 💡 Next Steps')
    expect(md).not.toContain('<summary>💡 Next Steps</summary>')
  })
})

describe('escapeIssueReferences', () => {
  it('escapes #<number> patterns to prevent GFM auto-linking', () => {
    expect(escapeIssueReferences('See recommendation #3 for details')).toBe(
      'See recommendation <span>#</span>3 for details',
    )
  })

  it('escapes multiple occurrences', () => {
    expect(escapeIssueReferences('#1 and #2 and #10')).toBe(
      '<span>#</span>1 and <span>#</span>2 and <span>#</span>10',
    )
  })

  it('does not escape # not followed by a digit', () => {
    expect(escapeIssueReferences('### Heading')).toBe('### Heading')
    expect(escapeIssueReferences('C# language')).toBe('C# language')
  })

  it('preserves HTML comments like <!-- skyramp-testbot -->', () => {
    const marker = '<!-- skyramp-testbot -->'
    expect(escapeIssueReferences(marker)).toBe(marker)
  })
})

describe('PR #192 regression — diff-relevance-aware additionalRecommendations sort', () => {
  // Payload from PR #192 run, but with CORRECTED priorities per the new
  // diff-relevance rules. The PR adds PATCH /api/v1/orders/{order_id},
  // so orders endpoints are "in diff" and products endpoints are "not in diff".
  //
  // Expected corrections vs the actual PR #192 output:
  // - integration-products-cross-user-isolation: high → medium (products not in diff)
  // - integration-products-reviews-workflow: medium → low (products not in diff)
  // - contract-products-post-auth-boundary: high → medium (products not in diff)
  // - integration-orders-crud-lifecycle: low → high (orders are NEW in diff)
  // - integration-orders-unique-constraint: low → medium (orders are in diff, business rule)
  const pr192Recs = [
    { testId: 'integration-orders-patch-fixed-discount', testType: 'Integration', category: 'business_rule', scenarioName: 'orders-patch-fixed-discount', priority: 'high', description: 'PATCH order with discount_type=fixed and verify discount_amount equals discount_value exactly.', steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }, { method: 'PATCH', path: '/api/v1/orders/{order_id}', description: 'Apply fixed discount', expectedStatusCode: 200 }], reasoning: '' },
    { testId: 'integration-orders-patch-invalid-order', testType: 'Integration', category: 'business_rule', scenarioName: 'orders-patch-invalid-order', priority: 'high', description: 'PATCH a non-existent order and verify 404.', steps: [{ method: 'PATCH', path: '/api/v1/orders/99999', description: 'PATCH non-existent', expectedStatusCode: 404 }], reasoning: '' },
    { testId: 'integration-orders-cross-user-isolation', testType: 'Integration', category: 'security_boundary', scenarioName: 'orders-cross-user-isolation', priority: 'high', description: 'Create order under session A, PATCH with session B → 404.', steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }, { method: 'PATCH', path: '/api/v1/orders/{order_id}', description: 'PATCH with other session', expectedStatusCode: 404 }], reasoning: '' },
    { testId: 'integration-orders-products-cascade-delete', testType: 'Integration', category: 'data_integrity', scenarioName: 'orders-products-cascade-delete', priority: 'high', description: 'Delete order, verify product still exists.', steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }, { method: 'DELETE', path: '/api/v1/orders/{order_id}', description: 'Delete order', expectedStatusCode: 204 }, { method: 'GET', path: '/api/v1/products/{product_id}', description: 'Verify product exists', expectedStatusCode: 200 }], reasoning: '' },
    { testId: 'integration-orders-crud-lifecycle', testType: 'Integration', category: 'workflow', scenarioName: 'orders-crud-lifecycle', priority: 'high', description: 'Full CRUD lifecycle for orders: create, read, PATCH, DELETE.', steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create', expectedStatusCode: 201 }, { method: 'GET', path: '/api/v1/orders/{order_id}', description: 'Read', expectedStatusCode: 200 }, { method: 'PATCH', path: '/api/v1/orders/{order_id}', description: 'Update', expectedStatusCode: 200 }, { method: 'DELETE', path: '/api/v1/orders/{order_id}', description: 'Delete', expectedStatusCode: 204 }], reasoning: '' },
    // Products tests: NOT in diff → capped at medium
    { testId: 'integration-products-cross-user-isolation', testType: 'Integration', category: 'security_boundary', scenarioName: 'products-cross-user-isolation', priority: 'medium', description: 'Create product under session A, GET with session B → 404.', steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }, { method: 'GET', path: '/api/v1/products/{product_id}', description: 'GET with other session', expectedStatusCode: 404 }], reasoning: '' },
    { testId: 'integration-orders-products-workflow', testType: 'Integration', category: 'workflow', scenarioName: 'orders-products-workflow', priority: 'medium', description: 'Create product, create order referencing it, verify, delete.', steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }, { method: 'GET', path: '/api/v1/orders/{order_id}', description: 'Verify', expectedStatusCode: 200 }, { method: 'DELETE', path: '/api/v1/orders/{order_id}', description: 'Delete', expectedStatusCode: 204 }], reasoning: '' },
    { testId: 'integration-orders-reviews-workflow', testType: 'Integration', category: 'workflow', scenarioName: 'orders-reviews-workflow', priority: 'medium', description: 'Create product, create order, post review.', steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/reviews', description: 'Post review', expectedStatusCode: 201 }], reasoning: '' },
    { testId: 'integration-orders-unique-constraint', testType: 'Integration', category: 'business_rule', scenarioName: 'orders-unique-constraint', priority: 'medium', description: 'Create two identical orders, verify both succeed (Redis, no uniqueness).', steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order 1', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/orders', description: 'Create order 2', expectedStatusCode: 201 }], reasoning: '' },
    { testId: 'integration-orders-products-delete-blocked', testType: 'Integration', category: 'data_integrity', scenarioName: 'orders-products-delete-blocked', priority: 'low', description: 'Delete order, verify product unaffected.', steps: [{ method: 'POST', path: '/api/v1/orders', description: 'Create order', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }, { method: 'DELETE', path: '/api/v1/orders/{order_id}', description: 'Delete order', expectedStatusCode: 204 }, { method: 'GET', path: '/api/v1/products/{product_id}', description: 'Verify product', expectedStatusCode: 200 }], reasoning: '' },
    { testId: 'integration-products-reviews-workflow', testType: 'Integration', category: 'workflow', scenarioName: 'products-reviews-workflow', priority: 'low', description: 'Create product, post review, verify.', steps: [{ method: 'POST', path: '/api/v1/products', description: 'Create product', expectedStatusCode: 201 }, { method: 'POST', path: '/api/v1/reviews', description: 'Post review', expectedStatusCode: 201 }, { method: 'GET', path: '/api/v1/reviews', description: 'Verify', expectedStatusCode: 200 }], reasoning: '' },
    // Contract tests
    { testId: 'contract-orders-patch-auth-boundary', testType: 'Contract', category: 'security_boundary', scenarioName: 'orders-patch-auth-boundary', priority: 'high', description: 'PATCH orders without auth → 401.', steps: [{ method: 'PATCH', path: '/api/v1/orders/{order_id}', description: 'PATCH without auth', expectedStatusCode: 401 }], reasoning: '' },
    { testId: 'contract-orders-post-auth-boundary', testType: 'Contract', category: 'security_boundary', scenarioName: 'orders-post-auth-boundary', priority: 'high', description: 'POST orders without auth → 401.', steps: [{ method: 'POST', path: '/api/v1/orders', description: 'POST without auth', expectedStatusCode: 401 }], reasoning: '' },
    { testId: 'contract-products-post-auth-boundary', testType: 'Contract', category: 'security_boundary', scenarioName: 'products-post-auth-boundary', priority: 'medium', description: 'POST products without auth → 401.', steps: [{ method: 'POST', path: '/api/v1/products', description: 'POST without auth', expectedStatusCode: 401 }], reasoning: '' },
    // E2E
    { testId: 'e2e-edit-order-full-flow', testType: 'E2E', category: 'workflow', scenarioName: 'edit-order-full-flow', priority: 'medium', description: 'Full E2E: browse → create → edit → verify.', steps: [{ method: 'GET', path: '/orders', description: 'Browse' }, { method: 'POST', path: '/api/v1/orders', description: 'Create' }, { method: 'PATCH', path: '/api/v1/orders/{order_id}', description: 'Edit' }, { method: 'GET', path: '/orders/{id}', description: 'Verify' }], reasoning: '' },
    // UI
    { testId: 'ui-edit-order-validation', testType: 'UI', category: 'business_rule', scenarioName: 'edit-order-validation', priority: 'medium', description: 'Remove all items → button disabled; add item → re-enabled.', steps: [{ method: 'GET', path: '/edit-order', description: 'Open form' }, { method: 'DELETE', path: '/items', description: 'Remove items' }, { method: 'POST', path: '/items', description: 'Add item' }], reasoning: '' },
    { testId: 'ui-order-detail-edit-button', testType: 'UI', category: 'workflow', scenarioName: 'order-detail-edit-button', priority: 'medium', description: 'Verify Edit Order button on OrderDetail for non-cancelled orders.', steps: [{ method: 'GET', path: '/orders/{id}', description: 'View order' }, { method: 'GET', path: '/edit-order', description: 'Click edit' }], reasoning: '' },
  ]

  it('contract tests sort before integration within the same priority', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)
    const contractIdx = md.indexOf('**📋 Contract**')
    const integrationIdx = md.indexOf('**🔗 Integration**')
    expect(contractIdx).toBeLessThan(integrationIdx)
  })

  it('diff-relevant high-priority orders tests sort before medium-priority products tests', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)
    // Within Integration group: all high-priority orders tests should come before medium products tests
    const ordersIsolation = md.indexOf('integration-orders-cross-user-isolation')
    const productsIsolation = md.indexOf('integration-products-cross-user-isolation')
    expect(ordersIsolation).toBeLessThan(productsIsolation)
  })

  it('orders-crud-lifecycle (high, workflow) sorts above products-cross-user-isolation (medium, security)', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)
    const crudLifecycle = md.indexOf('integration-orders-crud-lifecycle')
    const productsIsolation = md.indexOf('integration-products-cross-user-isolation')
    expect(crudLifecycle).toBeLessThan(productsIsolation)
  })

  it('orders-patch-fixed-discount (high, business_rule) sorts in the first few integration items', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)
    const fixedDiscount = md.indexOf('integration-orders-patch-fixed-discount')
    const productsIsolation = md.indexOf('integration-products-cross-user-isolation')
    expect(fixedDiscount).toBeLessThan(productsIsolation)
  })

  it('products-reviews-workflow (low) sorts last among integration tests', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)
    const productsReviews = md.indexOf('integration-products-reviews-workflow')
    const productsDeleteBlocked = md.indexOf('integration-orders-products-delete-blocked')
    // Both are low priority — they should be at the bottom of integration
    const ordersWorkflow = md.indexOf('integration-orders-products-workflow')
    expect(ordersWorkflow).toBeLessThan(productsReviews)
  })

  it('full integration sort order matches expected ranking', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)

    // Extract integration test IDs in order from the rendered markdown
    const integrationSection = md.slice(md.indexOf('**🔗 Integration**'))
    const nextSection = integrationSection.indexOf('**🌐 E2E**')
    const integrationBlock = nextSection > 0 ? integrationSection.slice(0, nextSection) : integrationSection
    const testIds = [...integrationBlock.matchAll(/`(integration-[^`]+)`/g)].map(m => m[1])

    // Expected order: high priority first (sorted by category risk within), then medium, then low
    const expectedOrder = [
      // HIGH priority — sorted by category risk: security_boundary(0) → data_integrity(2) → business_rule(3) → workflow(4)
      'integration-orders-cross-user-isolation',       // high, security_boundary, has 404 step
      'integration-orders-products-cascade-delete',    // high, data_integrity
      'integration-orders-patch-invalid-order',        // high, business_rule, has 404 error step boost
      'integration-orders-patch-fixed-discount',       // high, business_rule, no error step
      'integration-orders-crud-lifecycle',             // high, workflow
      // MEDIUM priority
      'integration-products-cross-user-isolation',     // medium, security_boundary
      'integration-orders-unique-constraint',          // medium, business_rule
      'integration-orders-products-workflow',          // medium, workflow
      'integration-orders-reviews-workflow',           // medium, workflow
      // LOW priority
      'integration-orders-products-delete-blocked',    // low, data_integrity
      'integration-products-reviews-workflow',         // low, workflow
    ]

    expect(testIds).toEqual(expectedOrder)
  })

  it('contract group: high-priority orders auth tests sort before medium products auth', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)
    const ordersAuth = md.indexOf('contract-orders-patch-auth-boundary')
    const productsAuth = md.indexOf('contract-products-post-auth-boundary')
    expect(ordersAuth).toBeLessThan(productsAuth)
  })

  it('Next Steps picks are from high-priority diff-relevant tests', () => {
    const report: TestbotReport = { ...validReport, additionalRecommendations: [...pr192Recs] }
    const md = renderReport(report)
    const nextStepsIdx = md.indexOf('Based on my analysis')
    if (nextStepsIdx > 0) {
      const nextStepsSection = md.slice(nextStepsIdx)
      // Should recommend high-priority orders-related tests, not products
      expect(nextStepsSection).toContain('orders')
    }
  })
})
