import './mocks/core'
import { describe, it, expect } from 'vitest'
import { generateProgressBody } from '../progress'

describe('generateProgressBody', () => {
  it('step 0: all checkboxes unchecked, spinner shown', () => {
    const body = generateProgressBody(0)
    expect(body).toContain('[ ] Analyzing code changes')
    expect(body).toContain('[ ] Running tests')
    expect(body).toContain('[ ] Generating report')
    expect(body).toContain('progress-spinner.gif')
  })

  it('step 1: first checkbox checked', () => {
    const body = generateProgressBody(1)
    expect(body).toContain('[x] Analyzing code changes')
    expect(body).toContain('[ ] Running tests')
    expect(body).toContain('[ ] Generating report')
    expect(body).toContain('progress-spinner.gif')
  })

  it('step 2: first two checkboxes checked', () => {
    const body = generateProgressBody(2)
    expect(body).toContain('[x] Analyzing code changes')
    expect(body).toContain('[x] Running tests')
    expect(body).toContain('[ ] Generating report')
    expect(body).toContain('progress-spinner.gif')
  })

  it('step 3: all checkboxes checked, no spinner', () => {
    const body = generateProgressBody(3)
    expect(body).toContain('[x] Analyzing code changes')
    expect(body).toContain('[x] Running tests')
    expect(body).toContain('[x] Generating report')
    expect(body).not.toContain('progress-spinner.gif')
  })

  it('appends report content when provided', () => {
    const body = generateProgressBody(3, '### Test Report\nAll passed.')
    expect(body).toContain('### Test Report\nAll passed.')
  })

  it('does not append anything when reportContent is undefined', () => {
    const body = generateProgressBody(3)
    // Body should end after the checklist (with no trailing double newline)
    expect(body.endsWith('Generating report')).toBe(true)
  })
})
