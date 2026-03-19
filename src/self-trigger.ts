import * as core from '@actions/core'
import * as github from '@actions/github'
import { exec } from './utils'
import { BOT_EMAIL, BOT_NAME } from './constants'


export interface SelfTriggerResult {
  skip: boolean
  botName: string
  botEmail: string
}

/**
 * Check whether this run was triggered by the bot's own commit to prevent infinite loops.
 * For pull_request events, uses the PR head SHA (not the merge commit) to get the real author.
 */
export async function checkSelfTrigger(): Promise<SelfTriggerResult> {
  core.startGroup('Checking for self-triggered execution')

  let commitAuthor = ''
  let commitEmail = ''

  const ctx = github.context

  // Try github.event.head_commit first (works for push events)
  const headCommit = (ctx.payload as Record<string, unknown>).head_commit as
    | { author?: { name?: string; email?: string } }
    | undefined
  if (headCommit?.author?.name) {
    commitAuthor = headCommit.author.name
    commitEmail = headCommit.author.email ?? ''
  }

  // Fallback to git log for pull_request events
  if (!commitAuthor) {
    const prHeadSha = ctx.payload.pull_request?.head?.sha as string | undefined
    const ref = prHeadSha || 'HEAD'
    if (prHeadSha) {
      core.info(`Using pull_request head SHA: ${prHeadSha}`)
    }

    commitAuthor = (await exec('git', ['log', '-1', '--pretty=format:%an', ref], { silent: true })).stdout.trim()
    commitEmail = (await exec('git', ['log', '-1', '--pretty=format:%ae', ref], { silent: true })).stdout.trim()
  }

  core.info(`Commit author: ${commitAuthor}`)
  core.info(`Commit email: ${commitEmail}`)
  core.info(`Expected name: ${BOT_NAME}`)
  core.info(`Expected email: ${BOT_EMAIL}`)

  const isBotCommit = commitAuthor === BOT_NAME && commitEmail === BOT_EMAIL

  // Only skip on 'synchronize' events (bot pushing commits to an existing PR).
  // User-initiated events should always run, even if the head commit is from a
  // previous testbot auto-commit:
  //   - 'opened'/'reopened': user created or reopened a PR on a branch that
  //     happens to have a bot commit at HEAD (e.g. closed old PR, opened new one)
  //   - 'workflow_dispatch': explicit manual re-run from Actions UI
  //   - 'issue_comment': user commented @skyramp-testbot on a PR
  // See SKYR-3650.
  const action = ctx.payload.action as string | undefined
  const isSynchronize = ctx.eventName === 'pull_request' && action === 'synchronize'
  const skip = isBotCommit && isSynchronize

  if (isBotCommit && !isSynchronize) {
    core.notice(`Head commit is by ${BOT_NAME} but event is '${ctx.eventName}' action='${action ?? 'N/A'}' (not pull_request/synchronize). Proceeding normally.`)
  } else if (skip) {
    core.notice(`Detected self-triggered execution (commit by ${BOT_NAME} on synchronize event). Skipping to prevent recursion.`)
  } else {
    core.notice('Not a self-triggered execution. Proceeding with test maintenance.')
  }

  core.endGroup()

  return { skip, botName: BOT_NAME, botEmail: BOT_EMAIL }
}
