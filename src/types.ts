export type AgentType = 'cursor' | 'copilot'

export type McpSource = 'npm' | 'github'

export interface ActionInputs {
  skyrampLicenseFile: string
  cursorApiKey: string
  copilotApiKey: string
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
