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
export function tryParseReport(raw: string): TestbotReport | null {
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

interface RenderOptions {
  commitMessage?: string
  collapsed?: boolean
  /** When set, indicates this run was triggered by a @skyramp-testbot comment */
  userPrompt?: string
  /** When true, testbot auto-committed test changes */
  autoCommit?: boolean
}

/**
 * Render a TestbotReport into the standard markdown format.
 * When collapsed is true, each section is wrapped in a collapsible <details> block
 * and an optional commitMessage is rendered as a non-collapsed summary at the top.
 */
export function renderReport(report: TestbotReport, options: RenderOptions = {}): string {
  const { commitMessage, collapsed = false, userPrompt, autoCommit = false } = options
  const lines: string[] = []

  // Marker for identifying testbot comments
  lines.push('<!-- skyramp-testbot -->')

  // Minimal report: when no tests were created/executed and only issues found,
  // render just the issues (e.g. guardrail rejecting an unrelated @skyramp-testbot prompt)
  const isMinimalReport =
    report.newTestsCreated.length === 0 &&
    report.testResults.length === 0 &&
    report.testMaintenance.length === 0 &&
    report.issuesFound.length > 0
  if (isMinimalReport) {
    lines.push('### ⚠️ Skyramp Testbot')
    lines.push('')
    for (const issue of report.issuesFound) {
      lines.push(issue.description)
    }
    if (report.nextSteps && report.nextSteps.length > 0) {
      lines.push('')
      lines.push('### 💡 Next Steps')
      lines.push('')
      for (const step of report.nextSteps) {
        lines.push(`- ${step}`)
      }
    }
    return lines.join('\n')
  }

  const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>')

  // User prompt attribution (when triggered via @skyramp-testbot comment)
  if (userPrompt) {
    lines.push(`> Following user instruction: *${userPrompt}*`)
    lines.push('')
  }

  // Summary line (non-collapsed, shown at the top) — only when collapsed mode is on
  if (collapsed && commitMessage) {
    lines.push(`**Summary:** ${commitMessage}`)
    lines.push('')
  }

  const sectionStart = (title: string) => {
    if (collapsed) {
      lines.push('<details>')
      lines.push(`<summary>${title}</summary>`)
      lines.push('')
    } else {
      lines.push(`### ${title}`)
    }
  }

  const sectionEnd = () => {
    if (collapsed) {
      lines.push('')
      lines.push('</details>')
    }
    lines.push('')
  }

  // Business Case Analysis — rendered as a blockquote headline
  for (const bcaLine of report.businessCaseAnalysis.split(/\r?\n/)) {
    lines.push(`> ${bcaLine}`)
  }
  lines.push('')

  // Test Recommendations Implemented (omit if empty)
  if (report.newTestsCreated.length > 0) {
    sectionStart('💡 Test Recommendations Implemented')
    for (const t of report.newTestsCreated) {
      const id = t.testId ? ` [\`Test ID-${t.testId}\`]` : ''
      const endpoint = t.endpoint ? ` — \`${t.endpoint}\`` : ''
      const desc = t.description ? `: ${t.description}` : ''
      const file = t.fileName ? (t.description ? ` (\`${t.fileName}\`)` : `: \`${t.fileName}\``) : ''
      lines.push(`- ${t.testType}${id}${endpoint}${desc}${file}`)
    }
    sectionEnd()
  }

  // Additional Recommendations (omit if empty)
  if (report.additionalRecommendations && report.additionalRecommendations.length > 0) {
    const recs = report.additionalRecommendations
    const count = recs.length

    const priorityOrder = (p: string) => p === 'high' ? 0 : p === 'medium' ? 1 : 2
    const sorted = [...recs].sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority))

    sectionStart(`📌 Additional Recommendations (${count})`)
    lines.push('To generate any of these tests, mention `@skyramp-testbot` in a comment and ask to add them (e.g. `@skyramp-testbot add the contract test for /products`).')
    lines.push('')
    for (const rec of sorted) {
      const endpoint = rec.steps.length > 0 && rec.steps[0].method && rec.steps[0].path
        ? `\`${rec.steps[0].method} ${rec.steps[0].path}\``
        : ''
      const endpointSuffix = endpoint ? ` — ${endpoint}` : ''
      const id = rec.testId ? ` [\`Test ID-${rec.testId}\`]` : ''
      lines.push(`- **${rec.testType}**${id}${endpointSuffix}: ${rec.description}`)
    }
    sectionEnd()
  }

  // Test Maintenance (always show)
  sectionStart('✅ Test Maintenance')
  if (report.testMaintenance.length > 0) {
    const hasBeforeAfter = report.testMaintenance.some(
      m => typeof m === 'object' && m !== null && 'beforeStatus' in m,
    )
    if (hasBeforeAfter) {
      lines.push('| File | Change | Before | After |')
      lines.push('|------|--------|--------|-------|')
      for (const m of report.testMaintenance) {
        if (typeof m === 'object' && m !== null && 'beforeStatus' in m) {
          const before = `${m.beforeStatus} (${escapeCell(m.beforeDetails)})`
          const after = `${m.afterStatus} (${escapeCell(m.afterDetails)})`
          lines.push(`| \`${m.fileName}\` | ${escapeCell(m.description)} | ${before} | ${after} |`)
        } else {
          lines.push(`| — | ${escapeCell(m.description)} | — | — |`)
        }
      }
    } else {
      for (const m of report.testMaintenance) {
        lines.push(`- ${m.description}`)
      }
    }
  } else {
    lines.push('No existing Skyramp tests required maintenance for this PR.')
  }
  sectionEnd()

  // Test Results (always present)
  sectionStart('🧪 Test Results')
  lines.push('| Test Type | Endpoint | Status | Details |')
  lines.push('|-----------|----------|--------|---------|')
  for (const r of report.testResults) {
    lines.push(`| ${r.testType} | ${r.endpoint} | ${r.status} | ${r.details} |`)
  }
  sectionEnd()

  // Issues Found (omit if empty)
  if (report.issuesFound.length > 0) {
    sectionStart('⚠️ Issues Found')
    for (const issue of report.issuesFound) {
      lines.push(`- ${issue.description}`)
    }
    sectionEnd()
  }

  // Next Steps — always rendered open (not collapsible)
  const steps: string[] = [...(report.nextSteps ?? [])]
  const hasIssues = report.issuesFound.length > 0
  const hasTests = report.newTestsCreated.length > 0 || report.testMaintenance.length > 0 || report.testResults.length > 0
  if (hasTests && !hasIssues && steps.length === 0) {
    if (autoCommit) {
      steps.push('Let @skyramp-testbot know which additional recommendations to implement.')
    } else {
      steps.push('Enable `autoCommit: true` in your workflow to have Skyramp Testbot commit generated tests automatically.')
    }
  }
  if (steps.length > 0) {
    lines.push('### 💡 Next Steps')
    lines.push('')
    for (const step of steps) {
      lines.push(`- ${step}`)
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
export interface ReadSummaryResult {
  summary: string
  commitMessage?: string
  /** Parsed report object, if the summary was valid JSON. Available for post-hoc mutation + re-render. */
  report?: TestbotReport
  renderOptions: RenderOptions
}

 export function readSummary(paths: Paths, reportCollapsed = false, userPrompt?: string, autoCommit = false): ReadSummaryResult {
  core.startGroup('Reading test summary')

  const src = resolveSummarySource(paths)
  let summary: string
  let commitMessage: string | undefined
  let report: TestbotReport | undefined
  let renderOptions: RenderOptions = {}

  if (src) {
    const raw = fs.readFileSync(src, 'utf-8')
    const parsed = tryParseReport(raw)
    if (parsed) {
      core.notice('Testbot report parsed from JSON')
      report = parsed
      renderOptions = { commitMessage: report.commitMessage, collapsed: reportCollapsed, userPrompt, autoCommit }
      summary = renderReport(report, renderOptions)
      commitMessage = report.commitMessage
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
  return { summary, commitMessage, report, renderOptions }
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
