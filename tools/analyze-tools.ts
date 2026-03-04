#!/usr/bin/env npx tsx
/**
 * Analyze MCP tool calls from agent NDJSON logs (Cursor + Claude Code).
 *
 * Usage:
 *   npx tsx tools/analyze-tools.ts <run_id> [--repo owner/repo] [--keep-logs]
 *   npx tsx tools/analyze-tools.ts --file /path/to/agent-log.ndjson
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fsp from "fs/promises";
import * as path from "path";

const execFileAsync = promisify(execFile);

import type { ToolCallRecord, InitInfo } from "./lib/types";
import { FatalError, downloadLog, formatDuration } from "./lib/download";
import { parseLog } from "./lib/parse-log";

// ── Arg parsing ──

function parseArgs(argv: string[]): {
  runId?: string;
  file?: string;
  repo: string;
  keepLogs: boolean;
} {
  const args = argv.slice(2);
  let runId: string | undefined;
  let file: string | undefined;
  let repo = "letsramp/api-insight";
  let keepLogs = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file" || arg === "-f") {
      file = args[++i];
    } else if (arg === "--repo") {
      repo = args[++i];
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

  return { runId, file, repo, keepLogs };
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx tools/analyze-tools.ts <run_id> [--repo owner/repo] [--keep-logs]
  npx tsx tools/analyze-tools.ts --file /path/to/agent-log.ndjson

Options:
  <run_id>       GitHub Actions run ID (requires gh CLI)
  --file, -f     Path to a local agent-log.ndjson file
  --repo         Repository (default: letsramp/api-insight)
  --keep-logs    Keep downloaded NDJSON file after analysis
  --help, -h     Show this help message`);
}

// ── Run context (commit, PR, comment) ──

interface RunContext {
  commitSha?: string;
  commitUrl?: string;
  prNumber?: number;
  prUrl?: string;
  commentUrl?: string;
}

async function fetchRunContext(runId: string, repo: string): Promise<RunContext> {
  const ctx: RunContext = {};
  try {
    const { stdout: runJson } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/actions/runs/${runId}`, "--jq", "{head_sha, run_started_at, updated_at, pull_requests}"],
    );
    const run = JSON.parse(runJson) as {
      head_sha: string;
      run_started_at: string;
      updated_at: string;
      pull_requests: { number: number }[];
    };

    ctx.commitSha = run.head_sha;
    ctx.commitUrl = `https://github.com/${repo}/commit/${run.head_sha}`;

    const pr = run.pull_requests?.[0];
    if (!pr) return ctx;

    ctx.prNumber = pr.number;
    ctx.prUrl = `https://github.com/${repo}/pull/${pr.number}`;

    const startedAt = new Date(run.run_started_at).getTime();
    const updatedAt = new Date(run.updated_at).getTime();

    const { stdout: commentsJson } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/issues/${pr.number}/comments`, "--jq", '[.[] | select(.user.login == "github-actions[bot]") | {id, created_at, html_url}]'],
    );
    const comments = JSON.parse(commentsJson) as {
      id: number;
      created_at: string;
      html_url: string;
    }[];

    const match = comments.find((c) => {
      const t = new Date(c.created_at).getTime();
      return t >= startedAt && t <= updatedAt;
    });
    if (match) {
      ctx.commentUrl = match.html_url;
    }
  } catch {
    // Non-fatal — we just won't show the links
  }
  return ctx;
}

// ── Report rendering ──

function renderReport(
  calls: ToolCallRecord[],
  init: InitInfo,
  runId?: string,
  repo?: string,
  ctx?: RunContext
): void {
  // Header
  const parts: string[] = [];
  if (runId) parts.push(`Run: ${runId}`);
  if (repo) parts.push(`Repo: ${repo}`);
  if (parts.length) console.log(parts.join(" | "));
  if (init.model) console.log(`Model: ${init.model}`);
  if (init.sessionId) console.log(`Session: ${init.sessionId}`);
  if (init.format) console.log(`Format: ${init.format}`);
  if (ctx?.commitUrl) console.log(`Commit: ${ctx.commitUrl}`);
  if (ctx?.prUrl) console.log(`PR: ${ctx.prUrl}`);
  if (ctx?.commentUrl) console.log(`Report: ${ctx.commentUrl}`);
  console.log();

  // Timeline
  const colIdx = 4;
  const colTool = 34;
  const colType = 10;
  const colDur = 10;

  console.log("═══ Tool Call Timeline ═══");
  console.log(
    "#".padEnd(colIdx) +
      "Tool".padEnd(colTool) +
      "Type".padEnd(colType) +
      "Duration".padEnd(colDur) +
      "Status"
  );

  for (const c of calls) {
    const status =
      c.status === "ok" ? "✓" : c.status === "error" ? "✗" : "…";
    console.log(
      String(c.index).padEnd(colIdx) +
        c.toolName.padEnd(colTool) +
        c.toolType.padEnd(colType) +
        formatDuration(c.durationMs).padEnd(colDur) +
        status
    );
  }

  // Summary
  console.log();
  console.log("═══ Summary ═══");

  const skyramp = calls.filter((c) => c.toolType === "skyramp");
  const otherMcp = calls.filter((c) => c.toolType === "mcp");
  const builtin = calls.filter((c) => c.toolType === "builtin");
  const total = calls.length;
  const pct = (n: number) =>
    total > 0 ? `(${Math.round((n / total) * 100)}%)` : "";

  console.log(`Total tool calls:     ${total}`);
  console.log(
    `  Skyramp MCP tools:  ${String(skyramp.length).padEnd(4)}${pct(skyramp.length)}`
  );
  console.log(
    `  Other MCP tools:    ${String(otherMcp.length).padEnd(4)}${pct(otherMcp.length)}`
  );
  console.log(
    `  Built-in tools:     ${String(builtin.length).padEnd(4)}${pct(builtin.length)}`
  );

  const incomplete = calls.filter((c) => c.status === "incomplete");
  const errors = calls.filter((c) => c.status === "error");
  if (incomplete.length > 0) {
    console.log(`  Incomplete:         ${incomplete.length}`);
  }
  if (errors.length > 0) {
    console.log(`  Errors:             ${errors.length}`);
  }

  // Breakdown
  const breakdown = (
    label: string,
    subset: ToolCallRecord[]
  ): void => {
    if (subset.length === 0) return;
    console.log();
    console.log(`${label} breakdown:`);
    const counts = new Map<string, number>();
    for (const c of subset) {
      counts.set(c.toolName, (counts.get(c.toolName) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`  ${name.padEnd(30)} ${count}`);
    }
  };

  breakdown("Skyramp tools", skyramp);
  breakdown("Other MCP tools", otherMcp);
  breakdown("Built-in tools", builtin);
}

// ── Main ──

async function main(): Promise<void> {
  const { runId, file, repo, keepLogs } = parseArgs(process.argv);

  let logFile: string;
  let tmpDir: string | undefined;

  if (file) {
    logFile = file;
  } else {
    logFile = await downloadLog(runId!, repo);
    tmpDir = path.dirname(logFile);
  }

  const { calls, init } = await parseLog(logFile);

  const ctx = runId ? await fetchRunContext(runId, repo) : undefined;

  if (calls.length === 0) {
    console.log("No tool calls found in log file.");
  } else {
    renderReport(calls, init, runId, runId ? repo : undefined, ctx);
  }

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
    console.error(e);
  }
  process.exitCode = 1;
});
