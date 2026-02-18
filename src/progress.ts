import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'

const SKYRAMP_LOGO = '<img src="https://avatars.githubusercontent.com/u/93742274?s=200&v=4" alt="Skyramp" width="28" />'
const SPINNER_GIF = '<img src="https://raw.githubusercontent.com/letsramp/testbot/main/assets/progress-spinner.gif" alt="In progress" width="16" />'

let _githubToken = ''

/** Must be called before any other progress functions to provide the GitHub token. */
export function setGitHubToken(token: string): void {
  _githubToken = token
}

export function generateProgressBody(step: number, reportContent?: string): string {
  const check1 = step >= 1 ? '[x]' : '[ ]'
  const check2 = step >= 2 ? '[x]' : '[ ]'
  const check3 = step >= 3 ? '[x]' : '[ ]'
  const spinner = step < 3 ? ` ${SPINNER_GIF}` : ''

  let body = `### ${SKYRAMP_LOGO} Skyramp Testbot Plan${spinner}
Reviewing the Pull Request for test recommendations.

- ${check1} Analyzing code changes
- ${check2} Running tests
- ${check3} Generating report`

  if (reportContent) {
    body += `\n\n${reportContent}`
  }

  return body
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
export async function postInitialProgress(prNumber: number): Promise<number | null> {
  core.startGroup('Posting initial progress comment')
  try {
    const octokit = getOctokit()
    const body = generateProgressBody(1)
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
export async function updateProgress(commentId: number, step: number): Promise<void> {
  try {
    const octokit = getOctokit()
    const body = generateProgressBody(step)
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
export async function appendReportToProgress(commentId: number, reportFile: string): Promise<boolean> {
  try {
    const reportContent = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf-8') : ''
    const octokit = getOctokit()
    const body = generateProgressBody(3, reportContent)
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
export async function postStandaloneComment(prNumber: number, bodyOrFile: string, isFile = false): Promise<void> {
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
  } catch (err) {
    core.warning(`Failed to post standalone comment: ${err}`)
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
