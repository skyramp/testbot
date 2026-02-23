#!/usr/bin/env npx tsx
/**
 * Analyze MCP tool calls from Cursor agent NDJSON logs.
 *
 * Usage:
 *   npx tsx tools/analyze-tools.ts <run_id> [--repo owner/repo] [--keep-logs]
 *   npx tsx tools/analyze-tools.ts --file /path/to/agent-log.ndjson
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

// ── Types ──

interface ToolCallRecord {
  index: number;
  callId: string;
  toolName: string;
  toolType: "skyramp" | "mcp" | "builtin";
  provider?: string;
  startedMs: number;
  completedMs?: number;
  durationMs?: number;
  status: "ok" | "error" | "incomplete";
}

interface InitInfo {
  sessionId?: string;
  model?: string;
}

interface RunContext {
  commitSha?: string;
  commitUrl?: string;
  prNumber?: number;
  prUrl?: string;
  commentUrl?: string;
}

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

// ── Log acquisition ──

class FatalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FatalError";
  }
}

function downloadLog(runId: string, repo: string): string {
  // Check gh CLI
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    throw new FatalError("gh CLI not found. Install from https://cli.github.com/ or use --file mode.");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-tools-"));
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
    throw new FatalError(
      `Failed to download artifact from run ${runId}:\n${msg}\nThe run may not have debug enabled, or the artifact may have expired.`
    );
  }

  const logFile = path.join(tmpDir, "agent-log.ndjson");
  if (!fs.existsSync(logFile)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new FatalError("agent-log.ndjson not found in downloaded artifact.");
  }

  return logFile;
}

// ── Run context (commit, PR, comment) ──

function fetchRunContext(runId: string, repo: string): RunContext {
  const ctx: RunContext = {};
  try {
    const runJson = execFileSync(
      "gh",
      ["api", `repos/${repo}/actions/runs/${runId}`, "--jq", "{head_sha, run_started_at, updated_at, pull_requests}"],
      { stdio: "pipe" }
    ).toString();
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

    // Find the testbot comment created during this run
    const startedAt = new Date(run.run_started_at).getTime();
    const updatedAt = new Date(run.updated_at).getTime();

    const commentsJson = execFileSync(
      "gh",
      ["api", `repos/${repo}/issues/${pr.number}/comments`, "--jq", '[.[] | select(.user.login == "github-actions[bot]") | {id, created_at, html_url}]'],
      { stdio: "pipe" }
    ).toString();
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

// ── NDJSON parsing ──

function getToolName(toolCall: Record<string, unknown>): {
  name: string;
  type: "skyramp" | "mcp" | "builtin";
  provider?: string;
} {
  if ("mcpToolCall" in toolCall) {
    const mcp = toolCall.mcpToolCall as {
      args?: { toolName?: string; providerIdentifier?: string };
    };
    const toolName = mcp.args?.toolName ?? "unknown_mcp_tool";
    const provider = mcp.args?.providerIdentifier;
    const isSkyramp =
      provider?.includes("skyramp") || toolName.startsWith("skyramp_");
    return {
      name: toolName,
      type: isSkyramp ? "skyramp" : "mcp",
      provider,
    };
  }

  // Built-in tool: key is like "readToolCall", "shellToolCall", etc.
  const key = Object.keys(toolCall)[0];
  return { name: key, type: "builtin" };
}

function getToolStatus(
  toolCall: Record<string, unknown>
): "ok" | "error" {
  // Walk through tool call to find result
  for (const val of Object.values(toolCall)) {
    if (val && typeof val === "object" && "result" in (val as object)) {
      const result = (val as { result: Record<string, unknown> }).result;
      if ("error" in result) return "error";
      if (
        result.success &&
        typeof result.success === "object" &&
        (result.success as { isError?: boolean }).isError
      ) {
        return "error";
      }
    }
  }
  return "ok";
}

async function parseLog(filePath: string): Promise<{
  calls: ToolCallRecord[];
  init: InitInfo;
}> {
  const calls: ToolCallRecord[] = [];
  const pending = new Map<
    string,
    ToolCallRecord
  >();
  const init: InitInfo = {};
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

    // Extract init info
    if (obj.type === "system" && obj.subtype === "init") {
      init.sessionId = obj.session_id as string;
      init.model = obj.model as string;
      continue;
    }

    if (obj.type !== "tool_call") continue;

    const callId = obj.call_id as string;
    const toolCall = obj.tool_call as Record<string, unknown>;

    if (obj.subtype === "started") {
      const { name, type, provider } = getToolName(toolCall);
      const record: ToolCallRecord = {
        index: ++index,
        callId,
        toolName: name,
        toolType: type,
        provider,
        startedMs: obj.timestamp_ms as number,
        status: "incomplete",
      };
      pending.set(callId, record);
      calls.push(record);
    } else if (obj.subtype === "completed") {
      const record = pending.get(callId);
      if (record) {
        const completedMs = obj.timestamp_ms as number;
        record.completedMs = completedMs;
        record.durationMs = completedMs - record.startedMs;
        record.status = getToolStatus(toolCall);
        pending.delete(callId);
      } else {
        console.warn(`Warning: completed event with no matching started (call_id=${callId})`);
      }
    }
  }

  return { calls, init };
}

// ── Report rendering ──

function formatDuration(ms?: number): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

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
    // Sort by count descending
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
    if (!fs.existsSync(file)) {
      throw new FatalError(`File not found: ${file}`);
    }
    logFile = file;
  } else {
    logFile = downloadLog(runId!, repo);
    tmpDir = path.dirname(logFile);
  }

  const { calls, init } = await parseLog(logFile);

  // Fetch commit/PR/comment context when using a run ID
  const ctx = runId ? fetchRunContext(runId, repo) : undefined;

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
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
