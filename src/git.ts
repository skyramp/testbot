import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import { exec, debug } from './utils'
import type { ResolvedConfig } from './types'

/**
 * Generate a git diff between the PR base and HEAD, written to the given path.
 */
export async function generateGitDiff(diffPath: string, workingDir: string, baseBranch?: string): Promise<void> {
  core.startGroup('Generating git diff')

  const baseSha = github.context.payload.pull_request?.base?.sha as string | undefined

  let diffContent: string
  if (baseSha) {
    diffContent = (await exec('git', ['diff', baseSha], { cwd: workingDir })).stdout
  } else if (baseBranch) {
    // workflow_dispatch / issue_comment: diff against the PR's base branch
    core.info(`Not a pull_request event, diffing against origin/${baseBranch}`)
    diffContent = (await exec('git', ['diff', `origin/${baseBranch}`], { cwd: workingDir })).stdout
  } else {
    core.warning('No base SHA or base branch available, using HEAD~1 for diff')
    diffContent = (await exec('git', ['diff', 'HEAD~1'], { cwd: workingDir })).stdout
  }

  fs.writeFileSync(diffPath, diffContent)

  const lines = diffContent.split('\n').length
  core.info(`Generated diff with ${lines} lines`)
  debug(`Git diff path: ${diffPath}`)

  core.endGroup()
}

/**
 * Configure git identity for auto-commit.
 */
export async function configureGitIdentity(botName: string, botEmail: string): Promise<void> {
  core.startGroup('Configuring git identity')
  await exec('git', ['config', 'user.name', botName])
  await exec('git', ['config', 'user.email', botEmail])
  core.notice(`Git identity configured as ${botName} <${botEmail}>`)
  core.endGroup()
}

/**
 * Auto-commit test changes matching the file pattern.
 * Returns the commit SHA if a commit was made, or empty string if nothing to commit.
 * Assumes configureGitIdentity() has already been called.
 */
export async function autoCommit(config: ResolvedConfig): Promise<string> {
  core.startGroup('Auto-committing test changes')

  // Collect all directories to stage: per-service testDirectories + fallback testDirectory
  const dirs = new Set<string>()
  for (const svc of config.services) {
    if (svc.testDirectory) dirs.add(svc.testDirectory)
  }
  if (dirs.size === 0) dirs.add(config.testDirectory)

  // Stage files from each directory
  for (const dir of dirs) {
    const { exitCode: addExitCode } = await exec(
      'git', ['add', '--', dir],
      { ignoreReturnCode: true }
    )
    if (addExitCode !== 0) {
      core.warning(`git add returned non-zero for '${dir}', there may be no matching files`)
    }
  }

  // Check if there are staged changes
  const { exitCode: diffExitCode } = await exec(
    'git', ['diff', '--cached', '--quiet'],
    { ignoreReturnCode: true }
  )

  if (diffExitCode === 0) {
    core.notice('No test file changes to commit')
    core.setOutput('commit_sha', '')
    core.endGroup()
    return ''
  }

  // Commit (uses git config user.name/user.email set by configureGitIdentity)
  await exec('git', ['commit', '-m', config.commitMessage])

  // Get the commit SHA
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { silent: true })
  const sha = stdout.trim()

  // Push — pull_request events use a detached HEAD (merge commit),
  // so we must push to the PR branch explicitly.
  // For issue_comment/workflow_dispatch we already checked out the PR branch,
  // but still push explicitly to be safe.
  const headRef = github.context.payload.pull_request?.head?.ref as string | undefined
    || config.prHeadRef
  if (headRef) {
    await exec('git', ['push', 'origin', `HEAD:refs/heads/${headRef}`])
  } else if (github.context.eventName === 'pull_request') {
    throw new Error('Cannot push: pull_request event but head ref is missing from payload')
  } else {
    await exec('git', ['push'])
  }

  core.notice(`Committed and pushed test changes (${sha})`)
  core.setOutput('commit_sha', sha)
  core.endGroup()

  return sha
}
