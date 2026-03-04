#!/usr/bin/env npx tsx
/**
 * Inspect MCP tool call inputs and outputs from agent NDJSON logs (Cursor + Claude Code).
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

import * as fsp from "fs/promises";
import * as path from "path";

import type { ToolCallRecord } from "./lib/types";
import { FatalError, downloadLog, formatDuration } from "./lib/download";
import { parseLog } from "./lib/parse-log";

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

// ── Rendering ──

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

function renderEntries(entries: ToolCallRecord[], runId?: string, repo?: string, format?: string): void {
  if (entries.length === 0) {
    console.log("No matching MCP tool calls found.");
    return;
  }

  if (runId) console.log(`Run: ${runId}${repo ? ` | Repo: ${repo}` : ""}`);
  if (format) console.log(`Format: ${format}`);
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
        const display = valueStr.length > 200 ? valueStr.slice(0, 200) + "..." : valueStr;
        console.log(`  ${key}: ${display}`);
      }
    } else {
      console.log(`  ${JSON.stringify(entry.input)}`);
    }

    // Output
    console.log("\n── Output ──");
    const formatted = formatContent(entry.output);
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
    logFile = file;
  } else {
    console.error(`Downloading agent logs for run ${runId}...`);
    logFile = await downloadLog(runId!, repo);
    tmpDir = path.dirname(logFile);
  }

  const { calls, format } = await parseLog(logFile);

  // Filter to MCP-only tool calls, optionally by tool name
  const filtered = calls.filter((c) => {
    if (c.toolType === "builtin") return false;
    if (toolFilter && !c.toolName.includes(toolFilter)) return false;
    return true;
  });

  renderEntries(filtered, runId, repo, format);

  // Cleanup
  if (tmpDir) {
    if (keepLogs) {
      console.log(`\nLog file kept at: ${logFile}`);
    } else {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

main().catch((e: unknown) => {
  if (e instanceof FatalError) {
    console.error(e.message);
  } else {
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exitCode = 1;
});
