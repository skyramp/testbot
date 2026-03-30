import * as fs from 'fs'

import { ProgressStep } from './progress'
import type { StepState } from './progress'
import { debug } from './utils'

// ── Tool-to-step mapping ────────────────────────────────────────────────────

/** Default fallback map — used when the MCP package map is unavailable. */
const DEFAULT_PHASE_MAP: Record<string, string> = {
  skyramp_recommend_tests: 'analyzing',
  skyramp_analyze_changes: 'analyzing',
  skyramp_execute_test: 'executing',
  skyramp_execute_tests: 'executing',
  skyramp_execute_tests_batch: 'executing',
  skyramp_analyze_test_health: 'maintaining',
  skyramp_submit_report: 'reporting',
}

/** Active mapping — starts as default, overwritten by loadToolPhaseMap(). */
let activePhaseMap: Record<string, string> = { ...DEFAULT_PHASE_MAP }

/**
 * Load tool-to-phase mapping from the installed @skyramp/mcp package.
 * Falls back silently to the default map if the package or export is unavailable.
 */
export function loadToolPhaseMap(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@skyramp/mcp/tool-phases')
    const map = mod.TOOL_PHASE_MAP
    if (map && typeof map === 'object' && Object.keys(map).length > 0) {
      activePhaseMap = map as Record<string, string>
      debug(`Loaded ${Object.keys(activePhaseMap).length} tool-phase mappings from @skyramp/mcp`)
    }
  } catch {
    debug('Could not load tool-phase map from @skyramp/mcp, using defaults')
  }
}

/** Convert a phase string to a ProgressStep enum value. */
export function phaseToStep(phase: string): ProgressStep | null {
  switch (phase) {
    case 'analyzing': return ProgressStep.Analyzing
    case 'generating': return ProgressStep.Generating
    case 'executing': return ProgressStep.Executing
    case 'maintaining': return ProgressStep.Maintaining
    case 'reporting': return ProgressStep.Reporting
    default: return null
  }
}

/** Map a tool name to a progress step, or null if not recognized. */
export function toolToStep(rawName: string): ProgressStep | null {
  // Strip mcp__skyramp__ prefix (Claude Code format)
  const name = rawName.startsWith('mcp__skyramp__') ? rawName.slice('mcp__skyramp__'.length) : rawName

  const phase = activePhaseMap[name]
  if (phase) return phaseToStep(phase)

  // Fallback: substring match for test generation tools not in the map
  if (name.includes('test_generation')) return ProgressStep.Generating

  return null
}

// ── Step advancement ────────────────────────────────────────────────────────

const STEP_ORDER: ProgressStep[] = [
  ProgressStep.Setup,
  ProgressStep.Analyzing,
  ProgressStep.Maintaining,
  ProgressStep.Generating,
  ProgressStep.Executing,
  ProgressStep.Reporting,
]

/**
 * Advance the step list to the given target step.
 * Completes all steps before the target (with `now` as completedAt).
 * Sets the target step to 'active'.
 * Returns true if the state changed, false if already at or past the target.
 */
export function advanceSteps(steps: StepState[], targetStep: ProgressStep, now: number): boolean {
  const targetIdx = STEP_ORDER.indexOf(targetStep)
  if (targetIdx < 0) return false

  const activeIdx = steps.findIndex(s => s.status === 'active')
  if (activeIdx >= 0 && activeIdx >= targetIdx) return false
  if (steps[targetIdx].status === 'completed') return false

  for (let i = 0; i < targetIdx; i++) {
    if (steps[i].status === 'active') {
      steps[i].status = 'completed'
      steps[i].completedAt = now
    } else if (steps[i].status === 'pending') {
      steps[i].status = 'completed'
      steps[i].startedAt = now
      steps[i].completedAt = now
    }
  }

  steps[targetIdx].status = 'active'
  steps[targetIdx].startedAt = now

  return true
}

// ── NDJSON line parsing ─────────────────────────────────────────────────────

/** Extract tool names from a single NDJSON line (Claude Code assistant event format). */
export function extractToolNames(line: string): string[] {
  try {
    const obj = JSON.parse(line)
    if (obj.type !== 'assistant') return []
    const content = obj.message?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((block: { type?: string }) => block.type === 'tool_use')
      .map((block: { name: string }) => block.name)
  } catch {
    return []
  }
}

// ── Progress tracker ────────────────────────────────────────────────────────

/** Max bytes to read per poll cycle to avoid large memory spikes. */
const MAX_READ_BYTES = 1024 * 1024 // 1 MB

export interface ProgressTrackerOptions {
  logFile: string
  steps: StepState[]
  onStepChange: (steps: StepState[]) => void | Promise<void>
  pollIntervalMs?: number
}

export interface ProgressTrackerHandle {
  start(): void
  stop(): void
}

export function createProgressTracker(opts: ProgressTrackerOptions): ProgressTrackerHandle {
  const { logFile, steps, onStepChange, pollIntervalMs = 500 } = opts
  let readPosition = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  // Carry incomplete lines between polls (partial NDJSON line at chunk boundary)
  let leftover = ''

  function processNewLines(): void {
    if (!fs.existsSync(logFile)) return

    const stat = fs.statSync(logFile)
    if (stat.size <= readPosition) return

    // Cap read size to avoid large memory spikes
    const bytesToRead = Math.min(stat.size - readPosition, MAX_READ_BYTES)

    const fd = fs.openSync(logFile, 'r')
    const buf = Buffer.alloc(bytesToRead)
    fs.readSync(fd, buf, 0, buf.length, readPosition)
    fs.closeSync(fd)
    readPosition += bytesToRead

    const chunk = leftover + buf.toString('utf-8')
    const parts = chunk.split('\n')

    // Last element is either empty (chunk ended with \n) or a partial line — carry it forward
    leftover = parts.pop() ?? ''

    const lines = parts.filter(l => l.trim())

    let changed = false
    const now = Date.now()

    for (const line of lines) {
      const toolNames = extractToolNames(line)
      for (const toolName of toolNames) {
        const targetStep = toolToStep(toolName)
        if (targetStep && advanceSteps(steps, targetStep, now)) {
          debug(`Progress: advanced to ${targetStep} (tool: ${toolName})`)
          changed = true
        }
      }
    }

    if (changed) {
      // Handle both sync and async callbacks safely
      try {
        const result = onStepChange(steps)
        if (result && typeof (result as Promise<void>).catch === 'function') {
          ;(result as Promise<void>).catch(err => {
            debug(`Error in onStepChange: ${err instanceof Error ? err.message : String(err)}`)
          })
        }
      } catch (err) {
        debug(`Error in onStepChange: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return {
    start(): void {
      stopped = false
      readPosition = 0
      leftover = ''
      pollTimer = setInterval(() => {
        if (!stopped) processNewLines()
      }, pollIntervalMs)
    },

    stop(): void {
      stopped = true
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      // Process any remaining complete lines
      processNewLines()
      // Flush leftover as a final line attempt (in case file didn't end with \n)
      if (leftover.trim()) {
        const toolNames = extractToolNames(leftover)
        const now = Date.now()
        for (const toolName of toolNames) {
          const targetStep = toolToStep(toolName)
          if (targetStep) advanceSteps(steps, targetStep, now)
        }
        leftover = ''
      }
      // Mark current active step as completed
      const now = Date.now()
      for (const s of steps) {
        if (s.status === 'active') {
          s.status = 'completed'
          s.completedAt = now
          break
        }
      }
    },
  }
}
