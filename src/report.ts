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

// Shared comparator for additional recommendations — used in both the
// Additional Recommendations section and the Next Steps top-2 pick.
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }
const CATEGORY_RISK: Record<string, number> = {
  security_boundary: 0,
  breaking_change: 1,
  data_integrity: 2,
  business_rule: 3,
  workflow: 4,
}

type RecLike = {
  testType: string
  category?: string
  priority?: string
  scenarioName?: string
  steps: { expectedStatusCode?: number }[]
}

function sortRecommendations(
  a: RecLike,
  b: RecLike,
  typeOrder: Record<string, number>,
  typeKey: (t: string) => string,
): number {
  // 1. Test type: contract → integration → e2e → ui
  const ta = typeOrder[typeKey(a.testType)] ?? 99
  const tb = typeOrder[typeKey(b.testType)] ?? 99
  if (ta !== tb) return ta - tb
  // 2. Priority: high → medium → low
  const pa = PRIORITY_ORDER[(a.priority ?? '').toLowerCase()] ?? 99
  const pb = PRIORITY_ORDER[(b.priority ?? '').toLowerCase()] ?? 99
  if (pa !== pb) return pa - pb
  // 3. Category risk: security_boundary → ... → workflow
  const ca = CATEGORY_RISK[a.category ?? ''] ?? 99
  const cb = CATEGORY_RISK[b.category ?? ''] ?? 99
  if (ca !== cb) return ca - cb
  // 4. Error/edge-case step boost: tests expecting 4xx/5xx sort before happy-path
  const errA = a.steps.some(s => (s.expectedStatusCode ?? 0) >= 400) ? 0 : 1
  const errB = b.steps.some(s => (s.expectedStatusCode ?? 0) >= 400) ? 0 : 1
  if (errA !== errB) return errA - errB
  // 5. Alphabetical by scenarioName
  return (a.scenarioName ?? '').localeCompare(b.scenarioName ?? '')
}

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
      const id = t.testId ? `\`${t.testId}\`` : t.testType
      const endpointLine = t.endpoint ? `\n  \`${t.endpoint}\`` : ''
      const desc = t.description ? `\n  ${t.description}` : ''
      const file = t.fileName ? ` (\`${t.fileName}\`)` : ''
      lines.push(`- ${id}${file}${endpointLine}${desc}`)
    }
    sectionEnd()
  }

  // Additional Recommendations (omit if empty)
  if (report.additionalRecommendations && report.additionalRecommendations.length > 0) {
    const recs = report.additionalRecommendations
    const count = recs.length

    // Test type order: Contract (quick wins) → Integration → E2E → UI (most effort)
    const TEST_TYPE_ORDER: Record<string, number> = {
      contract: 0,
      integration: 1,
      e2e: 2,
      ui: 3,
    }
    const TEST_TYPE_LABEL: Record<string, string> = {
      contract: '📋 Contract',
      integration: '🔗 Integration',
      e2e: '🌐 E2E',
      ui: '🖥️ UI',
    }
    const typeKey = (t: string) => t.toLowerCase()
    const sorted = [...recs].sort((a, b) => sortRecommendations(a, b, TEST_TYPE_ORDER, typeKey))

    // Group by test type
    const groups = new Map<string, typeof sorted>()
    for (const rec of sorted) {
      const key = typeKey(rec.testType)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(rec)
    }

    sectionStart(`📌 Additional Recommendations (${count})`)
    lines.push('To generate any of these tests, mention `@skyramp-testbot` in a comment and ask to add them (e.g. `@skyramp-testbot add the contract test for /products`).')
    lines.push('')
    for (const [type, groupRecs] of groups) {
      const label = TEST_TYPE_LABEL[type] ?? type
      lines.push(`**${label}**`)
      lines.push('')
      for (const rec of groupRecs) {
        const endpoint = rec.steps.length > 0 && rec.steps[0].method && rec.steps[0].path
          ? `\`${rec.steps[0].method} ${rec.steps[0].path}\``
          : ''
        const idLabel = rec.testId
          ? `\`${rec.testId}\``
          : rec.scenarioName
            ? `\`${rec.scenarioName}\``
            : `\`${rec.testType} test\``
        const prefix = `- ${idLabel}`
        const endpointLine = endpoint ? `\n  ${endpoint}` : ''
        lines.push(`${prefix}${endpointLine}\n  ${rec.description}`)
      }
      lines.push('')
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

  // Surface top 2 additional recommendations as call-to-action (from sorted order)
  const NEXT_STEPS_TYPE_ORDER: Record<string, number> = { contract: 0, integration: 1, e2e: 2, ui: 3 }
  const sortedRecs = [...(report.additionalRecommendations ?? [])].sort((a, b) =>
    sortRecommendations(a, b, NEXT_STEPS_TYPE_ORDER, (t: string) => t.toLowerCase()),
  )
  const topRecs = sortedRecs.slice(0, 2)

  if (hasTests && !hasIssues && steps.length === 0 && topRecs.length === 0 && !autoCommit) {
    steps.push('Enable `autoCommit: true` in your workflow to have Skyramp Testbot commit generated tests automatically.')
  }
  if (steps.length > 0 || topRecs.length > 0) {
    lines.push('### 💡 Next Steps')
    lines.push('')
    for (const step of steps) {
      lines.push(`- ${step}`)
    }
    if (topRecs.length > 0) {
      lines.push('')
      lines.push('Use `@skyramp-testbot` to implement additional recommendations. Based on my analysis of the diff, I would recommend:')
      lines.push('')
      topRecs.forEach((rec, i) => {
        const name = rec.testId ? `**${rec.testId}**` : `**${rec.scenarioName ?? rec.testType}**`
        const reasoning = rec.reasoning ?? rec.description
        lines.push(`${i + 1}. ${name} — ${reasoning}`)
      })
    }
    lines.push('')
  }

  return escapeIssueReferences(lines.join('\n'))
}

/**
 * Escape `#<number>` patterns so GitHub Flavored Markdown doesn't convert
 * them into issue/PR auto-links (e.g. "#3" → link to PR #3).
 * Wraps `#` in an HTML span to break the autolink pattern while rendering
 * identically. HTML entities and backslash escaping do NOT work — GitHub
 * resolves them before autolink processing.
 */
export function escapeIssueReferences(markdown: string): string {
  return markdown.replace(/#(\d)/g, '<span>#</span>$1')
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
