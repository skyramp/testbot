import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { extractAgentLogSummary } from '../telemetry'

describe('extractAgentLogSummary', () => {
  const tmpFiles: string[] = []

  function writeTmpNdjson(lines: string[]): string {
    const filePath = path.join(os.tmpdir(), `test-log-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`)
    fs.writeFileSync(filePath, lines.join('\n') + '\n')
    tmpFiles.push(filePath)
    return filePath
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      fs.rmSync(f, { force: true })
    }
    tmpFiles.length = 0
  })

  it('extracts model and token usage from nested usage object', async () => {
    const logFile = writeTmpNdjson([
      '{"type":"system","subtype":"init","claude_code_version":"1.0.0","session_id":"test"}',
      '{"type":"assistant","timestamp_ms":1000,"message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"result","duration_ms":5000,"duration_api_ms":4500,"num_turns":3,"total_cost_usd":0.0512,"usage":{"input_tokens":53,"output_tokens":3500,"cache_creation_input_tokens":10000,"cache_read_input_tokens":200000}}',
    ])

    const { model, usage } = await extractAgentLogSummary(logFile)
    expect(model).toBe('claude-sonnet-4-20250514')
    expect(usage).not.toBeNull()
    expect(usage!.inputTokens).toBe(53)
    expect(usage!.outputTokens).toBe(3500)
    expect(usage!.cacheCreationInputTokens).toBe(10000)
    expect(usage!.cacheReadInputTokens).toBe(200000)
    expect(usage!.totalCostUsd).toBe(0.0512)
    expect(usage!.numTurns).toBe(3)
    expect(usage!.durationMs).toBe(5000)
    expect(usage!.durationApiMs).toBe(4500)
  })

  it('returns nulls when no result event or model', async () => {
    const logFile = writeTmpNdjson([
      '{"type":"system","subtype":"init","claude_code_version":"1.0.0"}',
    ])

    const { model, usage } = await extractAgentLogSummary(logFile)
    expect(model).toBeNull()
    expect(usage).toBeNull()
  })

  it('returns nulls for non-existent file', async () => {
    const { model, usage } = await extractAgentLogSummary('/tmp/does-not-exist-12345.ndjson')
    expect(model).toBeNull()
    expect(usage).toBeNull()
  })

  it('handles missing usage fields with defaults', async () => {
    const logFile = writeTmpNdjson([
      '{"type":"result","usage":{"input_tokens":1000,"output_tokens":500}}',
    ])

    const { usage } = await extractAgentLogSummary(logFile)
    expect(usage).not.toBeNull()
    expect(usage!.inputTokens).toBe(1000)
    expect(usage!.outputTokens).toBe(500)
    expect(usage!.cacheCreationInputTokens).toBe(0)
    expect(usage!.cacheReadInputTokens).toBe(0)
    expect(usage!.totalCostUsd).toBe(0)
    expect(usage!.numTurns).toBe(0)
  })

  it('handles missing usage object entirely', async () => {
    const logFile = writeTmpNdjson([
      '{"type":"result","total_cost_usd":1.5,"num_turns":10}',
    ])

    const { usage } = await extractAgentLogSummary(logFile)
    expect(usage).not.toBeNull()
    expect(usage!.inputTokens).toBe(0)
    expect(usage!.outputTokens).toBe(0)
    expect(usage!.totalCostUsd).toBe(1.5)
    expect(usage!.numTurns).toBe(10)
  })

  it('skips malformed JSON lines', async () => {
    const logFile = writeTmpNdjson([
      'not valid json',
      '{"type":"result","usage":{"input_tokens":999,"output_tokens":111}}',
    ])

    const { usage } = await extractAgentLogSummary(logFile)
    expect(usage).not.toBeNull()
    expect(usage!.inputTokens).toBe(999)
  })
})
