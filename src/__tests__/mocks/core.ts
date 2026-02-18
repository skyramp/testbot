import { vi } from 'vitest'

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
  error: vi.fn(),
  setOutput: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setSecret: vi.fn(),
  exportVariable: vi.fn(),
  addPath: vi.fn(),
  setFailed: vi.fn(),
}))
