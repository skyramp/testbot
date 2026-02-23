#!/usr/bin/env npx tsx
/**
 * Evaluate Skyramp MCP tool call efficacy across multiple testbot runs.
 *
 * Usage:
 *   npx tsx tools/evaluate-runs.ts <run_id1> <run_id2> ... [--repo owner/repo]
 *   npx tsx tools/evaluate-runs.ts --pr 104 [--repo owner/repo]
 *   npx tsx tools/evaluate-runs.ts --files log1.ndjson log2.ndjson ...
 */

import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const execFileAsync = promisify(execFile);
import * as readline from "readline";

// ── Types ──

interface ToolCallRecord {
  callId: string;
  toolName: string;
  toolType: "skyramp" | "mcp" | "builtin";
  startedMs: number;
  completedMs?: number;
  durationMs?: number;
  success?: boolean;
  errorMsg?: string;
  args?: Record<string, unknown>;
  resultContent?: string;
}

interface InitInfo {
  sessionId?: string;
  model?: string;
}

interface SubmitReportData {
  testResults?: {
    testType: string;
    endpoint: string;
    status: string;
    details: string;
  }[];
  newTestsCreated?: { testType: string; endpoint: string; fileName: string }[];
  testMaintenance?: { description: string }[];
  issuesFound?: { description: string }[];
  businessCaseAnalysis?: string;
  commitMessage?: string;
}

interface RunMetrics {
  runId: string;
  init: InitInfo;
  totalCalls: number;
  skyrampCalls: number;
  builtinCalls: number;
  otherMcpCalls: number;
  skyrampRatio: number;
  // Success/failure
  successCount: number;
  failureCount: number;
  incompleteCount: number;
  successRate: number;
  // Test execution
  executeTestCalls: number;
  executeTestPasses: number;
  executeTestFailures: number;
  executeTestSuccessRate: number;
  // Self-correction
  correctionCycles: number;
  editsInCycles: number;
  // Timing
  sessionDurationMs: number;
  skyrampTimeMs: number;
  thinkingTimeMs: number;
  avgTestExecMs: number;
  // Report
  report: SubmitReportData | null;
  testsCreated: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  endpointsCovered: number;
  testTypes: string[];
  // Derived
  executeToPassRatio: number;
  reportPresent: boolean;
  commitMsgPresent: boolean;
}

// ── Arg parsing ──

function parseArgs(argv: string[]): {
  runIds: string[];
  files: string[];
  pr?: string;
  repo: string;
} {
  const args = argv.slice(2);
  const runIds: string[] = [];
  const files: string[] = [];
  let pr: string | undefined;
  let repo = "letsramp/api-insight";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--files") {
      i++;
      while (i < args.length && !args[i].startsWith("-")) {
        files.push(args[i]);
        i++;
      }
      i--; // back up for the outer loop
    } else if (arg === "--pr") {
      pr = args[++i];
    } else if (arg === "--repo") {
      repo = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      runIds.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (runIds.length === 0 && files.length === 0 && !pr) {
    console.error(
      "Error: provide run IDs, --pr <number>, or --files <paths>\n"
    );
    printUsage();
    process.exit(1);
  }

  return { runIds, files, pr, repo };
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx tools/evaluate-runs.ts <run_id1> <run_id2> ... [--repo owner/repo]
  npx tsx tools/evaluate-runs.ts --pr 104 [--repo owner/repo]
  npx tsx tools/evaluate-runs.ts --files log1.ndjson log2.ndjson ...

Options:
  <run_ids>      GitHub Actions run IDs (requires gh CLI)
  --pr           PR number — fetches all testbot runs for that PR
  --files        Paths to local agent-log.ndjson files
  --repo         Repository (default: letsramp/api-insight)
  --help, -h     Show this help message`);
}

// ── Log acquisition ──

class FatalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FatalError";
  }
}

function requireGh(): void {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    throw new FatalError(
      "gh CLI not found. Install from https://cli.github.com/ or use --files mode."
    );
  }
}

function getRunIdsForPr(pr: string, repo: string): string[] {
  requireGh();
  try {
    const output = execFileSync(
      "gh",
      ["run", "list", "--repo", repo, "--branch", "", "--json", "databaseId,headBranch,name,event", "--limit", "50"],
      { stdio: "pipe" }
    ).toString();
    const runs = JSON.parse(output) as {
      databaseId: number;
      headBranch: string;
      name: string;
      event: string;
    }[];

    // Get PR branch name
    const prInfo = execFileSync(
      "gh",
      ["pr", "view", pr, "--repo", repo, "--json", "headRefName"],
      { stdio: "pipe" }
    ).toString();
    const { headRefName } = JSON.parse(prInfo);

    // Filter runs for this PR's branch
    const prRuns = runs
      .filter((r) => r.headBranch === headRefName)
      .map((r) => String(r.databaseId));

    if (prRuns.length === 0) {
      throw new FatalError(
        `No workflow runs found for PR #${pr} (branch: ${headRefName})`
      );
    }
    return prRuns;
  } catch (e) {
    if (e instanceof FatalError) throw e;
    throw new FatalError(`Failed to list runs for PR #${pr}: ${e}`);
  }
}

async function downloadLog(runId: string, repo: string): Promise<string | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-"));
  try {
    await execFileAsync(
      "gh",
      ["run", "download", runId, "--repo", repo, "--name", "skyramp-agent-logs", "--dir", tmpDir],
    );
  } catch {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return null; // No artifact for this run
  }

  const logFile = path.join(tmpDir, "agent-log.ndjson");
  if (!fs.existsSync(logFile)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
  return logFile;
}

// ── NDJSON parsing ──

function getToolName(toolCall: Record<string, unknown>): {
  name: string;
  type: "skyramp" | "mcp" | "builtin";
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
      args: mcp.args?.args,
    };
  }
  const key = Object.keys(toolCall)[0];
  return { name: key, type: "builtin" };
}

function getToolResult(toolCall: Record<string, unknown>): {
  success: boolean;
  content?: string;
} {
  for (const val of Object.values(toolCall)) {
    if (val && typeof val === "object" && "result" in (val as object)) {
      const result = (val as { result: Record<string, unknown> }).result;
      if ("error" in result) {
        return { success: false, content: JSON.stringify(result.error) };
      }
      if (result.success && typeof result.success === "object") {
        const s = result.success as { isError?: boolean; content?: unknown };
        if (s.isError) {
          return { success: false, content: JSON.stringify(s.content) };
        }
        // Extract text content from MCP responses
        if (Array.isArray(s.content)) {
          const texts = s.content
            .filter(
              (c: { type?: string }) =>
                c && typeof c === "object" && c.type === "text"
            )
            .map(
              (c: { text?: string | { text?: string } }) =>
                typeof c.text === "string"
                  ? c.text
                  : typeof c.text === "object"
                    ? c.text?.text ?? ""
                    : ""
            );
          return { success: true, content: texts.join("\n") };
        }
        return { success: true };
      }
      return { success: true };
    }
  }
  return { success: true };
}

interface ParsedLog {
  calls: ToolCallRecord[];
  init: InitInfo;
  assistantMessages: { timestampMs: number; content: string }[];
}

async function parseLog(filePath: string): Promise<ParsedLog> {
  const calls: ToolCallRecord[] = [];
  const pending = new Map<string, ToolCallRecord>();
  const init: InitInfo = {};
  const assistantMessages: { timestampMs: number; content: string }[] = [];

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

    if (obj.type === "system" && obj.subtype === "init") {
      init.sessionId = obj.session_id as string;
      init.model = obj.model as string;
      continue;
    }

    if (obj.type === "assistant" && obj.timestamp_ms) {
      const msg = obj.message as { content?: { type: string; text: string }[] };
      const text =
        msg?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? "";
      assistantMessages.push({
        timestampMs: obj.timestamp_ms as number,
        content: text,
      });
      continue;
    }

    if (obj.type !== "tool_call") continue;

    const callId = obj.call_id as string;
    const toolCall = obj.tool_call as Record<string, unknown>;

    if (obj.subtype === "started") {
      const { name, type, args } = getToolName(toolCall);
      const record: ToolCallRecord = {
        callId,
        toolName: name,
        toolType: type,
        startedMs: obj.timestamp_ms as number,
        args,
      };
      pending.set(callId, record);
      calls.push(record);
    } else if (obj.subtype === "completed") {
      const record = pending.get(callId);
      if (record) {
        const completedMs = obj.timestamp_ms as number;
        record.completedMs = completedMs;
        record.durationMs = completedMs - record.startedMs;
        const { success, content } = getToolResult(toolCall);
        record.success = success;
        record.resultContent = content;
        if (!success) {
          record.errorMsg = content;
        }
        pending.delete(callId);
      } else {
        console.warn(`Warning: completed event with no matching started (call_id=${callId})`);
      }
    }
  }

  return { calls, init, assistantMessages };
}

// ── Metrics computation ──

function extractReportData(calls: ToolCallRecord[]): SubmitReportData | null {
  // Find submit_report call and extract its args (the structured report data)
  const reportCall = calls.find(
    (c) => c.toolName === "skyramp_submit_report" && c.args
  );
  if (!reportCall?.args) return null;

  return {
    testResults: reportCall.args.testResults as SubmitReportData["testResults"],
    newTestsCreated: reportCall.args
      .newTestsCreated as SubmitReportData["newTestsCreated"],
    testMaintenance: reportCall.args
      .testMaintenance as SubmitReportData["testMaintenance"],
    issuesFound: reportCall.args
      .issuesFound as SubmitReportData["issuesFound"],
    businessCaseAnalysis: reportCall.args.businessCaseAnalysis as string,
    commitMessage: reportCall.args.commitMessage as string,
  };
}

function detectCorrectionCycles(calls: ToolCallRecord[]): {
  cycles: number;
  edits: number;
} {
  // A correction cycle: execute_test fails → edit(s) → execute_test again
  let cycles = 0;
  let totalEdits = 0;
  let lastExecFailed = false;
  let editsInCurrentCycle = 0;

  for (const c of calls) {
    if (c.toolName === "skyramp_execute_test") {
      if (
        lastExecFailed &&
        editsInCurrentCycle > 0
      ) {
        cycles++;
        totalEdits += editsInCurrentCycle;
      }
      // Check if this execution's result indicates failure
      lastExecFailed =
        c.success === false ||
        (c.resultContent?.includes("Test execution failed") ?? false);
      editsInCurrentCycle = 0;
    } else if (c.toolName === "editToolCall" && lastExecFailed) {
      editsInCurrentCycle++;
    }
  }

  return { cycles, edits: totalEdits };
}

function computeMetrics(
  runId: string,
  parsed: ParsedLog
): RunMetrics {
  const { calls, init } = parsed;

  const skyrampCalls = calls.filter((c) => c.toolType === "skyramp");
  const builtinCalls = calls.filter((c) => c.toolType === "builtin");
  const otherMcpCalls = calls.filter((c) => c.toolType === "mcp");

  const completed = calls.filter((c) => c.success !== undefined);
  const successes = completed.filter((c) => c.success === true);
  const failures = completed.filter((c) => c.success === false);
  const incomplete = calls.filter((c) => c.success === undefined);

  // Test execution metrics
  const execCalls = calls.filter(
    (c) => c.toolName === "skyramp_execute_test"
  );
  const execPasses = execCalls.filter(
    (c) =>
      c.success === true &&
      !c.resultContent?.includes("Test execution failed")
  );
  const execFailures = execCalls.filter(
    (c) =>
      c.success === false ||
      (c.resultContent?.includes("Test execution failed") ?? false)
  );

  // Timing
  const timestamps = calls
    .flatMap((c) => [c.startedMs, c.completedMs].filter(Boolean) as number[]);
  const sessionDurationMs =
    timestamps.length >= 2
      ? Math.max(...timestamps) - Math.min(...timestamps)
      : 0;

  const skyrampTimeMs = skyrampCalls.reduce(
    (sum, c) => sum + (c.durationMs ?? 0),
    0
  );

  // Thinking time = session duration - all tool durations
  const totalToolTime = calls.reduce(
    (sum, c) => sum + (c.durationMs ?? 0),
    0
  );
  const thinkingTimeMs = Math.max(0, sessionDurationMs - totalToolTime);

  const execDurations = execCalls
    .map((c) => c.durationMs)
    .filter((d): d is number => d !== undefined);
  const avgTestExecMs =
    execDurations.length > 0
      ? execDurations.reduce((a, b) => a + b, 0) / execDurations.length
      : 0;

  // Report data
  const report = extractReportData(calls);
  const testResults = report?.testResults ?? [];
  const passed = testResults.filter(
    (t) => t.status.toLowerCase() === "pass"
  ).length;
  const failed = testResults.filter(
    (t) => t.status.toLowerCase() === "fail"
  ).length;
  const skipped = testResults.filter(
    (t) => t.status.toLowerCase() === "skipped"
  ).length;
  const endpoints = new Set(testResults.map((t) => t.endpoint));
  const testTypes = [
    ...new Set(testResults.map((t) => t.testType.toLowerCase())),
  ];

  // Self-correction
  const { cycles, edits } = detectCorrectionCycles(calls);

  return {
    runId,
    init,
    totalCalls: calls.length,
    skyrampCalls: skyrampCalls.length,
    builtinCalls: builtinCalls.length,
    otherMcpCalls: otherMcpCalls.length,
    skyrampRatio:
      calls.length > 0 ? skyrampCalls.length / calls.length : 0,
    successCount: successes.length,
    failureCount: failures.length,
    incompleteCount: incomplete.length,
    successRate: completed.length > 0 ? successes.length / completed.length : 0,
    executeTestCalls: execCalls.length,
    executeTestPasses: execPasses.length,
    executeTestFailures: execFailures.length,
    executeTestSuccessRate:
      execCalls.length > 0 ? execPasses.length / execCalls.length : 0,
    correctionCycles: cycles,
    editsInCycles: edits,
    sessionDurationMs,
    skyrampTimeMs,
    thinkingTimeMs,
    avgTestExecMs,
    report,
    testsCreated: report?.newTestsCreated?.length ?? 0,
    testsPassed: passed,
    testsFailed: failed,
    testsSkipped: skipped,
    endpointsCovered: endpoints.size,
    testTypes,
    executeToPassRatio:
      passed > 0 ? execCalls.length / passed : execCalls.length,
    reportPresent: report !== null,
    commitMsgPresent: !!report?.commitMessage,
  };
}

// ── Report rendering ──

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function renderReport(allMetrics: RunMetrics[]): void {
  const n = allMetrics.length;

  console.log("═══ Testbot Evaluation Report ═══");
  console.log(`Runs analyzed: ${n}\n`);

  // Dynamic column width: at least 14, wide enough for full run IDs + 2 padding
  const colLabel = 28;
  const maxIdLen = Math.max(...allMetrics.map((m) => m.runId.length), 3);
  const colWidth = Math.max(14, maxIdLen + 2);
  const header =
    "".padEnd(colLabel) +
    allMetrics.map((m) => m.runId.padEnd(colWidth)).join("") +
    (n > 1 ? "Avg".padEnd(colWidth) : "");
  const separator = "─".repeat(header.length);

  // Helper to render a row
  const row = (
    label: string,
    values: string[],
    avg?: string
  ): void => {
    let line = label.padEnd(colLabel);
    for (const v of values) {
      line += v.padEnd(colWidth);
    }
    if (n > 1 && avg !== undefined) {
      line += avg;
    }
    console.log(line);
  };

  const avgNum = (vals: number[]): number =>
    vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

  // ── Test Effectiveness ──
  console.log("═══ Test Effectiveness ═══");
  console.log(header);
  console.log(separator);

  row(
    "Exec test pass rate",
    allMetrics.map((m) => fmtPct(m.executeTestSuccessRate)),
    fmtPct(avgNum(allMetrics.map((m) => m.executeTestSuccessRate)))
  );
  row(
    "Tests created (report)",
    allMetrics.map((m) => String(m.testsCreated)),
    avgNum(allMetrics.map((m) => m.testsCreated)).toFixed(1)
  );
  row(
    "Tests passed (report)",
    allMetrics.map((m) => String(m.testsPassed)),
    avgNum(allMetrics.map((m) => m.testsPassed)).toFixed(1)
  );
  row(
    "Tests failed (report)",
    allMetrics.map((m) => String(m.testsFailed)),
    avgNum(allMetrics.map((m) => m.testsFailed)).toFixed(1)
  );
  row(
    "Tests skipped (report)",
    allMetrics.map((m) => String(m.testsSkipped)),
    avgNum(allMetrics.map((m) => m.testsSkipped)).toFixed(1)
  );
  row(
    "Endpoints covered",
    allMetrics.map((m) => String(m.endpointsCovered)),
    avgNum(allMetrics.map((m) => m.endpointsCovered)).toFixed(1)
  );
  // Test types: render as a sub-list below the table row
  if (allMetrics.some((m) => m.testTypes.length > 0)) {
    const maxTypes = Math.max(...allMetrics.map((m) => m.testTypes.length));
    for (let t = 0; t < maxTypes; t++) {
      row(
        t === 0 ? "Test types" : "",
        allMetrics.map((m) => m.testTypes[t] ?? "")
      );
    }
  } else {
    row("Test types", allMetrics.map(() => "-"));
  }

  // ── Tool Efficiency ──
  console.log();
  console.log("═══ Tool Efficiency ═══");
  console.log(header);
  console.log(separator);

  row(
    "Total tool calls",
    allMetrics.map((m) => String(m.totalCalls)),
    avgNum(allMetrics.map((m) => m.totalCalls)).toFixed(1)
  );
  row(
    "Skyramp ratio",
    allMetrics.map((m) => fmtPct(m.skyrampRatio)),
    fmtPct(avgNum(allMetrics.map((m) => m.skyrampRatio)))
  );
  row(
    "Tool success rate",
    allMetrics.map((m) => fmtPct(m.successRate)),
    fmtPct(avgNum(allMetrics.map((m) => m.successRate)))
  );
  row(
    "Execute-to-pass ratio",
    allMetrics.map((m) => m.executeToPassRatio.toFixed(1)),
    avgNum(allMetrics.map((m) => m.executeToPassRatio)).toFixed(1)
  );
  row(
    "Failed tool calls",
    allMetrics.map((m) => String(m.failureCount)),
    avgNum(allMetrics.map((m) => m.failureCount)).toFixed(1)
  );
  row(
    "Incomplete calls",
    allMetrics.map((m) => String(m.incompleteCount)),
    avgNum(allMetrics.map((m) => m.incompleteCount)).toFixed(1)
  );

  // ── Timing ──
  console.log();
  console.log("═══ Timing ═══");
  console.log(header);
  console.log(separator);

  row(
    "Session duration",
    allMetrics.map((m) => fmtDuration(m.sessionDurationMs)),
    fmtDuration(avgNum(allMetrics.map((m) => m.sessionDurationMs)))
  );
  row(
    "Skyramp tool time",
    allMetrics.map((m) => fmtDuration(m.skyrampTimeMs)),
    fmtDuration(avgNum(allMetrics.map((m) => m.skyrampTimeMs)))
  );
  row(
    "Agent thinking time",
    allMetrics.map((m) => fmtDuration(m.thinkingTimeMs)),
    fmtDuration(avgNum(allMetrics.map((m) => m.thinkingTimeMs)))
  );
  row(
    "Avg test exec time",
    allMetrics.map((m) =>
      m.executeTestCalls > 0 ? fmtDuration(m.avgTestExecMs) : "-"
    ),
    fmtDuration(avgNum(allMetrics.map((m) => m.avgTestExecMs)))
  );

  // ── Self-Correction ──
  console.log();
  console.log("═══ Self-Correction ═══");
  console.log(header);
  console.log(separator);

  row(
    "Correction cycles",
    allMetrics.map((m) => String(m.correctionCycles)),
    avgNum(allMetrics.map((m) => m.correctionCycles)).toFixed(1)
  );
  row(
    "Edits in cycles",
    allMetrics.map((m) => String(m.editsInCycles)),
    avgNum(allMetrics.map((m) => m.editsInCycles)).toFixed(1)
  );

  // ── Report Quality ──
  console.log();
  console.log("═══ Report Quality ═══");
  console.log(header);
  console.log(separator);

  row(
    "Report submitted",
    allMetrics.map((m) => (m.reportPresent ? "✓" : "✗")),
    `${allMetrics.filter((m) => m.reportPresent).length}/${n}`
  );
  row(
    "Commit msg present",
    allMetrics.map((m) => (m.commitMsgPresent ? "✓" : "✗")),
    `${allMetrics.filter((m) => m.commitMsgPresent).length}/${n}`
  );
  row(
    "Issues found",
    allMetrics.map((m) => String(m.report?.issuesFound?.length ?? 0)),
    avgNum(
      allMetrics.map((m) => m.report?.issuesFound?.length ?? 0)
    ).toFixed(1)
  );
  row(
    "Skipped ratio",
    allMetrics.map((m) => {
      const total =
        m.testsPassed + m.testsFailed + m.testsSkipped;
      return total > 0 ? fmtPct(m.testsSkipped / total) : "-";
    })
  );

  // ── Common Errors ──
  const allErrors = allMetrics.flatMap((m) =>
    m.report === null
      ? []
      : [] // We'd need to track errors from calls
  );

  // Collect tool-level errors
  console.log();
  const errorCounts = new Map<string, number>();
  for (const m of allMetrics) {
    // We don't have direct access to calls here, but we tracked failureCount
    // For error details, we'd need to pass them through
  }

  // If there are errors worth showing, let's collect from a second pass
  // For now, just show the summary
  if (allMetrics.some((m) => m.failureCount > 0)) {
    console.log(
      `Note: ${allMetrics.reduce((s, m) => s + m.failureCount, 0)} total tool call failures across ${n} runs. Use analyze-tools.ts for per-run error details.`
    );
  }
}

// ── Main ──

async function main(): Promise<void> {
  const { runIds, files, pr, repo } = parseArgs(process.argv);

  // Resolve run IDs
  let resolvedRunIds = [...runIds];
  if (pr) {
    requireGh();
    console.log(`Fetching runs for PR #${pr} on ${repo}...`);
    resolvedRunIds = getRunIdsForPr(pr, repo);
    console.log(`Found ${resolvedRunIds.length} runs\n`);
  }

  // Collect log files
  interface LogSource {
    runId: string;
    filePath: string;
    tmpDir?: string;
  }
  const sources: LogSource[] = [];

  // Download from GitHub (parallel)
  if (resolvedRunIds.length > 0) {
    requireGh();
    const results = await Promise.allSettled(
      resolvedRunIds.map(async (runId) => {
        const logFile = await downloadLog(runId, repo);
        return { runId, logFile };
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.logFile) {
        sources.push({
          runId: result.value.runId,
          filePath: result.value.logFile,
          tmpDir: path.dirname(result.value.logFile),
        });
      } else {
        const runId =
          result.status === "fulfilled"
            ? result.value.runId
            : "unknown";
        console.error(
          `  Skipping run ${runId}: no agent logs artifact found`
        );
      }
    }
  }

  // Local files
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`  Skipping ${f}: file not found`);
      continue;
    }
    sources.push({
      runId: path.basename(f, ".ndjson"),
      filePath: f,
    });
  }

  if (sources.length === 0) {
    throw new FatalError("No valid log files found.");
  }

  // Parse and compute metrics (parallel)
  const parseResults = await Promise.allSettled(
    sources.map(async (src) => {
      const parsed = await parseLog(src.filePath);
      if (parsed.calls.length === 0) return null;
      return computeMetrics(src.runId, parsed);
    })
  );
  const allMetrics: RunMetrics[] = [];
  for (let i = 0; i < parseResults.length; i++) {
    const result = parseResults[i];
    if (result.status === "fulfilled" && result.value) {
      allMetrics.push(result.value);
    } else if (result.status === "fulfilled") {
      console.error(`  Skipping ${sources[i].runId}: no tool calls in log`);
    }
  }

  if (allMetrics.length === 0) {
    throw new FatalError("No runs with tool calls found.");
  }

  renderReport(allMetrics);

  // Cleanup temp dirs
  for (const src of sources) {
    if (src.tmpDir) {
      fs.rmSync(src.tmpDir, { recursive: true, force: true });
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
