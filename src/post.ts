import * as core from '@actions/core'
import * as path from 'path'
import { getInputs } from './inputs'
import { loadConfig } from './config'
import { teardownServices } from './services'

async function post(): Promise<void> {
  try {
    const inputs = getInputs()
    const config = await loadConfig(inputs)
    const workingDir = path.resolve(inputs.workingDirectory)
    await teardownServices(config, workingDir)
  } catch (err) {
    // Never fail the action from the post step — teardown errors must not mask test results
    core.warning(`Service teardown error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

post()
