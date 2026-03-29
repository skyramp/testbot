import './mocks/core'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    runId: 12345,
  },
}))

import { generateProgressBody, createInitialSteps, ProgressStep, formatElapsed } from '../progress'
import type { StepState } from '../progress'

/** Helper: advance steps up to a given step, marking prior as completed and target as active. */
function advanceTo(steps: StepState[], targetStep: ProgressStep, now = Date.now()): StepState[] {
  const result = steps.map(s => ({ ...s }))
  for (const s of result) {
    if (s.step === targetStep) {
      s.status = 'active'
      s.startedAt = now
      break
    }
    s.status = 'completed'
    s.startedAt = s.startedAt ?? now - 60000
    s.completedAt = s.completedAt ?? now
  }
  return result
}

describe('generateProgressBody', () => {
  it('all pending: all checkboxes unchecked', () => {
    const steps = createInitialSteps()
    const body = generateProgressBody(steps)
    expect(body).toContain('[ ] Setting up environment')
    expect(body).toContain('[ ] Analyzing code changes')
    expect(body).toContain('[ ] Generating tests')
  })

  it('setup active: shows spinner on setup', () => {
    const steps = createInitialSteps()
    steps[0].status = 'active'
    steps[0].startedAt = Date.now()
    const body = generateProgressBody(steps)
    expect(body).toMatch(/Setting up environment\.\.\./)
    expect(body).toContain('[ ] Analyzing code changes')
  })

  it('analyzing active: setup completed with elapsed time', () => {
    const steps = advanceTo(createInitialSteps(), ProgressStep.Analyzing)
    const body = generateProgressBody(steps)
    expect(body).toContain('[x] Setting up environment (')
    expect(body).toMatch(/Analyzing code changes\.\.\./)
    expect(body).toContain('[ ] Generating tests')
  })

  it('all completed: all checkboxes checked with elapsed times', () => {
    const now = Date.now()
    const steps = createInitialSteps()
    for (const s of steps) {
      s.status = 'completed'
      s.startedAt = now - 60000
      s.completedAt = now
    }
    const body = generateProgressBody(steps)
    expect(body).toContain('[x] Setting up environment (1m 0s)')
    expect(body).toContain('[x] Generating report (1m 0s)')
  })

  it('replaces checklist with report content when provided', () => {
    const steps = createInitialSteps()
    const body = generateProgressBody(steps, '### Test Report\nAll passed.')
    expect(body).toContain('### Test Report\nAll passed.')
    expect(body).toContain('workflow run')
    expect(body).not.toContain('Setting up environment')
  })

  it('does not append anything when reportContent is undefined', () => {
    const steps = createInitialSteps()
    const body = generateProgressBody(steps)
    expect(body).not.toContain('undefined')
  })

  it('includes workflow run link', () => {
    const steps = createInitialSteps()
    const body = generateProgressBody(steps)
    expect(body).toContain('actions/runs/12345')
    expect(body).toContain('workflow run')
  })

  it('shows comment trigger label', () => {
    const steps = createInitialSteps(true)
    steps[1].status = 'active'
    steps[1].startedAt = Date.now()
    const body = generateProgressBody(steps)
    expect(body).toContain('Analyzing user request')
    expect(body).not.toContain('Analyzing code changes')
  })
})

describe('formatElapsed', () => {
  it('formats seconds under 60', () => {
    expect(formatElapsed(45000)).toBe('45s')
  })

  it('formats minutes and seconds', () => {
    expect(formatElapsed(135000)).toBe('2m 15s')
  })

  it('formats zero', () => {
    expect(formatElapsed(0)).toBe('0s')
  })

  it('rounds down partial seconds', () => {
    expect(formatElapsed(45999)).toBe('45s')
  })
})

describe('createInitialSteps', () => {
  it('creates 6 steps all pending', () => {
    const steps = createInitialSteps()
    expect(steps).toHaveLength(6)
    expect(steps.every(s => s.status === 'pending')).toBe(true)
  })

  it('uses comment trigger label when isCommentTrigger is true', () => {
    const steps = createInitialSteps(true)
    expect(steps[1].label).toBe('Analyzing user request')
  })

  it('uses PR label by default', () => {
    const steps = createInitialSteps()
    expect(steps[1].label).toBe('Analyzing code changes')
  })

  it('has correct step order', () => {
    const steps = createInitialSteps()
    expect(steps.map(s => s.step)).toEqual([
      ProgressStep.Setup,
      ProgressStep.Analyzing,
      ProgressStep.Generating,
      ProgressStep.Executing,
      ProgressStep.Maintaining,
      ProgressStep.Reporting,
    ])
  })
})
