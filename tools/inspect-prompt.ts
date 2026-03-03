#!/usr/bin/env npx tsx
/**
 * Inspect MCP tool call inputs and outputs from agent NDJSON logs.
 *
 * Extracts the full request/response for specific Skyramp MCP tool calls,
 * making it easy to debug prompt instructions, tool parameters, and tool
 * output that the agent acted on.
 *
 * Usage:
 *   npx tsx tools/inspect-prompt.ts <run_id> [--repo owner/repo] [--tool <name>] [--keep-logs]
 *   npx tsx tools/inspect-prompt.ts --file /path/to/agent-log.ndjson [--tool <name>]
 *
 * Examples:
 *   # Show all Skyramp MCP tool calls (inputs + outputs)
 *   npx tsx tools/inspect-prompt.ts 22515994520 --repo letsramp/demoshop-fullstack
 *
 *   # Show only recommend_tests calls
 *   npx tsx tools/inspect-prompt.ts 22515994520 --repo letsramp/demoshop-fullstack --tool skyramp_recommend_tests
 *
 *   # Show the submit_report call (to see what the agent reported)
 *   npx tsx tools/inspect-prompt.ts --file agent-log.ndjson --tool skyramp_submit_report
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

// ── Types ──

interface ToolCallEntry {
  index: number;
  callId: string;
  toolName: string;
  startedMs: number;
  completedMs?: number;
  durationMs?: number;
  input: unknown;
  output: unknown;
  status: "ok" | "error" | "incomplete";
}

// ── Arg parsing ──

function parseArgs(argv: string[]): {
  runId?: string;
  file?: string;
  repo: string;
  toolFilter?: string;
  keepLogs: boolean;
} {
  const args = argv.slice(2);
  let runId: string | undefined;
  let file: string | undefined;
  let repo = "letsramp/api-insight";
  let toolFilter: string | undefined;
  let keepLogs = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file" || arg === "-f") {
      file = args[++i];
    } else if (arg === "--repo") {
      repo = args[++i];
    } else if (arg === "--tool" || arg === "-t") {
      toolFilter = args[++i];
    } else if (arg === "--keep-logs") {
      keepLogs = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      runId = arg;
    } else {
      console.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!runId && !file) {
    console.error("Error: provide either a <run_id> or --file <path>\n");
    printUsage();
    process.exit(1);
  }

  if (runId && file) {
    console.error("Error: provide either a <run_id> or --file, not both\n");
    printUsage();
    process.exit(1);
  }

  return { runId, file, repo, toolFilter, keepLogs };
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx tools/inspect-prompt.ts <run_id> [--repo owner/repo] [--tool <name>] [--keep-logs]
  npx tsx tools/inspect-prompt.ts --file /path/to/agent-log.ndjson [--tool <name>]

Options:
  <run_id>       GitHub Actions run ID (requires gh CLI)
  --file, -f     Path to a local agent-log.ndjson file
  --repo         Repository (default: letsramp/api-insight)
  --tool, -t     Filter to a specific tool name (e.g., skyramp_recommend_tests)
  --keep-logs    Keep downloaded NDJSON file after analysis
  --help, -h     Show this help message

Common tool names:
  skyramp_recommend_tests       — test recommendations and trace file instructions
  skyramp_submit_report         — final report submitted by agent (issuesFound, testResults, etc.)
  skyramp_analyze_repository    — repository analysis output
  skyramp_execute_test          — individual test execution results
  skyramp_execute_tests_batch   — batch test execution results
  skyramp_*_test_generation     — test generation output (smoke, fuzz, contract, etc.)`);
}

// ── Log acquisition ──

function downloadLog(runId: string, repo: string): string {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("Error: gh CLI not found. Install from https://cli.github.com/ or use --file mode.");
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-prompt-"));
  try {
    execFileSync(
      "gh",
      ["run", "download", runId, "--repo", repo, "--name", "skyramp-agent-logs", "--dir", tmpDir],
      { stdio: "pipe" }
    );
  } catch (e: unknown) {
    const msg =
      e instanceof Error && "stderr" in e
        ? (e as { stderr: Buffer }).stderr?.toString()
        : String(e);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.error(
      `Failed to download artifact from run ${runId}:\n${msg}\nThe run may not have debug enabled, or the artifact may have expired.`
    );
    process.exit(1);
  }

  const logFile = path.join(tmpDir, "agent-log.ndjson");
  if (!fs.existsSync(logFile)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.error("agent-log.ndjson not found in downloaded artifact.");
    process.exit(1);
  }

  return logFile;
}

// ── NDJSON parsing ──

function extractMcpToolName(toolCall: Record<string, unknown>): string | null {
  if ("mcpToolCall" in toolCall) {
    const mcp = toolCall.mcpToolCall as {
      args?: { toolName?: string };
    };
    return mcp.args?.toolName ?? null;
  }
  return null;
}

function extractMcpInput(toolCall: Record<string, unknown>): unknown {
  if ("mcpToolCall" in toolCall) {
    const mcp = toolCall.mcpToolCall as {
      args?: { args?: unknown };
    };
    return mcp.args?.args ?? null;
  }
  return null;
}

function extractMcpOutput(toolCall: Record<string, unknown>): { output: unknown; status: "ok" | "error" } {
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

async function parseLog(filePath: string, toolFilter?: string): Promise<ToolCallEntry[]> {
  const entries: ToolCallEntry[] = [];
  const pending = new Map<string, ToolCallEntry>();
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

    if (obj.type !== "tool_call") continue;

    const callId = obj.call_id as string;
    const toolCall = obj.tool_call as Record<string, unknown>;
    const toolName = extractMcpToolName(toolCall);

    // Only process MCP tool calls (skip builtins)
    if (!toolName) continue;

    // Apply filter if specified
    if (toolFilter && !toolName.includes(toolFilter)) continue;

    if (obj.subtype === "started") {
      const entry: ToolCallEntry = {
        index: ++index,
        callId,
        toolName,
        startedMs: obj.timestamp_ms as number,
        input: extractMcpInput(toolCall),
        output: null,
        status: "incomplete",
      };
      pending.set(callId, entry);
      entries.push(entry);
    } else if (obj.subtype === "completed") {
      const entry = pending.get(callId);
      if (entry) {
        const completedMs = obj.timestamp_ms as number;
        entry.completedMs = completedMs;
        entry.durationMs = completedMs - entry.startedMs;
        const { output, status } = extractMcpOutput(toolCall);
        entry.output = output;
        entry.status = status;
        pending.delete(callId);
      } else {
        console.error(`Warning: completed event for unknown call_id ${callId} (tool: ${toolName}) — missing started event`);
      }
    }
  }

  return entries;
}

// ── Rendering ──

function formatDuration(ms?: number): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatContent(content: unknown): string {
  if (content === null || content === undefined) return "(empty)";

  // MCP tool results are often [{text: {text: "..."}}] or [{type: "text", text: "..."}]
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "object" && item !== null) {
        // {text: {text: "..."}}
        if ("text" in item && typeof (item as { text: unknown }).text === "object") {
          const inner = (item as { text: { text?: string } | null }).text;
          if (inner?.text) parts.push(inner.text);
        }
        // {type: "text", text: "..."}
        else if ("text" in item && typeof (item as { text: unknown }).text === "string") {
          parts.push((item as { text: string }).text);
        }
        // fallback
        else {
          parts.push(JSON.stringify(item, null, 2));
        }
      } else if (typeof item === "string") {
        parts.push(item);
      }
    }
    return parts.join("\n");
  }

  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

function renderEntries(entries: ToolCallEntry[], runId?: string, repo?: string): void {
  if (entries.length === 0) {
    console.log("No matching MCP tool calls found.");
    return;
  }

  if (runId) console.log(`Run: ${runId}${repo ? ` | Repo: ${repo}` : ""}`);
  console.log(`Found ${entries.length} MCP tool call(s)\n`);

  for (const entry of entries) {
    const statusIcon = entry.status === "ok" ? "✓" : entry.status === "error" ? "✗" : "…";

    console.log("═".repeat(80));
    console.log(`${statusIcon}  #${entry.index}  ${entry.toolName}  (${formatDuration(entry.durationMs)})`);
    console.log("═".repeat(80));

    // Input
    console.log("\n── Input ──");
    if (entry.input && typeof entry.input === "object") {
      const input = entry.input as Record<string, unknown>;
      for (const [key, value] of Object.entries(input)) {
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        // Truncate long values
        const display = valueStr.length > 200 ? valueStr.slice(0, 200) + "..." : valueStr;
        console.log(`  ${key}: ${display}`);
      }
    } else {
      console.log(`  ${JSON.stringify(entry.input)}`);
    }

    // Output
    console.log("\n── Output ──");
    const formatted = formatContent(entry.output);
    // For very long outputs, show first and last portions
    const lines = formatted.split("\n");
    if (lines.length > 80) {
      console.log(lines.slice(0, 40).join("\n"));
      console.log(`\n  ... (${lines.length - 80} lines omitted) ...\n`);
      console.log(lines.slice(-40).join("\n"));
    } else {
      console.log(formatted);
    }
    console.log();
  }

  // Summary table
  console.log("═".repeat(80));
  console.log("Summary");
  console.log("═".repeat(80));
  console.log(
    "#".padEnd(4) +
    "Tool".padEnd(38) +
    "Duration".padEnd(12) +
    "Status"
  );
  for (const entry of entries) {
    const statusIcon = entry.status === "ok" ? "✓" : entry.status === "error" ? "✗" : "…";
    console.log(
      String(entry.index).padEnd(4) +
      entry.toolName.padEnd(38) +
      formatDuration(entry.durationMs).padEnd(12) +
      statusIcon
    );
  }
}

// ── Main ──

async function main(): Promise<void> {
  const { runId, file, repo, toolFilter, keepLogs } = parseArgs(process.argv);

  let logFile: string;
  let tmpDir: string | undefined;

  if (file) {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }
    logFile = file;
  } else {
    console.error(`Downloading agent logs for run ${runId}...`);
    logFile = downloadLog(runId!, repo);
    tmpDir = path.dirname(logFile);
  }

  const entries = await parseLog(logFile, toolFilter);
  renderEntries(entries, runId, repo);

  // Cleanup
  if (tmpDir) {
    if (keepLogs) {
      console.log(`\nLog file kept at: ${logFile}`);
    } else {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
