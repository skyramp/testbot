/**
 * Dual-format NDJSON parser — supports both Cursor and Claude Code agent logs.
 *
 * Format auto-detection scans the first ~50 lines:
 * - Claude Code: init event contains "claude_code_version", or assistant events have tool_use blocks
 * - Cursor: has "type":"tool_call" events (Claude Code never emits these)
 */

import * as fs from "fs";
import * as readline from "readline";
import type { LogFormat, ToolCallRecord, InitInfo, ParsedLog } from "./types";
import { FatalError } from "./download";

// ── Format auto-detection ──

export function detectFormat(lines: string[]): LogFormat {
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Claude Code init event has claude_code_version — most reliable marker
    if (obj.type === "system" && obj.subtype === "init" && "claude_code_version" in obj) {
      return "claude-code";
    }

    // Cursor-only event type (Claude Code never emits "type":"tool_call")
    if (obj.type === "tool_call") return "cursor";

    // Fallback: Claude Code embeds tool calls in assistant message content
    if (obj.type === "assistant") {
      const msg = obj.message as { content?: { type: string }[] } | undefined;
      if (msg?.content?.some((c) => c.type === "tool_use")) return "claude-code";
    }
  }

  return "cursor"; // default for backward compat
}

// ── Tool name/type classification ──

const CLAUDE_BUILTINS = new Set([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebFetch", "WebSearch", "TodoWrite", "TodoRead",
  "Agent", "AskFollowup",
]);

/** Classify a tool name into skyramp/mcp/builtin. */
export function classifyTool(rawName: string): {
  name: string;
  type: "skyramp" | "mcp" | "builtin";
  provider?: string;
} {
  // Claude Code MCP tools: mcp__<server>__<toolName>
  if (rawName.startsWith("mcp__")) {
    const parts = rawName.split("__");
    const server = parts[1] ?? "";
    const toolName = parts.slice(2).join("__");
    const isSkyramp = server === "skyramp" || toolName.startsWith("skyramp_");
    return {
      name: toolName || rawName,
      type: isSkyramp ? "skyramp" : "mcp",
      provider: server,
    };
  }

  // Claude Code builtins
  if (CLAUDE_BUILTINS.has(rawName)) {
    return { name: rawName, type: "builtin" };
  }

  return { name: rawName, type: "builtin" };
}

// ── Cursor format ──

function classifyCursorTool(toolCall: Record<string, unknown>): {
  name: string;
  type: "skyramp" | "mcp" | "builtin";
  provider?: string;
  args?: Record<string, unknown>;
} {
  if ("mcpToolCall" in toolCall) {
    const mcp = toolCall.mcpToolCall as {
      args?: {
        toolName?: string;
        providerIdentifier?: string;
        args?: Record<string, unknown>;
      };
    };
    const toolName = mcp.args?.toolName ?? "unknown_mcp_tool";
    const provider = mcp.args?.providerIdentifier;
    const isSkyramp =
      provider?.includes("skyramp") || toolName.startsWith("skyramp_");
    return {
      name: toolName,
      type: isSkyramp ? "skyramp" : "mcp",
      provider,
      args: mcp.args?.args,
    };
  }
  const key = Object.keys(toolCall)[0];
  return { name: key, type: "builtin" };
}

function getCursorToolStatus(
  toolCall: Record<string, unknown>
): { status: "ok" | "error"; success: boolean; content?: string } {
  for (const val of Object.values(toolCall)) {
    if (val && typeof val === "object" && "result" in (val as object)) {
      const result = (val as { result: Record<string, unknown> }).result;
      if ("error" in result) {
        return { status: "error", success: false, content: JSON.stringify(result.error) };
      }
      if (result.success && typeof result.success === "object") {
        const s = result.success as { isError?: boolean; content?: unknown };
        if (s.isError) {
          return { status: "error", success: false, content: JSON.stringify(s.content) };
        }
        // Extract text content
        if (Array.isArray(s.content)) {
          const texts = (s.content as { type?: string; text?: string | { text?: string } }[])
            .filter((c) => c && typeof c === "object" && c.type === "text")
            .map((c) =>
              typeof c.text === "string"
                ? c.text
                : typeof c.text === "object"
                  ? c.text?.text ?? ""
                  : ""
            );
          return { status: "ok", success: true, content: texts.join("\n") };
        }
        return { status: "ok", success: true };
      }
      return { status: "ok", success: true };
    }
  }
  return { status: "ok", success: true };
}

function extractCursorMcpInput(toolCall: Record<string, unknown>): unknown {
  if ("mcpToolCall" in toolCall) {
    const mcp = toolCall.mcpToolCall as { args?: { args?: unknown } };
    return mcp.args?.args ?? null;
  }
  return null;
}

function extractCursorMcpOutput(toolCall: Record<string, unknown>): { output: unknown; status: "ok" | "error" } {
  if ("mcpToolCall" in toolCall) {
    const mcp = toolCall.mcpToolCall as {
      result?: {
        success?: { content?: unknown; isError?: boolean };
        error?: unknown;
      };
    };
    const result = mcp.result;
    if (!result) return { output: null, status: "ok" };
    if (result.error) return { output: result.error, status: "error" };
    if (result.success?.isError) return { output: result.success.content, status: "error" };
    return { output: result.success?.content ?? null, status: "ok" };
  }
  return { output: null, status: "ok" };
}

async function parseCursorLog(filePath: string): Promise<ParsedLog> {
  const calls: ToolCallRecord[] = [];
  const pending = new Map<string, ToolCallRecord>();
  const init: InitInfo = { format: "cursor" };
  const assistantMessages: ParsedLog["assistantMessages"] = [];
  let index = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Init info
    if (obj.type === "system" && obj.subtype === "init") {
      init.sessionId = obj.session_id as string;
      init.model = obj.model as string;
      continue;
    }

    // Assistant messages (for evaluate-runs)
    if (obj.type === "assistant" && obj.timestamp_ms) {
      const msg = obj.message as { content?: { type: string; text: string }[] };
      const text =
        msg?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? "";
      assistantMessages.push({ timestampMs: obj.timestamp_ms as number, content: text });
      continue;
    }

    if (obj.type !== "tool_call") continue;

    const callId = obj.call_id as string;
    const toolCall = obj.tool_call as Record<string, unknown>;

    if (obj.subtype === "started") {
      const { name, type, provider, args } = classifyCursorTool(toolCall);
      const record: ToolCallRecord = {
        index: ++index,
        callId,
        toolName: name,
        toolType: type,
        provider,
        startedMs: obj.timestamp_ms as number,
        status: "incomplete",
        args,
        input: extractCursorMcpInput(toolCall),
      };
      pending.set(callId, record);
      calls.push(record);
    } else if (obj.subtype === "completed") {
      const record = pending.get(callId);
      if (record) {
        const completedMs = obj.timestamp_ms as number;
        record.completedMs = completedMs;
        record.durationMs = completedMs - record.startedMs;
        const { status, success, content } = getCursorToolStatus(toolCall);
        record.status = status;
        record.success = success;
        record.resultContent = content;
        if (!success) record.errorMsg = content;
        const { output } = extractCursorMcpOutput(toolCall);
        record.output = output;
        pending.delete(callId);
      }
    }
  }

  return { calls, init, format: "cursor", assistantMessages };
}

// ── Claude Code format ──

interface ClaudeToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResult {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

async function parseClaudeCodeLog(filePath: string): Promise<ParsedLog> {
  const calls: ToolCallRecord[] = [];
  const pendingById = new Map<string, ToolCallRecord>();
  const init: InitInfo = { format: "claude-code" };
  const assistantMessages: ParsedLog["assistantMessages"] = [];
  let index = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const eventType = obj.type as string;

    // Init info from system event
    if (eventType === "system") {
      const msg = obj.message as string | undefined;
      if (msg && typeof msg === "string") {
        // Claude Code system events may contain model info
        const modelMatch = msg.match(/model[:\s]+(\S+)/i);
        if (modelMatch) init.model = modelMatch[1];
      }
      // Some Claude Code logs have subtype init with session info
      if (obj.subtype === "init") {
        init.sessionId = (obj.session_id as string) ?? undefined;
        init.model = (obj.model as string) ?? init.model;
      }
      continue;
    }

    // Assistant events contain tool_use blocks
    if (eventType === "assistant") {
      const timestampMs = obj.timestamp_ms as number | undefined;
      const msg = obj.message as { content?: unknown[] } | undefined;
      const content = msg?.content;
      if (!Array.isArray(content)) continue;

      // Extract text content for assistant messages
      const textParts = content
        .filter((c): c is { type: "text"; text: string } =>
          typeof c === "object" && c !== null && (c as { type: string }).type === "text"
        )
        .map((c) => c.text);
      if (textParts.length > 0 && timestampMs) {
        assistantMessages.push({ timestampMs, content: textParts.join("\n") });
      }

      // Extract model from assistant message
      const model = (obj.message as { model?: string })?.model;
      if (model && !init.model) init.model = model;

      // Process tool_use blocks
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;

        const tu = b as unknown as ClaudeToolUse;
        const { name, type, provider } = classifyTool(tu.name);

        // For MCP tools, extract the inner args
        const args = type === "builtin" ? undefined : tu.input;

        const record: ToolCallRecord = {
          index: ++index,
          callId: tu.id,
          toolName: name,
          toolType: type,
          provider,
          startedMs: timestampMs ?? 0,
          status: "incomplete",
          args: args as Record<string, unknown> | undefined,
          input: tu.input,
        };
        pendingById.set(tu.id, record);
        calls.push(record);
      }
      continue;
    }

    // User events contain tool_result blocks
    if (eventType === "user") {
      const timestampMs = obj.timestamp_ms as number | undefined;
      const msg = obj.message as { content?: unknown[] } | undefined;
      const content = msg?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;

        const tr = b as unknown as ClaudeToolResult;
        const record = pendingById.get(tr.tool_use_id);
        if (!record) continue;

        const completedMs = timestampMs ?? 0;
        record.completedMs = completedMs;
        record.durationMs = record.startedMs > 0 && completedMs > 0
          ? completedMs - record.startedMs
          : undefined;

        record.output = tr.content;

        if (tr.is_error) {
          record.status = "error";
          record.success = false;
          record.errorMsg = extractClaudeTextContent(tr.content);
        } else {
          record.status = "ok";
          record.success = true;
        }
        record.resultContent = extractClaudeTextContent(tr.content);
        pendingById.delete(tr.tool_use_id);
      }
    }
  }

  return { calls, init, format: "claude-code", assistantMessages };
}

function extractClaudeTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type: string }).type === "text"
      )
      .map((c) => c.text);
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  if (content && typeof content === "object" && "text" in (content as object)) {
    return String((content as { text: unknown }).text);
  }
  return undefined;
}

// ── Unified entry point ──

async function readSampleLines(filePath: string, maxLines: number): Promise<string[]> {
  const lines: string[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length >= maxLines) {
      rl.close();
      break;
    }
  }
  return lines;
}

export async function parseLog(filePath: string): Promise<ParsedLog> {
  let sampleLines: string[];
  try {
    sampleLines = await readSampleLines(filePath, 50);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "ENOENT") {
      throw new FatalError(`File not found: ${filePath}`);
    }
    throw e;
  }
  const format = detectFormat(sampleLines);

  if (format === "claude-code") {
    return parseClaudeCodeLog(filePath);
  }
  return parseCursorLog(filePath);
}
