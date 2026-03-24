import * as fs from 'fs'
import * as readline from 'readline'
import { exec, debug } from './utils'

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalCostUsd: number
  numTurns: number
  durationMs: number
  durationApiMs: number
}

export interface AgentLogSummary {
  usage: AgentUsage | null
  model: string | null
}

/**
 * Single-pass extraction of model and token usage from a Claude Code stream-json NDJSON log.
 * Model is found in assistant message events; usage is in the final `result` event.
 */
export async function extractAgentLogSummary(logFilePath: string): Promise<AgentLogSummary> {
  if (!fs.existsSync(logFilePath)) return { usage: null, model: null }

  const rl = readline.createInterface({
    input: fs.createReadStream(logFilePath),
    crlfDelay: Infinity,
  })

  let usage: AgentUsage | null = null
  let model: string | null = null

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)

      // Model appears in assistant message events
      if (!model && obj.type === 'assistant') {
        const msgModel = obj.message?.model
        if (typeof msgModel === 'string') model = msgModel
      }

      if (obj.type === 'result') {
        // Token counts are nested under obj.usage (not top-level)
        const u = obj.usage ?? {}
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          totalCostUsd: obj.total_cost_usd ?? 0,
          numTurns: obj.num_turns ?? 0,
          durationMs: obj.duration_ms ?? 0,
          durationApiMs: obj.duration_api_ms ?? 0,
        }
      }
    } catch {
      continue
    }
  }

  return { usage, model }
}

/**
 * Push agent usage telemetry to Amplitude via @skyramp/skyramp's pushToolEvent.
 *
 * Uses `node -e` with NODE_PATH (set by mcp.ts during MCP installation) so the
 * native @skyramp/skyramp binary is available without bundling it into dist/.
 */
export async function pushAgentUsageEvent(usage: AgentUsage, model: string, licensePath: string): Promise<void> {
  const params = {
    inputTokens: String(usage.inputTokens),
    outputTokens: String(usage.outputTokens),
    cacheCreationInputTokens: String(usage.cacheCreationInputTokens),
    cacheReadInputTokens: String(usage.cacheReadInputTokens),
    totalCostUsd: String(usage.totalCostUsd),
    numTurns: String(usage.numTurns),
    durationMs: String(usage.durationMs),
    durationApiMs: String(usage.durationApiMs),
    model,
  }

  debug(`Pushing agent usage telemetry: ${JSON.stringify(params)}`)

  // Native .so reads LICENSE_FILE for auth context and CI for telemetry routing
  await exec('node', ['-e', `
    const { pushToolEvent } = require('@skyramp/skyramp');
    pushToolEvent('testbot', 'testbot_agent_usage', '', ${JSON.stringify(params)})
      .then(() => process.exit(0))
      .catch(e => { console.error(e.message); process.exit(1); });
  `], {
    silent: true,
    env: {
      NODE_PATH: process.env.NODE_PATH || '',
      LICENSE_FILE: licensePath,
      CI: 'true',
    },
  })
}
