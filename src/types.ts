import * as core from '@actions/core'

export type AgentType = 'cursor' | 'copilot' | 'claude'

export type McpSource = 'npm' | 'github'

/** Name used to register and reference the Skyramp MCP server across all agent types. */
export const SKYRAMP_MCP_SERVER_NAME = 'skyramp'

export interface ActionInputs {
  skyrampLicenseFile: string
  cursorApiKey: string
  copilotApiKey: string
  anthropicApiKey: string
  testDirectory: string
  serviceStartupCommand: string
  authTokenCommand: string
  skyrampExecutorVersion: string
  skyrampMcpVersion: string
  skyrampMcpSource: McpSource
  skyrampMcpGithubToken: string
  skyrampMcpGithubRef: string
  nodeVersion: string
  skipServiceStartup: boolean
  healthCheckCommand: string
  healthCheckTimeout: number
  healthCheckDiagnosticsCommand: string
  workingDirectory: string
  autoCommit: boolean
  commitMessage: string
  postPrComment: boolean
  testExecutionTimeout: number
  testbotMaxRetries: number
  testbotRetryDelay: number
  testbotTimeout: number
  reportCollapsed: boolean
  enableDebug: boolean
}

/** Workspace-derived service information passed to the agent prompt. */
export interface WorkspaceServiceInfo {
  serviceName: string
  language?: string
  framework?: string
  baseUrl?: string
  outputDir?: string
}

/** Configuration resolved from .skyramp/workspace.yml merged with action inputs. */
export interface ResolvedConfig {
  testDirectory: string
  serviceStartupCommand: string
  authTokenCommand: string
  skyrampExecutorVersion: string
  skyrampMcpVersion: string
  skyrampMcpSource: McpSource
  skyrampMcpGithubRef: string
  nodeVersion: string
  skipServiceStartup: boolean
  healthCheckCommand: string
  healthCheckTimeout: number
  healthCheckDiagnosticsCommand: string
  autoCommit: boolean
  commitMessage: string
  postPrComment: boolean
  testExecutionTimeout: number
  testbotMaxRetries: number
  testbotRetryDelay: number
  testbotTimeout: number
  reportCollapsed: boolean
  enableDebug: boolean
  services: WorkspaceServiceInfo[]
}

export interface AgentCommand {
  command: string
  args: string[]
}

export interface McpPaths {
  command: string
  args: string
  licensePath: string
}

export interface SummaryMetrics {
  modified: number
  created: number
  executed: number
}

export interface TestbotReport {
  businessCaseAnalysis: string
  newTestsCreated: { testType: string; endpoint: string; fileName: string }[]
  testMaintenance: (
    | { description: string }
    | {
        fileName: string
        description: string
        beforeStatus: string
        beforeDetails: string
        afterStatus: string
        afterDetails: string
      }
  )[]
  testResults: { testType: string; endpoint: string; status: string; details: string }[]
  issuesFound: { description: string }[]
  commitMessage?: string
}

export interface Paths {
  tempDir: string
  licensePath: string
  gitDiffPath: string
  summaryPath: string
  agentLogPath: string
  agentStdoutPath: string
  combinedResultPath: string
}

/** Strategy interface for agent-type-specific behavior. */
export abstract class AgentStrategy {
  abstract readonly label: string
  abstract readonly binary: string
  abstract readonly envVar: string
  abstract readonly apiKeyField: keyof ActionInputs
  readonly supportsNdjsonLog: boolean = false

  /** Install steps (called inside withRetry). */
  abstract install(): Promise<void>

  /** Post-install initialization (enable MCP, verify connectivity). */
  abstract initialize(): Promise<void>

  /** Write MCP config for this agent. */
  abstract configureMcp(
    mcpCommand: string, argsArray: string[], env: Record<string, string>, timeout: number
  ): Promise<void>

  /** Build the CLI command + args. */
  abstract buildCommand(enableDebug: boolean): AgentCommand

  /** Export API key via core.exportVariable. Override for custom behavior (e.g., process.env). */
  exportEnv(inputs: ActionInputs, _config: ResolvedConfig): void {
    const key = inputs[this.apiKeyField]
    if (key) core.exportVariable(this.envVar, key)
  }
}
