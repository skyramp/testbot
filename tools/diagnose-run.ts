#!/usr/bin/env npx tsx
/**
 * Diagnose a testbot workflow run by inspecting CI logs and agent artifacts.
 *
 * Useful for debugging MCP server connection failures, agent crashes,
 * package version mismatches, and other CI-level issues.
 *
 * Usage:
 *   npx tsx tools/diagnose-run.ts <run_id> [--repo owner/repo]
 *   npx tsx tools/diagnose-run.ts <run_id1> <run_id2> --compare [--repo owner/repo]
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

// ── Types ──

interface RunInfo {
  runId: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  headSha: string;
  headBranch: string;
  event: string;
  prNumber?: number;
}

interface StepInfo {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

interface McpDiagnostics {
  serverName: string | null;
  connectionStatus: string | null;
  mcpSource: string | null;
  mcpVersion: string | null;
  skyrampPackageVersion: string | null;
  executorImageVersion: string | null;
  errors: string[];
}

interface AgentDiagnostics {
  agentType: string | null;
  exitCode: number | null;
  retryCount: number;
  timedOut: boolean;
  reportSubmitted: boolean;
  errors: string[];
}

interface Diagnosis {
  run: RunInfo;
  steps: StepInfo[];
  mcp: McpDiagnostics;
  agent: AgentDiagnostics;
  agentLogAvailable: boolean;
}

// ── Arg parsing ──

function parseArgs(argv: string[]): {
  runIds: string[];
  repo: string;
  compare: boolean;
} {
  const args = argv.slice(2);
  const runIds: string[] = [];
  let repo = "letsramp/api-insight";
  let compare = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") {
      repo = args[++i];
    } else if (arg === "--compare") {
      compare = true;
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

  if (runIds.length === 0) {
    console.error("Error: provide at least one <run_id>\n");
    printUsage();
    process.exit(1);
  }

  if (compare && runIds.length < 2) {
    console.error("Error: --compare requires at least two run IDs\n");
    printUsage();
    process.exit(1);
  }

  return { runIds, repo, compare };
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx tools/diagnose-run.ts <run_id> [--repo owner/repo]
  npx tsx tools/diagnose-run.ts <run_id1> <run_id2> --compare [--repo owner/repo]

Options:
  <run_id>     GitHub Actions run ID(s)
  --repo       Repository (default: letsramp/api-insight)
  --compare    Compare two or more runs side-by-side
  --help, -h   Show this help message

Examples:
  # Diagnose a single failed run
  npx tsx tools/diagnose-run.ts 22515385508 --repo letsramp/demoshop-fullstack

  # Compare a passing run with a failing run
  npx tsx tools/diagnose-run.ts 22490000000 22515385508 --compare --repo letsramp/demoshop-fullstack`);
}

// ── GitHub API helpers ──

function gh(args: string[]): string {
  try {
    return execFileSync("gh", args, { stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e: unknown) {
    const stderr =
      e instanceof Error && "stderr" in e
        ? (e as { stderr: Buffer }).stderr?.toString()
        : String(e);
    throw new Error(`gh ${args.join(" ")} failed: ${stderr}`);
  }
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

// ── CI log download and parsing ──

function downloadCILogs(runId: string, repo: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `diagnose-${runId}-`));
  const logPath = path.join(tmpDir, "ci-log.txt");
  let fd: number | undefined;
  try {
    fd = fs.openSync(logPath, "w");
    try {
      execFileSync("gh", ["run", "view", runId, "--repo", repo, "--log"], {
        stdio: ["pipe", fd, "pipe"],
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch {
      // gh run view --log may fail but still produce partial output
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return logPath;
}

async function searchLogs(logFile: string, patterns: RegExp[]): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  for (const p of patterns) {
    results.set(p.source, []);
  }

  if (!fs.existsSync(logFile) || fs.statSync(logFile).size === 0) {
    return results;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(logFile),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        results.get(pattern.source)!.push(line.trim());
      }
    }
  }

  return results;
}

// ── Diagnosis builder ──

function fetchRunInfo(runId: string, repo: string): RunInfo {
  const run = ghJson<{
    databaseId: number;
    status: string;
    conclusion: string | null;
    createdAt: string;
    updatedAt: string;
    headSha: string;
    headBranch: string;
    event: string;
    number: number;
  }>(["run", "view", runId, "--repo", repo, "--json", "databaseId,status,conclusion,createdAt,updatedAt,headSha,headBranch,event,number"]);

  // Try to get PR number
  let prNumber: number | undefined;
  try {
    const prs = ghJson<number[]>([
      "api", `repos/${repo}/commits/${run.headSha}/pulls`,
      "--jq", "[.[].number]",
    ]);
    prNumber = prs[0];
  } catch {
    // ignore
  }

  return {
    runId,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    headSha: run.headSha,
    headBranch: run.headBranch,
    event: run.event,
    prNumber,
  };
}

function fetchSteps(runId: string, repo: string): StepInfo[] {
  const jobs = ghJson<{
    jobs: {
      name: string;
      steps: {
        name: string;
        status: string;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
      }[];
    }[];
  }>(["api", `repos/${repo}/actions/runs/${runId}/jobs`]);

  const steps: StepInfo[] = [];
  for (const job of jobs.jobs) {
    for (const step of job.steps) {
      const started = step.started_at ? new Date(step.started_at).getTime() : null;
      const completed = step.completed_at ? new Date(step.completed_at).getTime() : null;
      steps.push({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        durationMs: started && completed ? completed - started : null,
      });
    }
  }
  return steps;
}

async function diagnoseMcp(logFile: string): Promise<McpDiagnostics> {
  const diag: McpDiagnostics = {
    serverName: null,
    connectionStatus: null,
    mcpSource: null,
    mcpVersion: null,
    skyrampPackageVersion: null,
    executorImageVersion: null,
    errors: [],
  };

  const patterns = [
    /MCP server.*verified|MCP server.*connected|does not appear connected|not found in MCP/i,
    /Connection (failed|closed|stalled|timed out)/i,
    /@skyramp\/skyramp@[\d.]+/,
    /@skyramp\/mcp@[\d.]+/,
    /skyramp\/executor[:@][\w.]+/,
    /npm install.*@skyramp/,
    /mcp (add|enable)\b/,
    /Error|FATAL|crash|uncaught/i,
  ];

  const results = await searchLogs(logFile, patterns);

  // Extract MCP connection status
  const connLines = results.get(patterns[0].source) ?? [];
  if (connLines.length > 0) {
    const last = connLines[connLines.length - 1];
    if (/verified|connected/i.test(last)) {
      diag.connectionStatus = "connected";
    } else {
      diag.connectionStatus = "not connected";
    }
    // Extract server name if present
    const nameMatch = last.match(/(?:server|MCP).*?[:\s]+(\S+)\s+(?:is|does)/);
    if (nameMatch) diag.serverName = nameMatch[1];
  }

  // Connection errors
  const connErrors = results.get(patterns[1].source) ?? [];
  diag.errors.push(...connErrors.map(l => l.replace(/^.*?\t/, "")));

  // Package versions
  const skyrampPkg = results.get(patterns[2].source) ?? [];
  if (skyrampPkg.length > 0) {
    const match = skyrampPkg[0].match(/@skyramp\/skyramp@([\d.]+)/);
    if (match) diag.skyrampPackageVersion = match[1];
  }

  const mcpPkg = results.get(patterns[3].source) ?? [];
  if (mcpPkg.length > 0) {
    const match = mcpPkg[0].match(/@skyramp\/mcp@([\d.]+)/);
    if (match) diag.mcpVersion = match[1];
  }

  const executor = results.get(patterns[4].source) ?? [];
  if (executor.length > 0) {
    const match = executor[0].match(/skyramp\/executor[:@]([\w.]+)/);
    if (match) diag.executorImageVersion = match[1];
  }

  // MCP source (npm vs github)
  const npmLines = results.get(patterns[5].source) ?? [];
  const mcpCmdLines = results.get(patterns[6].source) ?? [];
  if (npmLines.length > 0) diag.mcpSource = "npm";
  else if (mcpCmdLines.some(l => /github|clone/i.test(l))) diag.mcpSource = "github";

  // General errors
  const errorLines = results.get(patterns[7].source) ?? [];
  const significantErrors = errorLines.filter(
    l => /fatal|crash|uncaught/i.test(l) && !diag.errors.includes(l.replace(/^.*?\t/, ""))
  );
  diag.errors.push(...significantErrors.map(l => l.replace(/^.*?\t/, "")));

  return diag;
}

async function diagnoseAgent(logFile: string): Promise<AgentDiagnostics> {
  const diag: AgentDiagnostics = {
    agentType: null,
    exitCode: null,
    retryCount: 0,
    timedOut: false,
    reportSubmitted: false,
    errors: [],
  };

  const patterns = [
    /Cursor CLI|Copilot CLI|Claude Code CLI/i,
    /Agent error.*attempt (\d+)/,
    /timed out/i,
    /skyramp_submit_report/,
    /exit code (\d+)/i,
    /agent.*failed|non-zero exit/i,
  ];

  const results = await searchLogs(logFile, patterns);

  // Agent type
  const agentLines = results.get(patterns[0].source) ?? [];
  if (agentLines.length > 0) {
    if (/cursor/i.test(agentLines[0])) diag.agentType = "cursor";
    else if (/copilot/i.test(agentLines[0])) diag.agentType = "copilot";
    else if (/claude/i.test(agentLines[0])) diag.agentType = "claude";
  }

  // Retries
  const retryLines = results.get(patterns[1].source) ?? [];
  diag.retryCount = retryLines.length;

  // Timeout
  const timeoutLines = results.get(patterns[2].source) ?? [];
  diag.timedOut = timeoutLines.length > 0;

  // Report
  const reportLines = results.get(patterns[3].source) ?? [];
  diag.reportSubmitted = reportLines.length > 0;

  // Exit code
  const exitLines = results.get(patterns[4].source) ?? [];
  if (exitLines.length > 0) {
    const match = exitLines[exitLines.length - 1].match(/exit code (\d+)/i);
    if (match) diag.exitCode = parseInt(match[1], 10);
  }

  // Failures
  const failLines = results.get(patterns[5].source) ?? [];
  diag.errors.push(...failLines.map(l => l.replace(/^.*?\t/, "")));

  return diag;
}

function checkAgentLogArtifact(runId: string, repo: string): boolean {
  try {
    const artifacts = ghJson<{ artifacts: { name: string }[] }>([
      "api", `repos/${repo}/actions/runs/${runId}/artifacts`,
    ]);
    return artifacts.artifacts.some(a => a.name === "skyramp-agent-logs");
  } catch {
    return false;
  }
}

async function buildDiagnosis(runId: string, repo: string): Promise<Diagnosis> {
  console.error(`Fetching run info for ${runId}...`);
  const run = fetchRunInfo(runId, repo);

  console.error(`Fetching steps...`);
  const steps = fetchSteps(runId, repo);

  console.error(`Downloading CI logs...`);
  const logFile = downloadCILogs(runId, repo);

  console.error(`Analyzing MCP diagnostics...`);
  const mcp = await diagnoseMcp(logFile);

  console.error(`Analyzing agent diagnostics...`);
  const agent = await diagnoseAgent(logFile);

  console.error(`Checking for agent log artifact...`);
  const agentLogAvailable = checkAgentLogArtifact(runId, repo);

  // Cleanup
  const tmpDir = path.dirname(logFile);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return { run, steps, mcp, agent, agentLogAvailable };
}

// ── Rendering ──

function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function renderDiagnosis(d: Diagnosis): void {
  const { run, steps, mcp, agent, agentLogAvailable } = d;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Run ${run.runId} — ${run.conclusion ?? run.status}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Branch:     ${run.headBranch}`);
  console.log(`  Commit:     ${run.headSha.slice(0, 8)}`);
  console.log(`  Event:      ${run.event}`);
  if (run.prNumber) console.log(`  PR:         #${run.prNumber}`);
  console.log(`  Started:    ${run.createdAt}`);
  console.log(`  Finished:   ${run.updatedAt}`);
  console.log();

  // Steps
  console.log("── Steps ──");
  for (const step of steps) {
    const icon = step.conclusion === "success" ? "✓" : step.conclusion === "failure" ? "✗" : step.conclusion === "skipped" ? "○" : "?";
    const dur = formatMs(step.durationMs);
    console.log(`  ${icon}  ${step.name.padEnd(45)} ${dur}`);
  }
  console.log();

  // MCP
  console.log("── MCP Server ──");
  console.log(`  Connection:        ${mcp.connectionStatus ?? "unknown"}`);
  if (mcp.serverName) console.log(`  Server name:       ${mcp.serverName}`);
  if (mcp.mcpSource) console.log(`  Source:            ${mcp.mcpSource}`);
  if (mcp.mcpVersion) console.log(`  MCP version:       ${mcp.mcpVersion}`);
  if (mcp.skyrampPackageVersion) console.log(`  @skyramp/skyramp:  ${mcp.skyrampPackageVersion}`);
  if (mcp.executorImageVersion) console.log(`  Executor image:    ${mcp.executorImageVersion}`);
  if (mcp.errors.length > 0) {
    console.log(`  Errors:`);
    for (const err of mcp.errors.slice(0, 5)) {
      console.log(`    - ${err.slice(0, 120)}`);
    }
  }
  console.log();

  // Agent
  console.log("── Agent ──");
  console.log(`  Type:              ${agent.agentType ?? "unknown"}`);
  if (agent.exitCode !== null) console.log(`  Exit code:         ${agent.exitCode}`);
  console.log(`  Retries:           ${agent.retryCount}`);
  console.log(`  Timed out:         ${agent.timedOut ? "yes" : "no"}`);
  console.log(`  Report submitted:  ${agent.reportSubmitted ? "yes" : "no"}`);
  console.log(`  Agent logs:        ${agentLogAvailable ? "available (use analyze-tools.ts)" : "not available"}`);
  if (agent.errors.length > 0) {
    console.log(`  Errors:`);
    for (const err of agent.errors.slice(0, 5)) {
      console.log(`    - ${err.slice(0, 120)}`);
    }
  }
  console.log();

  // Verdict
  console.log("── Verdict ──");
  const issues: string[] = [];
  if (mcp.connectionStatus === "not connected") {
    issues.push("MCP server failed to connect — check server name, package versions, and startup logs");
  }
  if (mcp.errors.some(e => /Connection (closed|failed)/i.test(e))) {
    issues.push("MCP connection was lost during the run — possible server crash (check @skyramp/skyramp version)");
  }
  if (agent.timedOut) {
    issues.push("Agent timed out — consider increasing testbotTimeout or checking for blocking FFI calls");
  }
  if (!agent.reportSubmitted && run.conclusion !== "success") {
    issues.push("Report was not submitted via skyramp_submit_report — agent may have crashed or lost MCP connection before completing");
  }
  if (agent.retryCount > 0) {
    issues.push(`Agent retried ${agent.retryCount} time(s) due to transient errors`);
  }
  if (issues.length === 0) {
    issues.push("No obvious issues detected from CI logs");
  }
  for (const issue of issues) {
    console.log(`  ⚠  ${issue}`);
  }

  if (agentLogAvailable) {
    console.log();
    console.log(`  Tip: For detailed tool-call analysis, run:`);
    console.log(`    npx tsx tools/analyze-tools.ts ${run.runId} --repo <repo>`);
  }
}

function renderComparison(diagnoses: Diagnosis[]): void {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Run Comparison");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const cols = diagnoses.map(d => d.run.runId);
  const colW = 20;
  const labelW = 25;

  const header = "".padEnd(labelW) + cols.map(c => c.padEnd(colW)).join("");
  console.log(header);
  console.log("─".repeat(labelW + cols.length * colW));

  const row = (label: string, values: string[]) => {
    console.log(label.padEnd(labelW) + values.map(v => v.padEnd(colW)).join(""));
  };

  row("Conclusion", diagnoses.map(d => d.run.conclusion ?? d.run.status));
  row("Branch", diagnoses.map(d => d.run.headBranch));
  row("Commit", diagnoses.map(d => d.run.headSha.slice(0, 8)));
  row("Agent type", diagnoses.map(d => d.agent.agentType ?? "?"));
  row("MCP connected", diagnoses.map(d => d.mcp.connectionStatus ?? "?"));
  row("@skyramp/skyramp", diagnoses.map(d => d.mcp.skyrampPackageVersion ?? "?"));
  row("MCP version", diagnoses.map(d => d.mcp.mcpVersion ?? "?"));
  row("Executor image", diagnoses.map(d => d.mcp.executorImageVersion ?? "?"));
  row("Report submitted", diagnoses.map(d => d.agent.reportSubmitted ? "yes" : "no"));
  row("Timed out", diagnoses.map(d => d.agent.timedOut ? "yes" : "no"));
  row("Retries", diagnoses.map(d => String(d.agent.retryCount)));
  row("Agent logs", diagnoses.map(d => d.agentLogAvailable ? "yes" : "no"));
  row("MCP errors", diagnoses.map(d => String(d.mcp.errors.length)));

  console.log();

  // Highlight differences
  console.log("── Key Differences ──");
  const diffs: string[] = [];

  const conclusions = new Set(diagnoses.map(d => d.run.conclusion));
  if (conclusions.size > 1) {
    diffs.push(`Conclusion differs: ${diagnoses.map(d => `${d.run.runId}=${d.run.conclusion}`).join(" vs ")}`);
  }

  const pkgVersions = new Set(diagnoses.map(d => d.mcp.skyrampPackageVersion));
  if (pkgVersions.size > 1) {
    diffs.push(`@skyramp/skyramp version differs: ${diagnoses.map(d => `${d.run.runId}=${d.mcp.skyrampPackageVersion ?? "?"}`).join(" vs ")}`);
  }

  const connStatus = new Set(diagnoses.map(d => d.mcp.connectionStatus));
  if (connStatus.size > 1) {
    diffs.push(`MCP connection status differs: ${diagnoses.map(d => `${d.run.runId}=${d.mcp.connectionStatus ?? "?"}`).join(" vs ")}`);
  }

  const commits = new Set(diagnoses.map(d => d.run.headSha));
  if (commits.size > 1) {
    diffs.push(`Different commits — check for code changes between runs`);
  }

  if (diffs.length === 0) {
    console.log("  No significant differences detected");
  } else {
    for (const diff of diffs) {
      console.log(`  ⚠  ${diff}`);
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("Error: gh CLI not found. Install from https://cli.github.com/");
    process.exit(1);
  }

  const { runIds, repo, compare } = parseArgs(process.argv);

  const diagnoses: Diagnosis[] = [];
  for (const runId of runIds) {
    diagnoses.push(await buildDiagnosis(runId, repo));
  }

  console.log();

  if (compare && diagnoses.length >= 2) {
    renderComparison(diagnoses);
  } else {
    for (const d of diagnoses) {
      renderDiagnosis(d);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
