import './mocks/core'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    runId: 12345,
  },
}))

import { generateProgressBody } from '../progress'

describe('generateProgressBody', () => {
  it('step 0: all checkboxes unchecked', () => {
    const body = generateProgressBody(0)
    expect(body).toContain('[ ] Analyzing Pull Request')
    expect(body).toContain('[ ] Running tests')
    expect(body).toContain('[ ] Generating report')
  })

  it('step 1: first checkbox checked', () => {
    const body = generateProgressBody(1)
    expect(body).toContain('[x] Analyzing Pull Request')
    expect(body).toContain('[ ] Running tests')
    expect(body).toContain('[ ] Generating report')
  })

  it('step 2: first two checkboxes checked', () => {
    const body = generateProgressBody(2)
    expect(body).toContain('[x] Analyzing Pull Request')
    expect(body).toContain('[x] Running tests')
    expect(body).toContain('[ ] Generating report')
  })

  it('step 3: all checkboxes checked', () => {
    const body = generateProgressBody(3)
    expect(body).toContain('[x] Analyzing Pull Request')
    expect(body).toContain('[x] Running tests')
    expect(body).toContain('[x] Generating report')
  })

  it('replaces checklist with report content when provided', () => {
    const body = generateProgressBody(3, '### Test Report\nAll passed.')
    expect(body).toContain('### Test Report\nAll passed.')
    expect(body).toContain('workflow run')
    // Checklist should be gone
    expect(body).not.toContain('Analyzing')
    expect(body).not.toContain('Running tests')
    expect(body).not.toContain('Generating report')
  })

  it('does not append anything when reportContent is undefined', () => {
    const body = generateProgressBody(3)
    // Body should end after the checklist (with no trailing double newline)
    expect(body.trimEnd().endsWith('Generating report')).toBe(true)
  })

  it('includes workflow run link', () => {
    const body = generateProgressBody(1)
    expect(body).toContain('actions/runs/12345')
    expect(body).toContain('workflow run')
  })

  it('shows "Analyzing user request" for comment-triggered runs', () => {
    const body = generateProgressBody(1, undefined, true)
    expect(body).toContain('Analyzing user request')
    expect(body).not.toContain('Analyzing Pull Request')
  })

  it('shows "Analyzing Pull Request" for normal runs', () => {
    const body = generateProgressBody(1, undefined, false)
    expect(body).toContain('Analyzing Pull Request')
    expect(body).not.toContain('Analyzing user request')
  })
})
