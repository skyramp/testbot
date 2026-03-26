import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'

let _githubToken = ''

/** Must be called before any other progress functions to provide the GitHub token. */
export function setGitHubToken(token: string): void {
  _githubToken = token
}

export function generateProgressBody(step: number, reportContent?: string, isCommentTrigger = false): string {
  const check1 = step >= 1 ? '[x]' : '[ ]'
  const check2 = step >= 2 ? '[x]' : '[ ]'
  const check3 = step >= 3 ? '[x]' : '[ ]'

  const { owner, repo } = github.context.repo
  const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`
  const step1Label = isCommentTrigger ? 'Analyzing user request' : 'Analyzing Pull Request'

  // When the final report is ready, replace the progress checklist with just the report
  if (reportContent) {
    // Strip the marker if renderReport already included it to avoid duplicates
    const content = reportContent.replace(/^\s*<!--\s*skyramp-testbot\s*-->\s*\n?/, '')
    return `<!-- skyramp-testbot -->\n([workflow run](${runUrl}))\n\n${content}`
  }

  return `<!-- skyramp-testbot -->
### Skyramp Testbot Plan
Reviewing the Pull Request for test recommendations. ([workflow run](${runUrl}))

- ${check1} ${step1Label}
- ${check2} Running tests
- ${check3} Generating report`
}

function getOctokit() {
  if (!_githubToken) {
    throw new Error('No GitHub token available for Octokit. Ensure setGitHubToken() has been called.')
  }
  return github.getOctokit(_githubToken)
}

/**
 * Post the initial progress comment on the PR. Returns the comment ID (or null on failure).
 */
export async function postInitialProgress(prNumber: number, isCommentTrigger = false): Promise<number | null> {
  core.startGroup('Posting initial progress comment')
  try {
    const octokit = getOctokit()
    const body = generateProgressBody(1, undefined, isCommentTrigger)
    const { data } = await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: prNumber,
      body,
    })
    core.notice(`Progress comment created (ID: ${data.id})`)
    core.endGroup()
    return data.id
  } catch (err) {
    core.warning(`Failed to create progress comment: ${err}`)
    core.endGroup()
    return null
  }
}

/**
 * Update the progress comment to reflect the current step.
 */
export async function updateProgress(commentId: number, step: number, isCommentTrigger = false): Promise<void> {
  try {
    const octokit = getOctokit()
    const body = generateProgressBody(step, undefined, isCommentTrigger)
    await octokit.rest.issues.updateComment({
      ...github.context.repo,
      comment_id: commentId,
      body,
    })
  } catch (err) {
    core.warning(`Failed to update progress comment: ${err}`)
  }
}

/**
 * Append the final report to the progress comment (step 3 + report content).
 * Returns true on success, false on failure (caller should fall back to standalone comment).
 */
export async function appendReportToProgress(commentId: number, reportFile: string, isCommentTrigger = false): Promise<boolean> {
  try {
    const reportContent = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf-8') : ''
    const octokit = getOctokit()
    const body = generateProgressBody(3, reportContent, isCommentTrigger)
    await octokit.rest.issues.updateComment({
      ...github.context.repo,
      comment_id: commentId,
      body,
    })
    return true
  } catch (err) {
    core.warning(`Failed to append report to progress comment: ${err}`)
    return false
  }
}

/**
 * Post a standalone PR comment (fallback when no progress comment exists).
 */
export async function postStandaloneComment(prNumber: number, bodyOrFile: string, isFile = false): Promise<boolean> {
  try {
    const octokit = getOctokit()
    let body: string
    if (isFile) {
      body = fs.existsSync(bodyOrFile)
        ? fs.readFileSync(bodyOrFile, 'utf-8')
        : 'No report available.'
    } else {
      body = bodyOrFile
    }
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: prNumber,
      body,
    })
    return true
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    core.error(`Failed to post standalone comment for PR #${prNumber}: ${errorMessage}`)
    return false
  }
}

/**
 * Replace an existing progress comment with a failure body.
 * Used to turn the "Analyzing PR…" spinner into an error message in-place,
 * so no stale in-progress comment is left behind.
 * Non-fatal: logs a warning on failure so the caller can still re-throw the original error.
 */
export async function replaceProgressWithFailure(commentId: number, body: string): Promise<void> {
  try {
    const octokit = getOctokit()
    await octokit.rest.issues.updateComment({
      ...github.context.repo,
      comment_id: commentId,
      body,
    })
  } catch (err) {
    core.warning(`Failed to update progress comment with failure details: ${err}`)
  }
}

/**
 * Post a validation error as a PR comment.
 */
export async function postValidationError(prNumber: number | undefined, errorMsg: string): Promise<void> {
  core.error(errorMsg)
  if (!prNumber) return

  const body = `## :warning: Skyramp Testbot - Validation Error\n\n**Error:** ${errorMsg}\n\nPlease check your workflow configuration and ensure all required secrets are set correctly.`
  await postStandaloneComment(prNumber, body)
}
