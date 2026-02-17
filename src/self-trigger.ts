import * as core from '@actions/core'
import * as github from '@actions/github'
import { exec } from './utils'

const BOT_NAME = 'Skyramp Testbot'
const BOT_EMAIL = 'test-bot@skyramp.dev'

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

  const skip = commitAuthor === BOT_NAME && commitEmail === BOT_EMAIL
  if (skip) {
    core.notice('Detected self-triggered execution (commit by Skyramp Testbot). Skipping to prevent recursion.')
  } else {
    core.notice('Not a self-triggered execution. Proceeding with test maintenance.')
  }

  core.endGroup()

  return { skip, botName: BOT_NAME, botEmail: BOT_EMAIL }
}
