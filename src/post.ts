import * as core from '@actions/core'
import * as github from '@actions/github'
import * as path from 'path'
import { getInputs } from './inputs'
import { loadConfig } from './config'
import { teardownServices } from './services'
import { generateCancelledBody } from './progress'
import type { StepState } from './progress'

async function post(): Promise<void> {
  // ── 1. Service teardown (always runs) ──────────────────────────────
  try {
    const inputs = getInputs()
    const config = await loadConfig(inputs)
    const workingDir = path.resolve(inputs.workingDirectory)
    await teardownServices(config, workingDir)
  } catch (err) {
    // Never fail the action from the post step — teardown errors must not mask test results
    core.warning(`Service teardown error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 2. Cancellation detection ──────────────────────────────────────
  // If main saved a progressCommentId but never set 'completed', the run
  // may have been cancelled. Confirm via the workflow run conclusion API
  // before updating the comment — a failure/error is not a cancellation.
  const commentIdStr = core.getState('progressCommentId')
  const completed = core.getState('completed')

  if (commentIdStr && !completed) {
    try {
      const githubToken = core.getInput('githubToken')
      if (!githubToken) return

      const commentId = parseInt(commentIdStr, 10)
      const octokit = github.getOctokit(githubToken)
      const { owner, repo } = github.context.repo

      // Query the workflow run to confirm it was actually cancelled
      const { data: run } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: github.context.runId,
      })

      if (run.conclusion !== 'cancelled') {
        core.debug(`Workflow conclusion is '${run.conclusion ?? 'null'}', not cancelled — skipping cancellation comment`)
        return
      }

      const stepsJson = core.getState('steps')
      const steps: StepState[] = stepsJson ? JSON.parse(stepsJson) : []
      const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`
      const body = generateCancelledBody(steps, runUrl)

      await octokit.rest.issues.updateComment({
        ...github.context.repo,
        comment_id: commentId,
        body,
      })
      core.notice('Progress comment updated with cancellation notice')
    } catch (err) {
      core.warning(`Failed to update progress comment on cancellation: ${err}`)
    }
  }
}

post()
