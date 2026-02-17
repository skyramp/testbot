import * as core from '@actions/core'
import * as fs from 'fs'
import type { Paths, SummaryMetrics, TestbotReport } from './types'

/**
 * Resolve the best available summary source file.
 * Prefers the agent-written summary; falls back to agent stdout capture.
 */
function resolveSummarySource(paths: Paths): string | null {
  if (fs.existsSync(paths.summaryPath)) return paths.summaryPath
  if (fs.existsSync(paths.agentStdoutPath)) {
    core.info('Using agent stdout as fallback (agent did not write to summary file)')
    return paths.agentStdoutPath
  }
  return null
}

/**
 * Try to parse the raw summary as a TestbotReport JSON object.
 * Returns null if the content is not valid JSON or doesn't have the expected shape.
 */
function tryParseReport(raw: string): TestbotReport | null {
  try {
    // Strip markdown code fences if the agent wrapped the JSON in them
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim()
    const parsed = JSON.parse(cleaned)
    if (typeof parsed.businessCaseAnalysis === 'string' && Array.isArray(parsed.testResults)) {
      return parsed as TestbotReport
    }
    return null
  } catch {
    return null
  }
}

/**
 * Render a TestbotReport into the standard markdown format.
 */
function renderReport(report: TestbotReport): string {
  const lines: string[] = []

  // Business Case Analysis (always present)
  lines.push('### 📋 Business Case Analysis')
  lines.push(report.businessCaseAnalysis)
  lines.push('')

  // New Tests Created (omit if empty)
  if (report.newTestsCreated.length > 0) {
    lines.push('### 💡 New Tests Created')
    for (const t of report.newTestsCreated) {
      lines.push(`- **${t.testType}** for ${t.endpoint} — \`${t.fileName}\``)
    }
    lines.push('')
  }

  // Test Maintenance (omit if empty)
  if (report.testMaintenance.length > 0) {
    lines.push('### ✅ Test Maintenance')
    for (const m of report.testMaintenance) {
      lines.push(`- ${m.description}`)
    }
    lines.push('')
  }

  // Test Results (always present)
  lines.push('### 🧪 Test Results')
  lines.push('| Test Type | Endpoint | Status | Details |')
  lines.push('|-----------|----------|--------|---------|')
  for (const r of report.testResults) {
    lines.push(`| ${r.testType} | ${r.endpoint} | ${r.status} | ${r.details} |`)
  }
  lines.push('')

  // Issues Found (omit if empty)
  if (report.issuesFound.length > 0) {
    lines.push('### ⚠️ Issues Found')
    for (const issue of report.issuesFound) {
      lines.push(`- ${issue.description}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Read the testbot summary from the best available source.
 * If the summary is valid JSON (TestbotReport schema), renders it into
 * the standard markdown format. Otherwise uses the raw content as-is.
 * Writes the final report to combinedResultPath for PR comment posting.
 */
export function readSummary(paths: Paths): string {
  core.startGroup('Reading test summary')

  const src = resolveSummarySource(paths)
  let summary: string

  if (src) {
    const raw = fs.readFileSync(src, 'utf-8')
    const report = tryParseReport(raw)
    if (report) {
      core.notice('Testbot report parsed from JSON')
      summary = renderReport(report)
    } else {
      core.info('Summary is not JSON — using raw content')
      summary = raw
    }
    fs.writeFileSync(paths.combinedResultPath, summary)
    core.notice('Testbot report ready')
  } else {
    core.warning('No summary file generated')
    summary = 'No summary available'
  }

  core.setOutput('test_summary', summary)
  core.endGroup()
  return summary
}

/**
 * Parse metrics (modified, created, executed counts) from the summary text.
 */
export function parseMetrics(summary: string): SummaryMetrics {
  core.startGroup('Parsing summary metrics')

  const extract = (keyword: string): number => {
    const match = summary.match(new RegExp(`${keyword}[^0-9]*(\\d+)`, 'i'))
    return match ? parseInt(match[1], 10) : 0
  }

  const metrics: SummaryMetrics = {
    modified: extract('modified'),
    created: extract('created'),
    executed: extract('executed'),
  }

  core.setOutput('tests_modified', String(metrics.modified))
  core.setOutput('tests_created', String(metrics.created))
  core.setOutput('tests_executed', String(metrics.executed))
  core.notice(`Metrics - Modified: ${metrics.modified}, Created: ${metrics.created}, Executed: ${metrics.executed}`)
  core.endGroup()

  return metrics
}
