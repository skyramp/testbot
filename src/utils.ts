import * as core from '@actions/core'
import * as actionsExec from '@actions/exec'

interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Execute a command and capture its output.
 * Throws on non-zero exit code unless ignoreReturnCode is set.
 * Optional timeout (in milliseconds) causes the promise to reject if the command
 * doesn't finish in time.  Note: the child process is NOT killed on timeout
 * (@actions/exec doesn't expose the handle); it will be cleaned up when the
 * Actions runner tears down the job.
 */
export async function exec(
  command: string,
  args: string[] = [],
  options: { cwd?: string; silent?: boolean; ignoreReturnCode?: boolean; env?: Record<string, string>; input?: Buffer; timeout?: number } = {}
): Promise<ExecResult> {
  let stdout = ''
  let stderr = ''

  const execOptions: actionsExec.ExecOptions = {
    cwd: options.cwd,
    silent: options.silent ?? false,
    ignoreReturnCode: options.ignoreReturnCode ?? false,
    env: options.env ? { ...process.env, ...options.env } as { [key: string]: string } : undefined,
    input: options.input,
    listeners: {
      stdout: (data: Buffer) => { stdout += data.toString() },
      stderr: (data: Buffer) => { stderr += data.toString() },
    },
  }

  if (options.timeout) {
    let timer: ReturnType<typeof setTimeout>
    const exitCode = await Promise.race([
      actionsExec.exec(command, args, execOptions),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Command timed out after ${Math.round(options.timeout! / 60_000)}m: ${command}`)),
          options.timeout,
        )
      }),
    ]).finally(() => clearTimeout(timer!))
    return { exitCode, stdout, stderr }
  }

  const exitCode = await actionsExec.exec(command, args, execOptions)
  return { exitCode, stdout, stderr }
}

/** Sleep for the given number of seconds. */
export function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

/**
 * Retry an async operation with delay between attempts.
 * The function should throw on failure; the last throw propagates to the caller.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; delay: number; label: string },
): Promise<T> {
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt < opts.retries) {
        core.warning(`${opts.label} failed, retrying (${attempt}/${opts.retries})...`)
        await sleep(opts.delay)
      } else {
        throw err
      }
    }
  }
  throw new Error('unreachable')
}

/**
 * Run an async function inside a core.startGroup/endGroup block.
 * The group is always closed, even if the function throws.
 */
export async function withGroup<T>(name: string, fn: () => Promise<T>): Promise<T> {
  core.startGroup(name)
  try {
    return await fn()
  } finally {
    core.endGroup()
  }
}

// ── Debug logging ────────────────────────────────────────────────────────────
// core.debug() requires ACTIONS_STEP_DEBUG set before the step starts, which
// can't be done from within the same step.  This module provides a debug()
// helper that uses core.info() gated on a runtime flag.

let _debugEnabled = false

export function setDebugEnabled(enabled: boolean): void {
  _debugEnabled = enabled
}

export function debug(msg: string): void {
  if (_debugEnabled) core.info(`[debug] ${msg}`)
}
