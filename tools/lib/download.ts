/**
 * Shared log acquisition utilities for debugging tools.
 */

import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

const execFileAsync = promisify(execFile);

export class FatalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FatalError";
  }
}

export function requireGh(): void {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    throw new FatalError(
      "gh CLI not found. Install from https://cli.github.com/ or use --file/--files mode."
    );
  }
}

export async function downloadLog(runId: string, repo: string): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skyramp-tools-"));
  try {
    await execFileAsync(
      "gh",
      ["run", "download", runId, "--repo", repo, "--name", "skyramp-agent-logs", "--dir", tmpDir],
    );
  } catch (e: unknown) {
    const msg =
      e instanceof Error && "stderr" in e
        ? (e as { stderr: Buffer }).stderr?.toString()
        : String(e);
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw new FatalError(
      `Failed to download artifact from run ${runId}:\n${msg}\nThe run may not have debug enabled, or the artifact may have expired.`
    );
  }

  const logFile = path.join(tmpDir, "agent-log.ndjson");
  try {
    await fsp.stat(logFile);
  } catch {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw new FatalError("agent-log.ndjson not found in downloaded artifact.");
  }

  return logFile;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}
