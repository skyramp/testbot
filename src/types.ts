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
  testMaintenance: { description: string }[]
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
