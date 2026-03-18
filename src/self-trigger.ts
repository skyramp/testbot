import * as core from '@actions/core'
import * as github from '@actions/github'
import { exec } from './utils'
import { BOT_NAME, BOT_EMAIL } from './constants'

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

  // Only skip on 'synchronize' events (bot pushing commits). User-initiated events
  // like 'opened' or 'reopened' should always run, even if the head commit was from
  // a previous testbot auto-commit (e.g. user closes PR and opens a new one on the
  // same branch). See SKYR-3650.
  const action = ctx.payload.action as string | undefined
  const isPushTriggered = action === 'synchronize'
  const skip = isBotCommit && isPushTriggered

  if (isBotCommit && !isPushTriggered) {
    core.notice(`Head commit is by Skyramp Testbot but event action is '${action}' (not synchronize). Proceeding normally.`)
  } else if (skip) {
    core.notice('Detected self-triggered execution (commit by Skyramp Testbot on synchronize event). Skipping to prevent recursion.')
  } else {
    core.notice('Not a self-triggered execution. Proceeding with test maintenance.')
  }

  core.endGroup()

  return { skip, botName: BOT_NAME, botEmail: BOT_EMAIL }
}
