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
  it('renders a full report with all sections', () => {
    const md = renderReport(validReport)

    expect(md).toContain('### 📋 Business Case Analysis')
    expect(md).toContain('Tests cover the checkout flow.')

    expect(md).toContain('### 💡 New Tests Created')
    expect(md).toContain('- **contract** for POST /orders — `test_orders.py`')

    expect(md).toContain('### ✅ Test Maintenance')
    expect(md).toContain('- Updated auth header in existing tests')

    expect(md).toContain('### 🧪 Test Results')
    expect(md).toContain('| contract | POST /orders | PASS | All assertions passed |')
    expect(md).toContain('| fuzz | GET /products | FAIL | Unexpected 500 |')

    expect(md).toContain('### ⚠️ Issues Found')
    expect(md).toContain('- Server returns 500 on empty query param')
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

    expect(md).toContain('### 📋 Business Case Analysis')
    expect(md).toContain('### 🧪 Test Results')
    expect(md).not.toContain('### 💡 New Tests Created')
    expect(md).not.toContain('### ✅ Test Maintenance')
    expect(md).not.toContain('### ⚠️ Issues Found')
  })

  it('renders the test results table with headers', () => {
    const md = renderReport(validReport)
    expect(md).toContain('| Test Type | Endpoint | Status | Details |')
    expect(md).toContain('|-----------|----------|--------|---------|')
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

  it('returns commitMessage from valid JSON report', () => {
    const report = { ...validReport, commitMessage: 'add tests for /products endpoint' }
    fs.writeFileSync(paths.summaryPath, JSON.stringify(report))

    const result = readSummary(paths)
    expect(result.commitMessage).toBe('add tests for /products endpoint')
    expect(result.summary).toContain('Business Case Analysis')
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
    expect(result.summary).toContain('Business Case Analysis')
  })

  it('returns default commitMessage from report', () => {
    const report = { ...validReport, commitMessage: 'Added recommendations by Skyramp Testbot.' }
    fs.writeFileSync(paths.summaryPath, JSON.stringify(report))

    const result = readSummary(paths)
    expect(result.commitMessage).toBe('Added recommendations by Skyramp Testbot.')
    expect(result.summary).toContain('Business Case Analysis')
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
