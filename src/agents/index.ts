import type { AgentType } from '../types'
import { AgentStrategy } from '../types'
import { CursorAgent } from './cursor'
import { CopilotAgent } from './copilot'
import { ClaudeAgent } from './claude'

export function createAgent(type: AgentType): AgentStrategy {
  switch (type) {
    case 'cursor': return new CursorAgent()
    case 'copilot': return new CopilotAgent()
    case 'claude': return new ClaudeAgent()
    default: {
      const _exhaustive: never = type
      throw new Error(`Unsupported agent type: ${_exhaustive}`)
    }
  }
}

export { AgentStrategy, CursorAgent, CopilotAgent, ClaudeAgent }
