import './mocks/core'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { tryParseReport, renderReport, readSummary, parseMetrics } from '../report'
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
    expect(md).toContain('- contract — `POST /orders`: `test_orders.py`')

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

  it('renders "review commit" when autoCommit is true and no issues', () => {
    const report: TestbotReport = {
      ...validReport,
      issuesFound: [],
    }
    const md = renderReport(report, { autoCommit: true })
    expect(md).toContain('### 💡 Next Steps')
    expect(md).toContain('- Review the commit made by Skyramp Testbot.')
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
