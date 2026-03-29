import './mocks/core'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { toolToStep, advanceSteps, extractToolNames, createProgressTracker, loadToolPhaseMap, phaseToStep } from '../progress-tracker'
import { ProgressStep, createInitialSteps } from '../progress'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Need the github mock for createInitialSteps used indirectly
import { vi } from 'vitest'
vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    runId: 12345,
  },
}))

describe('toolToStep', () => {
  it('maps skyramp_recommend_tests to Analyzing', () => {
    expect(toolToStep('skyramp_recommend_tests')).toBe(ProgressStep.Analyzing)
  })

  it('maps skyramp_analyze_changes to Analyzing', () => {
    expect(toolToStep('skyramp_analyze_changes')).toBe(ProgressStep.Analyzing)
  })

  it('maps skyramp_contract_test_generation to Generating', () => {
    expect(toolToStep('skyramp_contract_test_generation')).toBe(ProgressStep.Generating)
  })

  it('maps skyramp_fuzz_test_generation to Generating', () => {
    expect(toolToStep('skyramp_fuzz_test_generation')).toBe(ProgressStep.Generating)
  })

  it('maps skyramp_execute_test to Executing', () => {
    expect(toolToStep('skyramp_execute_test')).toBe(ProgressStep.Executing)
  })

  it('maps skyramp_execute_tests to Executing', () => {
    expect(toolToStep('skyramp_execute_tests')).toBe(ProgressStep.Executing)
  })

  it('maps skyramp_execute_tests_batch to Executing', () => {
    expect(toolToStep('skyramp_execute_tests_batch')).toBe(ProgressStep.Executing)
  })

  it('maps skyramp_analyze_test_health to Maintaining', () => {
    expect(toolToStep('skyramp_analyze_test_health')).toBe(ProgressStep.Maintaining)
  })

  it('maps skyramp_submit_report to Reporting', () => {
    expect(toolToStep('skyramp_submit_report')).toBe(ProgressStep.Reporting)
  })

  it('returns null for unknown tools', () => {
    expect(toolToStep('Read')).toBeNull()
    expect(toolToStep('Bash')).toBeNull()
    expect(toolToStep('skyramp_login')).toBeNull()
  })

  it('strips mcp__skyramp__ prefix', () => {
    expect(toolToStep('mcp__skyramp__skyramp_recommend_tests')).toBe(ProgressStep.Analyzing)
    expect(toolToStep('mcp__skyramp__skyramp_execute_test')).toBe(ProgressStep.Executing)
  })
})

describe('advanceSteps', () => {
  it('advances to the target step, completing prior steps', () => {
    const steps = createInitialSteps()
    steps[0].status = 'active'
    steps[0].startedAt = 1000

    const changed = advanceSteps(steps, ProgressStep.Generating, 5000)
    expect(changed).toBe(true)

    expect(steps[0].status).toBe('completed')
    expect(steps[0].completedAt).toBe(5000)
    expect(steps[1].status).toBe('completed')
    expect(steps[1].completedAt).toBe(5000)
    expect(steps[2].status).toBe('active')
    expect(steps[2].startedAt).toBe(5000)
    expect(steps[3].status).toBe('pending')
    expect(steps[4].status).toBe('pending')
    expect(steps[5].status).toBe('pending')
  })

  it('does not go backwards', () => {
    const steps = createInitialSteps()
    steps[0].status = 'completed'
    steps[0].startedAt = 1000
    steps[0].completedAt = 2000
    steps[1].status = 'completed'
    steps[1].startedAt = 2000
    steps[1].completedAt = 3000
    steps[2].status = 'active'
    steps[2].startedAt = 3000

    const changed = advanceSteps(steps, ProgressStep.Analyzing, 4000)
    expect(changed).toBe(false)
    expect(steps[2].status).toBe('active')
  })

  it('returns false if already at the target step', () => {
    const steps = createInitialSteps()
    steps[0].status = 'completed'
    steps[1].status = 'active'
    steps[1].startedAt = 2000

    const changed = advanceSteps(steps, ProgressStep.Analyzing, 3000)
    expect(changed).toBe(false)
  })

  it('skips forward with zero-elapsed intermediate steps', () => {
    const steps = createInitialSteps()
    steps[0].status = 'active'
    steps[0].startedAt = 1000

    advanceSteps(steps, ProgressStep.Executing, 5000)

    expect(steps[1].status).toBe('completed')
    expect(steps[1].startedAt).toBe(5000)
    expect(steps[1].completedAt).toBe(5000)
    expect(steps[2].status).toBe('completed')
    expect(steps[2].startedAt).toBe(5000)
    expect(steps[2].completedAt).toBe(5000)
    expect(steps[3].status).toBe('active')
    expect(steps[3].startedAt).toBe(5000)
  })
})

describe('extractToolNames', () => {
  it('extracts tool names from a Claude Code assistant NDJSON line', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me analyze...' },
          { type: 'tool_use', id: 'tu_1', name: 'mcp__skyramp__skyramp_recommend_tests', input: {} },
        ],
      },
    })
    expect(extractToolNames(line)).toEqual(['mcp__skyramp__skyramp_recommend_tests'])
  })

  it('extracts multiple tool names from one line', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'mcp__skyramp__skyramp_execute_test', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'Read', input: {} },
        ],
      },
    })
    expect(extractToolNames(line)).toEqual(['mcp__skyramp__skyramp_execute_test', 'Read'])
  })

  it('returns empty array for non-assistant lines', () => {
    expect(extractToolNames(JSON.stringify({ type: 'user' }))).toEqual([])
    expect(extractToolNames(JSON.stringify({ type: 'system' }))).toEqual([])
  })

  it('returns empty array for malformed JSON', () => {
    expect(extractToolNames('not json')).toEqual([])
  })

  it('returns empty array for assistant message with no tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    })
    expect(extractToolNames(line)).toEqual([])
  })
})

describe('createProgressTracker', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-tracker-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('advances steps when tool calls appear in the log file', async () => {
    const logFile = path.join(tmpDir, 'agent-log.ndjson')
    fs.writeFileSync(logFile, '')

    const steps = createInitialSteps()
    steps[0].status = 'completed'
    steps[0].startedAt = Date.now() - 5000
    steps[0].completedAt = Date.now()
    steps[1].status = 'active'
    steps[1].startedAt = Date.now()

    let updateCount = 0
    const tracker = createProgressTracker({
      logFile,
      steps,
      pollIntervalMs: 50,
      onStepChange: () => { updateCount++ },
    })

    tracker.start()

    // Simulate agent writing a tool call to the log
    fs.appendFileSync(logFile, JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__skyramp__skyramp_contract_test_generation', input: {} }],
      },
    }) + '\n')

    // Wait for poll cycle
    await new Promise(r => setTimeout(r, 200))

    tracker.stop()

    expect(steps[1].status).toBe('completed')
    expect(steps[2].status).toBe('completed') // stop() completes current active step
    expect(updateCount).toBeGreaterThanOrEqual(1)
  })

  it('stop() marks current active step as completed', async () => {
    const logFile = path.join(tmpDir, 'agent-log.ndjson')
    fs.writeFileSync(logFile, '')

    const steps = createInitialSteps()
    steps[0].status = 'completed'
    steps[1].status = 'active'
    steps[1].startedAt = Date.now()

    const tracker = createProgressTracker({
      logFile,
      steps,
      pollIntervalMs: 50,
      onStepChange: () => {},
    })

    tracker.start()
    await new Promise(r => setTimeout(r, 100))
    tracker.stop()

    expect(steps[1].status).toBe('completed')
    expect(steps[1].completedAt).toBeDefined()
  })
})

describe('phaseToStep', () => {
  it('maps valid phase strings to ProgressStep', () => {
    expect(phaseToStep('analyzing')).toBe(ProgressStep.Analyzing)
    expect(phaseToStep('generating')).toBe(ProgressStep.Generating)
    expect(phaseToStep('executing')).toBe(ProgressStep.Executing)
    expect(phaseToStep('maintaining')).toBe(ProgressStep.Maintaining)
    expect(phaseToStep('reporting')).toBe(ProgressStep.Reporting)
  })

  it('returns null for unknown phases', () => {
    expect(phaseToStep('unknown')).toBeNull()
    expect(phaseToStep('')).toBeNull()
  })
})

describe('loadToolPhaseMap', () => {
  it('falls back gracefully when @skyramp/mcp is not installed', () => {
    // In test environment, @skyramp/mcp is not installed — should not throw
    loadToolPhaseMap()
    // toolToStep should still work with defaults
    expect(toolToStep('skyramp_recommend_tests')).toBe(ProgressStep.Analyzing)
    expect(toolToStep('skyramp_execute_test')).toBe(ProgressStep.Executing)
    expect(toolToStep('skyramp_submit_report')).toBe(ProgressStep.Reporting)
  })
})
