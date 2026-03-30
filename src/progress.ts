import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'

export enum ProgressStep {
  Setup = 'setup',
  Analyzing = 'analyzing',
  Generating = 'generating',
  Executing = 'executing',
  Maintaining = 'maintaining',
  Reporting = 'reporting',
}

export interface StepState {
  step: ProgressStep
  label: string
  status: 'pending' | 'active' | 'completed'
  startedAt?: number
  completedAt?: number
}

/** Format a duration in milliseconds as "Xs" or "Xm Ys". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

/** Create the initial 6-step list with all steps pending. */
export function createInitialSteps(isCommentTrigger = false): StepState[] {
  return [
    { step: ProgressStep.Setup, label: 'Setting up environment', status: 'pending' },
    { step: ProgressStep.Analyzing, label: isCommentTrigger ? 'Analyzing user request' : 'Analyzing code changes', status: 'pending' },
    { step: ProgressStep.Maintaining, label: 'Recommending tests', status: 'pending' },
    { step: ProgressStep.Generating, label: 'Generating tests', status: 'pending' },
    { step: ProgressStep.Executing, label: 'Executing tests', status: 'pending' },
    { step: ProgressStep.Reporting, label: 'Generating report', status: 'pending' },
  ]
}

let _githubToken = ''

/** Must be called before any other progress functions to provide the GitHub token. */
export function setGitHubToken(token: string): void {
  _githubToken = token
}

export function generateProgressBody(steps: StepState[], reportContent?: string, _isCommentTrigger = false): string {
  const { owner, repo } = github.context.repo
  const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`

  // When the final report is ready, replace the progress checklist with just the report
  if (reportContent) {
    // Strip the marker if renderReport already included it to avoid duplicates
    const content = reportContent.replace(/^\s*<!--\s*skyramp-testbot\s*-->\s*\n?/, '')
    return `<!-- skyramp-testbot -->\n### Skyramp Testbot\n([workflow run](${runUrl}))\n\n${content}`
  }

  const lines = steps.map(s => {
    if (s.status === 'completed') {
      const elapsed = s.startedAt != null && s.completedAt != null
        ? ` (${formatElapsed(s.completedAt - s.startedAt)})`
        : ''
      return `- [x] ${s.label}${elapsed}`
    }
    if (s.status === 'active') {
      return `- \u23F3 ${s.label}...`
    }
    return `- [ ] ${s.label}`
  })

  return `<!-- skyramp-testbot -->
### Skyramp Testbot
Reviewing the Pull Request for test recommendations. ([workflow run](${runUrl}))

${lines.join('\n')}`
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
export async function postInitialProgress(prNumber: number, steps: StepState[]): Promise<number | null> {
  core.startGroup('Posting initial progress comment')
  try {
    const octokit = getOctokit()
    const body = generateProgressBody(steps)
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
export async function updateProgress(commentId: number, steps: StepState[]): Promise<void> {
  try {
    const octokit = getOctokit()
    const body = generateProgressBody(steps)
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
export async function appendReportToProgress(commentId: number, reportFile: string, steps: StepState[]): Promise<boolean> {
  try {
    const reportContent = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf-8') : ''
    const octokit = getOctokit()
    const body = generateProgressBody(steps, reportContent)
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
 * Generate a cancelled-run comment body. Replaces the progress checklist
 * so the user knows this run was superseded (e.g. by a newer push).
 */
export function generateCancelledBody(steps: StepState[], runUrl: string): string {
  const completedSteps = steps.filter(s => s.status === 'completed')
  const activeStep = steps.find(s => s.status === 'active')

  const lines: string[] = []
  for (const s of completedSteps) {
    const elapsed = s.startedAt != null && s.completedAt != null
      ? ` (${formatElapsed(s.completedAt - s.startedAt)})`
      : ''
    lines.push(`- [x] ${s.label}${elapsed}`)
  }
  if (activeStep) {
    lines.push(`- :x: ${activeStep.label} — cancelled`)
  }
  for (const s of steps.filter(s => s.status === 'pending')) {
    lines.push(`- [ ] ~~${s.label}~~`)
  }

  return `<!-- skyramp-testbot -->
### Skyramp Testbot — Cancelled
This run was superseded by a newer commit. ([workflow run](${runUrl}))

${lines.join('\n')}`
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
