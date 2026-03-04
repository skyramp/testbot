/**
 * Shared type definitions for debugging tools.
 */

export type LogFormat = "cursor" | "claude-code";

export interface ToolCallRecord {
  index: number;
  callId: string;
  toolName: string;
  toolType: "skyramp" | "mcp" | "builtin";
  provider?: string;
  startedMs: number;
  completedMs?: number;
  durationMs?: number;
  status: "ok" | "error" | "incomplete";
  /** Tool success (for evaluate-runs metrics) */
  success?: boolean;
  errorMsg?: string;
  /** MCP tool args (Cursor: mcpToolCall.args.args, Claude Code: tool_use.input) */
  args?: Record<string, unknown>;
  /** Full tool input (for inspect-prompt) */
  input?: unknown;
  /** Full tool output (for inspect-prompt) */
  output?: unknown;
  /** Extracted text content from MCP result */
  resultContent?: string;
}

export interface InitInfo {
  sessionId?: string;
  model?: string;
  format?: LogFormat;
}

export interface ParsedLog {
  calls: ToolCallRecord[];
  init: InitInfo;
  format: LogFormat;
  assistantMessages: { timestampMs: number; content: string }[];
}
