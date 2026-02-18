import './mocks/core'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRetry, secondsToMilliseconds } from '../utils'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('secondsToMilliseconds', async () => {
  it('converts correctly', async () => {
    expect(secondsToMilliseconds(1)).toBe(1000);
    expect(secondsToMilliseconds(123)).toBe(123000);
  })
});


describe('withRetry', () => {
  it('succeeds on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { retries: 3, delay: 1, label: 'test' })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success')

    const promise = withRetry(fn, { retries: 3, delay: 1, label: 'test' })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    const result = await promise
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('exhausts retries and throws the last error', async () => {
    const fn = vi.fn().mockImplementation(async () => {
      throw new Error('persistent failure')
    })

    const promise = withRetry(fn, { retries: 2, delay: 1, label: 'test' })

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    let caught: Error | undefined
    const catcher = promise.catch((e: Error) => { caught = e })

    await vi.advanceTimersByTimeAsync(1000)
    await catcher

    expect(caught).toBeDefined()
    expect(caught!.message).toBe('persistent failure')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
