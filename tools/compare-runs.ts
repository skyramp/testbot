#!/usr/bin/env npx tsx
/**
 * Compare two testbot NDJSON agent logs side-by-side.
 *
 * Surfaces behavioral differences between runs: tool call sequences,
 * test generation/execution, report sections, and timing.
 *
 * Usage:
 *   npx tsx tools/compare-runs.ts <run_id_1> <run_id_2> [--repo owner/repo] [--keep-logs]
 *   npx tsx tools/compare-runs.ts --file /path/to/log1.ndjson --file /path/to/log2.ndjson
 */

import * as fsp from "fs/promises";
import * as path from "path";

import * as fs from "fs";
import * as readline from "readline";

import type { ToolCallRecord, ParsedLog } from "./lib/types";
import { FatalError, downloadLog, formatDuration } from "./lib/download";
import { parseLog } from "./lib/parse-log";

// ── Result event extraction (not in ParsedLog) ──

interface ResultEvent {
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  costUsd: number;
}

async function extractResultEvent(filePath: string): Promise<ResultEvent | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "result") {
        return {
          durationMs: obj.duration_ms ?? 0,
          durationApiMs: obj.duration_api_ms ?? 0,
          numTurns: obj.num_turns ?? 0,
          costUsd: obj.total_cost_usd ?? 0,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ── Types ──

interface RunSummary {
  label: string;
  format: string;
  model?: string;
  totalCalls: number;
  skyrampCalls: number;
  builtinCalls: number;
  turns: number;
  durationMs: number;
  durationApiMs: number;
  costUsd: number;
  skyrampTools: string[];
  testGenTools: string[];
  testExecCalls: TestExecResult[];
  reportSections: string[];
  summaryLine?: string;
  fileChanges: boolean;
  endpointsFound: string[];
}

interface TestExecResult {
  testType: string;
  endpoint: string;
  status: "pass" | "fail" | "skipped" | "unknown";
  detail?: string;
}

// ── Arg parsing ──

function parseArgs(argv: string[]): {
  runIds: string[];
  files: string[];
  repo: string;
  keepLogs: boolean;
} {
  const args = argv.slice(2);
  const runIds: string[] = [];
  const files: string[] = [];
  let repo = "letsramp/api-insight";
  let keepLogs = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file" || arg === "-f") {
      files.push(args[++i]);
    } else if (arg === "--repo") {
      repo = args[++i];
    } else if (arg === "--keep-logs") {
      keepLogs = true;
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

  const totalInputs = runIds.length + files.length;
  if (totalInputs !== 2) {
    console.error(`Error: exactly 2 inputs required (got ${totalInputs})\n`);
    printUsage();
    process.exit(1);
  }

  return { runIds, files, repo, keepLogs };
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx tools/compare-runs.ts <run_id_1> <run_id_2> [--repo owner/repo] [--keep-logs]
  npx tsx tools/compare-runs.ts --file /path/to/log1.ndjson --file /path/to/log2.ndjson
  npx tsx tools/compare-runs.ts <run_id> --file /path/to/log.ndjson [--repo owner/repo]

Options:
  <run_id>       GitHub Actions run ID (requires gh CLI)
  --file, -f     Path to a local agent-log.ndjson file (use twice for two files)
  --repo         Repository (default: letsramp/api-insight)
  --keep-logs    Keep downloaded NDJSON files after analysis
  --help, -h     Show this help message

Examples:
  # Compare two CI runs
  npx tsx tools/compare-runs.ts 23170418388 23178141505 --repo archit/appsmith

  # Compare two local log files
  npx tsx tools/compare-runs.ts -f run1.ndjson -f run2.ndjson`);
}

// ── Analysis ──

const TEST_GEN_TOOLS = new Set([
  "skyramp_smoke_test_generation",
  "skyramp_contract_test_generation",
  "skyramp_load_test_generation",
  "skyramp_fuzz_test_generation",
  "skyramp_integration_test_generation",
  "skyramp_e2e_test_generation",
  "skyramp_ui_test_generation",
  "skyramp_scenario_test_generation",
]);

const ANALYSIS_TOOLS = new Set([
  "skyramp_analyze_repository",
  "skyramp_analyze_changes",
  "skyramp_recommend_tests",
  "skyramp_map_tests",
  "skyramp_discover_tests",
  "skyramp_analyze_test_drift",
  "skyramp_calculate_health_scores",
]);

function extractTestType(toolName: string): string {
  const match = toolName.match(/skyramp_(\w+)_test_generation/);
  return match ? match[1] : toolName;
}

function extractTestExecResults(calls: ToolCallRecord[]): TestExecResult[] {
  const results: TestExecResult[] = [];
  for (const call of calls) {
    if (call.toolName !== "skyramp_execute_test" && call.toolName !== "skyramp_execute_tests_batch") continue;

    const testFile = (call.args?.testFile ?? call.args?.fileName ?? "") as string;
    const content = call.resultContent ?? "";

    // Infer test type from filename
    let testType = "unknown";
    for (const t of ["smoke", "contract", "load", "fuzz", "integration", "e2e", "ui", "scenario"]) {
      if (testFile.toLowerCase().includes(t)) {
        testType = t;
        break;
      }
    }

    // Extract endpoint from filename or args
    const endpoint = (call.args?.endpointURL as string) ?? testFile;

    // Determine pass/fail from result content
    let status: TestExecResult["status"] = "unknown";
    if (call.status === "error") {
      status = "fail";
    } else if (/pass|success/i.test(content)) {
      status = "pass";
    } else if (/fail|error|401|403|404|500/i.test(content)) {
      status = "fail";
    }

    // Extract a short detail
    let detail: string | undefined;
    const httpMatch = content.match(/HTTP\s+(\d{3})/i);
    if (httpMatch) detail = `HTTP ${httpMatch[1]}`;
    const durationMatch = content.match(/(\d+\.?\d*)\s*s/);
    if (durationMatch) detail = (detail ? detail + ", " : "") + `${durationMatch[1]}s`;

    results.push({ testType, endpoint, status, detail });
  }
  return results;
}

function extractReportSections(calls: ToolCallRecord[]): {
  sections: string[];
  summaryLine?: string;
} {
  const submitCall = calls.find(c => c.toolName === "skyramp_submit_report");
  if (!submitCall) return { sections: [] };

  // The report fields are at the top level of input (not nested under .report)
  const report = (submitCall.args ?? submitCall.input) as Record<string, unknown> | undefined;
  if (!report) return { sections: [] };

  const sections: string[] = [];
  const arrayLen = (key: string): number => {
    const val = report[key];
    return Array.isArray(val) ? val.length : 0;
  };

  if (report.commitMessage) {
    sections.push("Summary");
  }
  if (report.businessCaseAnalysis) {
    sections.push("Business Case Analysis");
  }
  if (arrayLen("newTestsCreated") > 0) {
    sections.push(`New Tests (${arrayLen("newTestsCreated")})`);
  }
  if (arrayLen("testResults") > 0) {
    sections.push(`Test Results (${arrayLen("testResults")})`);
  }
  if (arrayLen("testMaintenance") > 0) {
    sections.push(`Test Maintenance (${arrayLen("testMaintenance")})`);
  }
  if (arrayLen("issuesFound") > 0) {
    sections.push(`Issues Found (${arrayLen("issuesFound")})`);
  }
  if (arrayLen("additionalRecommendations") > 0) {
    sections.push(`Recommendations (${arrayLen("additionalRecommendations")})`);
  }

  return { sections, summaryLine: report.commitMessage as string | undefined };
}

function extractEndpoints(calls: ToolCallRecord[]): string[] {
  const endpoints = new Set<string>();

  for (const call of calls) {
    if (!ANALYSIS_TOOLS.has(call.toolName)) continue;
    const content = call.resultContent ?? "";

    // Look for endpoint paths in the analysis output
    const pathMatches = content.matchAll(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/gi);
    for (const match of pathMatches) {
      endpoints.add(`${match[0]}`);
    }
  }

  return [...endpoints];
}

function detectFileChanges(calls: ToolCallRecord[]): boolean {
  // Check if any Write/Edit calls were made to test files
  for (const call of calls) {
    if (call.toolName === "Write" || call.toolName === "Edit") {
      const filePath = (call.args?.file_path ?? call.input) as string | undefined;
      if (filePath && /test|spec/i.test(String(filePath))) return true;
    }
  }
  // Check if any test generation tools were called (they write files)
  return calls.some(c => TEST_GEN_TOOLS.has(c.toolName));
}

function buildSummary(label: string, parsed: ParsedLog, result: ResultEvent | null): RunSummary {
  const { calls, init } = parsed;

  const skyrampCalls = calls.filter(c => c.toolType === "skyramp");
  const builtinCalls = calls.filter(c => c.toolType === "builtin");

  // Use result event for accurate timing, fall back to tool call timestamps
  const turns = result?.numTurns ?? parsed.assistantMessages.length;
  const durationMs = result?.durationMs ?? (() => {
    const timestamps = calls.flatMap(c => [c.startedMs, c.completedMs].filter(Boolean) as number[]);
    return timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  })();
  const durationApiMs = result?.durationApiMs ?? 0;
  const costUsd = result?.costUsd ?? 0;

  const skyrampTools = skyrampCalls.map(c => c.toolName);
  const testGenTools = calls.filter(c => TEST_GEN_TOOLS.has(c.toolName)).map(c => extractTestType(c.toolName));
  const testExecCalls = extractTestExecResults(calls);
  const { sections, summaryLine } = extractReportSections(calls);
  const endpointsFound = extractEndpoints(calls);
  const fileChanges = detectFileChanges(calls);

  return {
    label,
    format: init.format ?? "unknown",
    model: init.model,
    totalCalls: calls.length,
    skyrampCalls: skyrampCalls.length,
    builtinCalls: builtinCalls.length,
    turns,
    durationMs,
    skyrampTools,
    testGenTools,
    testExecCalls,
    reportSections: sections,
    summaryLine,
    durationApiMs,
    costUsd,
    fileChanges,
    endpointsFound,
  };
}

// ── Rendering ──

function renderComparison(a: RunSummary, b: RunSummary): void {
  const colW = 35;
  const labelW = 25;

  const header = (title: string) => {
    console.log();
    console.log(`═══ ${title} ═══`);
  };

  const row = (label: string, valA: string, valB: string) => {
    const marker = valA !== valB ? " ◀" : "";
    console.log(
      label.padEnd(labelW) +
      valA.padEnd(colW) +
      valB + marker
    );
  };

  // Title
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  Compare Runs");
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log(
    "".padEnd(labelW) +
    a.label.padEnd(colW) +
    b.label
  );
  console.log("─".repeat(labelW + colW + colW));

  // Overview
  header("Overview");
  row("Format", a.format, b.format);
  row("Model", a.model ?? "?", b.model ?? "?");
  row("Duration", formatDuration(a.durationMs), formatDuration(b.durationMs));
  row("API time", formatDuration(a.durationApiMs), formatDuration(b.durationApiMs));
  row("Cost", a.costUsd > 0 ? `$${a.costUsd.toFixed(2)}` : "?", b.costUsd > 0 ? `$${b.costUsd.toFixed(2)}` : "?");
  row("Agent turns", String(a.turns), String(b.turns));
  row("Total tool calls", String(a.totalCalls), String(b.totalCalls));
  row("Skyramp MCP calls", String(a.skyrampCalls), String(b.skyrampCalls));
  row("Built-in calls", String(a.builtinCalls), String(b.builtinCalls));

  // Skyramp tool sequence
  header("Skyramp Tool Sequence");
  const maxLen = Math.max(a.skyrampTools.length, b.skyrampTools.length);
  if (maxLen === 0) {
    console.log("  (no Skyramp tools called in either run)");
  } else {
    console.log(
      "#".padEnd(4) +
      "Run A".padEnd(colW) +
      "Run B"
    );
    for (let i = 0; i < maxLen; i++) {
      const toolA = a.skyrampTools[i] ?? "";
      const toolB = b.skyrampTools[i] ?? "";
      const marker = toolA !== toolB ? " ◀" : "";
      console.log(
        String(i + 1).padEnd(4) +
        toolA.padEnd(colW) +
        toolB + marker
      );
    }
  }

  // Endpoints found
  header("Endpoints Discovered");
  const allEndpoints = new Set([...a.endpointsFound, ...b.endpointsFound]);
  if (allEndpoints.size === 0) {
    console.log("  (no endpoints found in either run)");
  } else {
    console.log(
      "Endpoint".padEnd(labelW + 15) +
      "Run A".padEnd(10) +
      "Run B"
    );
    for (const ep of allEndpoints) {
      const inA = a.endpointsFound.includes(ep) ? "✓" : "—";
      const inB = b.endpointsFound.includes(ep) ? "✓" : "—";
      const marker = inA !== inB ? " ◀" : "";
      console.log(
        ep.padEnd(labelW + 15) +
        inA.padEnd(10) +
        inB + marker
      );
    }
  }

  // Test generation
  header("Test Generation");
  const allTestTypes = new Set([...a.testGenTools, ...b.testGenTools]);
  if (allTestTypes.size === 0) {
    console.log("  (no tests generated in either run)");
  } else {
    console.log(
      "Test Type".padEnd(labelW) +
      "Run A".padEnd(colW) +
      "Run B"
    );
    for (const tt of allTestTypes) {
      const countA = a.testGenTools.filter(t => t === tt).length;
      const countB = b.testGenTools.filter(t => t === tt).length;
      const valA = countA > 0 ? `generated (${countA})` : "—";
      const valB = countB > 0 ? `generated (${countB})` : "—";
      const marker = valA !== valB ? " ◀" : "";
      console.log(
        tt.padEnd(labelW) +
        valA.padEnd(colW) +
        valB + marker
      );
    }
  }

  // Test execution
  header("Test Execution");
  const allExecs = [...a.testExecCalls, ...b.testExecCalls];
  if (allExecs.length === 0) {
    console.log("  (no tests executed in either run)");
  } else {
    const statusIcon = (s: string) =>
      s === "pass" ? "✓ pass" : s === "fail" ? "✗ fail" : s === "skipped" ? "○ skip" : "? " + s;

    if (a.testExecCalls.length > 0) {
      console.log(`  Run A (${a.testExecCalls.length} executions):`);
      for (const t of a.testExecCalls) {
        console.log(`    ${statusIcon(t.status).padEnd(12)} ${t.testType.padEnd(15)} ${t.detail ?? ""}`);
      }
    } else {
      console.log("  Run A: (none)");
    }

    if (b.testExecCalls.length > 0) {
      console.log(`  Run B (${b.testExecCalls.length} executions):`);
      for (const t of b.testExecCalls) {
        console.log(`    ${statusIcon(t.status).padEnd(12)} ${t.testType.padEnd(15)} ${t.detail ?? ""}`);
      }
    } else {
      console.log("  Run B: (none)");
    }
  }

  // Report
  header("Report");
  const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + "…" : s;
  row("Summary", truncate(a.summaryLine ?? "(none)", colW - 2), truncate(b.summaryLine ?? "(none)", colW - 2));
  row("File changes", a.fileChanges ? "yes" : "no", b.fileChanges ? "yes" : "no");

  const allSections = new Set([...a.reportSections, ...b.reportSections]);
  if (allSections.size > 0) {
    console.log();
    console.log(
      "Section".padEnd(labelW + 10) +
      "Run A".padEnd(10) +
      "Run B"
    );
    for (const section of allSections) {
      const inA = a.reportSections.includes(section) ? "✓" : "—";
      const inB = b.reportSections.includes(section) ? "✓" : "—";
      const marker = inA !== inB ? " ◀" : "";
      console.log(
        section.padEnd(labelW + 10) +
        inA.padEnd(10) +
        inB + marker
      );
    }
  }

  // Key differences
  header("Key Differences");
  const diffs: string[] = [];

  if (a.skyrampCalls !== b.skyrampCalls) {
    diffs.push(`Skyramp tool call count: ${a.skyrampCalls} vs ${b.skyrampCalls}`);
  }

  // Check if different analysis tools were used
  const analysisA = a.skyrampTools.filter(t => ANALYSIS_TOOLS.has(t));
  const analysisB = b.skyrampTools.filter(t => ANALYSIS_TOOLS.has(t));
  if (JSON.stringify(analysisA) !== JSON.stringify(analysisB)) {
    diffs.push(`Analysis tools differ: [${analysisA.join(", ")}] vs [${analysisB.join(", ")}]`);
  }

  if (a.testGenTools.length !== b.testGenTools.length) {
    diffs.push(`Tests generated: ${a.testGenTools.length} vs ${b.testGenTools.length}`);
  }

  if (a.testExecCalls.length !== b.testExecCalls.length) {
    diffs.push(`Tests executed: ${a.testExecCalls.length} vs ${b.testExecCalls.length}`);
  }

  if (a.fileChanges !== b.fileChanges) {
    diffs.push(`File changes: ${a.fileChanges ? "yes" : "no"} vs ${b.fileChanges ? "yes" : "no"}`);
  }

  const missingSections = [...allSections].filter(
    s => !a.reportSections.includes(s) || !b.reportSections.includes(s)
  );
  if (missingSections.length > 0) {
    diffs.push(`Report sections differ: ${missingSections.join(", ")}`);
  }

  if (a.durationMs > 0 && b.durationMs > 0) {
    const ratio = a.durationMs / b.durationMs;
    if (ratio > 2 || ratio < 0.5) {
      diffs.push(`Duration: ${formatDuration(a.durationMs)} vs ${formatDuration(b.durationMs)} (${ratio > 1 ? `A is ${ratio.toFixed(1)}x slower` : `B is ${(1/ratio).toFixed(1)}x slower`})`);
    }
  }

  if (diffs.length === 0) {
    console.log("  No significant differences detected");
  } else {
    for (const d of diffs) {
      console.log(`  ⚠  ${d}`);
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  const { runIds, files, repo, keepLogs } = parseArgs(process.argv);

  // Resolve two log files
  const logSources: { label: string; file: string; tmpDir?: string }[] = [];

  // Process run IDs first, then files
  for (const runId of runIds) {
    const logFile = await downloadLog(runId, repo);
    logSources.push({
      label: `Run ${runId}`,
      file: logFile,
      tmpDir: path.dirname(logFile),
    });
  }
  for (const f of files) {
    logSources.push({
      label: path.basename(f),
      file: f,
    });
  }

  // Parse both logs and extract result events
  const [parsedA, parsedB, resultA, resultB] = await Promise.all([
    parseLog(logSources[0].file),
    parseLog(logSources[1].file),
    extractResultEvent(logSources[0].file),
    extractResultEvent(logSources[1].file),
  ]);

  const summaryA = buildSummary(logSources[0].label, parsedA, resultA);
  const summaryB = buildSummary(logSources[1].label, parsedB, resultB);

  renderComparison(summaryA, summaryB);

  // Cleanup
  for (const src of logSources) {
    if (src.tmpDir) {
      if (keepLogs) {
        console.log(`\nLog kept: ${src.file}`);
      } else {
        await fsp.rm(src.tmpDir, { recursive: true, force: true });
      }
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
