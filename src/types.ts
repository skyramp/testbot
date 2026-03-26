import * as core from '@actions/core'

export type AgentType = 'cursor' | 'copilot' | 'claude'

export type McpSource = 'npm' | 'github'

/** Name used to register and reference the Skyramp MCP server across all agent types. */
export const SKYRAMP_MCP_SERVER_NAME = 'skyramp'

/** Fields shared between action inputs and resolved config. */
export interface SharedConfig {
  testDirectory: string
  targetSetupCommand: string
  authTokenCommand: string
  targetTeardownCommand: string
  skipTargetTeardown: boolean
  skyrampExecutorVersion: string
  skyrampMcpVersion: string
  skyrampMcpSource: McpSource
  skyrampMcpGithubRef: string
  nodeVersion: string
  skipTargetSetup: boolean
  targetReadyCheckCommand: string
  targetReadyCheckTimeout: number
  targetReadyCheckDiagnosticsCommand: string
  autoCommit: boolean
  commitMessage: string
  postPrComment: boolean
  testExecutionTimeout: number
  testbotMaxRetries: number
  testbotRetryDelay: number
  testbotTimeout: number
  targetSetupRetries: number
  targetSetupRetryDelay: number
  reportCollapsed: boolean
  enableDebug: boolean
}

export interface ActionInputs extends SharedConfig {
  skyrampLicenseFile: string
  cursorApiKey: string
  copilotApiKey: string
  anthropicApiKey: string
  skyrampMcpGithubToken: string
  workingDirectory: string
}

/** Workspace-derived service information passed to the agent prompt. */
export interface WorkspaceServiceInfo {
  serviceName: string
  language?: string
  framework?: string
  baseUrl?: string
  testDirectory?: string
  /** Path or URL to an OpenAPI/Swagger schema in JSON or YAML format. Used by
   *  pre-flight to resolve partial route segments to full paths. */
  schemaPath?: string
}

/** Configuration resolved from .skyramp/workspace.yml merged with action inputs. */
export interface ResolvedConfig extends SharedConfig {
  services: WorkspaceServiceInfo[]
  /** PR head branch ref — set for issue_comment/workflow_dispatch events so autoCommit pushes to the right branch. */
  prHeadRef?: string
}

/** Per-service overrides from Target deployment details. */
export interface TargetServiceDetails {
  baseUrl?: string
  [key: string]: unknown
}

/**
 * Target deployment details parsed from targetSetupCommand JSON output.
 * Supports both single-service and multi-service repos.
 *
 * Single service:  {"baseUrl": "http://52.11.18.47:8000"}
 * Multi service:   {"services": {"backend": {"baseUrl": "..."}, "frontend": {"baseUrl": "..."}}}
 * Mixed:           {"baseUrl": "http://52.11.18.47:8000", "services": {"frontend": {"baseUrl": "..."}}}
 *
 * Resolution order per service: services[serviceName].baseUrl → top-level baseUrl → original workspace value.
 */
export interface TargetDeploymentDetails {
  baseUrl?: string
  services?: Record<string, TargetServiceDetails>
  [key: string]: unknown
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
  newTestsCreated: { testType: string; endpoint: string; fileName: string; description?: string; scenarioFile?: string; traceFile?: string; frontendTrace?: string }[]
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
  additionalRecommendations?: {
    testType: string
    scenarioName: string
    steps: {
      method?: string
      path?: string
      description: string
      expectedStatusCode?: number
      requestBody?: Record<string, unknown>
      responseBody?: Record<string, unknown>
    }[]
    description: string
    priority: string
    openApiSpec?: string
    backendTrace?: string
    frontendTrace?: string
  }[]
  issuesFound: { description: string }[]
  nextSteps?: string[]
  commitMessage?: string
}

export type PreflightIssueKind = 'NOT_DEPLOYED' | 'STALE_IMAGE' | 'AUTH_FAILURE' | 'UNHEALTHY'

export interface PreflightIssue {
  kind: PreflightIssueKind
  endpoint: string
  statusCode?: number
  message: string
  recommendation: string
}

export interface PreflightResult {
  /**
   * False when any issue was detected (NOT_DEPLOYED, STALE_IMAGE, AUTH_FAILURE,
   * or UNHEALTHY).  Callers should halt the agent run when false — all issue
   * kinds indicate the SUT is not in a state where test results would be valid.
   * True only when every probe returned a status that the probe classifier
   * considers healthy (for example, 2xx, 400, 405, and some other 4xx such as 422).
   */
  ready: boolean
  /** True when the check was skipped (no base URLs or no endpoints in diff). */
  skipped: boolean
  issues: PreflightIssue[]
  probedEndpoints: string[]
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

export interface StartServicesResult {
  /** Parsed JSON from the last line of the setup command stdout, or null. */
  details: TargetDeploymentDetails | null
  /**
   * True when the health check passed (or was skipped because setup was skipped).
   * False when the health check timed out — callers should surface this as a
   * pre-flight `NOT_DEPLOYED` issue rather than running the agent on a half-started SUT.
   */
  healthCheckPassed: boolean
  /**
   * Combined stdout + stderr from the last health-check attempt and the diagnostics
   * command.  Populated only when the health check timed out; empty string otherwise.
   * Callers can include this in the pre-flight failure PR comment.
   */
  healthCheckOutput: string
}