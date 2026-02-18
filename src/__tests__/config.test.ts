import './mocks/core'
import { describe, it, expect } from 'vitest'
import { getString, getBoolean, getNumber } from '../config'

describe('getString', () => {
  it('returns config value when present', () => {
    expect(getString({ key: 'hello' }, 'key', 'fallback')).toBe('hello')
  })

  it('returns fallback when key is missing', () => {
    expect(getString({}, 'key', 'fallback')).toBe('fallback')
  })

  it('returns fallback when value is null', () => {
    expect(getString({ key: null }, 'key', 'fallback')).toBe('fallback')
  })

  it('returns fallback when value is empty string', () => {
    expect(getString({ key: '' }, 'key', 'fallback')).toBe('fallback')
  })

  it('returns fallback when value is a number (not a string)', () => {
    expect(getString({ key: 42 }, 'key', 'fallback')).toBe('fallback')
  })
})

describe('getBoolean', () => {
  it('returns true for boolean true', () => {
    expect(getBoolean({ key: true }, 'key', false)).toBe(true)
  })

  it('returns false for boolean false', () => {
    expect(getBoolean({ key: false }, 'key', true)).toBe(false)
  })

  it('returns true for string "true"', () => {
    expect(getBoolean({ key: 'true' }, 'key', false)).toBe(true)
  })

  it('returns false for string "false"', () => {
    expect(getBoolean({ key: 'false' }, 'key', true)).toBe(false)
  })

  it('returns false for capitalized "True" (case-sensitive comparison)', () => {
    // The implementation uses strict === 'true', so "True" falls through to fallback
    expect(getBoolean({ key: 'True' }, 'key', false)).toBe(false)
  })

  it('returns fallback when key is missing', () => {
    expect(getBoolean({}, 'key', true)).toBe(true)
  })
})

describe('getNumber', () => {
  it('returns number value directly', () => {
    expect(getNumber({ key: 42 }, 'key', 0)).toBe(42)
  })

  it('parses string number', () => {
    expect(getNumber({ key: '99' }, 'key', 0)).toBe(99)
  })

  it('returns fallback for NaN string', () => {
    expect(getNumber({ key: 'abc' }, 'key', 7)).toBe(7)
  })

  it('returns fallback when key is missing', () => {
    expect(getNumber({}, 'key', 5)).toBe(5)
  })

  it('returns fallback for null value', () => {
    expect(getNumber({ key: null }, 'key', 10)).toBe(10)
  })
})
