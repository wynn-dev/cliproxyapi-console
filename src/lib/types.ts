import type { ReserveWindow } from './limits'

// --- Console server ------------------------------------------------------------------------

export type ProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface InstallProgress {
  tag: string
  phase: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
  received: number
  total: number
  error?: string
}

export interface ConsoleState {
  configured: boolean
  installing?: InstallProgress
  consoleVersion: string
}

export interface ConsoleStatus {
  consoleVersion: string
  dataDir: string
  process: {
    state: ProcessState
    pid?: number
    port?: number
    startedAt?: number
    restarts: number
    lastExit?: { code: number | null; signal: string | null; at: number }
    lastError?: string
    lastCheck?: { ok: boolean; at: number; failingSince?: number }
    /** When CPA was last restarted because it stopped answering, and whether the current run is that restart. */
    lastHangAt?: number
    startedAfterHang: boolean
  }
  cpa: { version: string | null; install: InstallProgress | null }
  config: { host: string; port: number; tls: boolean; clientKeys: string[] } | null
  /** This machine's network addresses, for clients on other machines. */
  addresses: string[]
  /** Whether the console runs as a background service, and the command that installs it as one. */
  service: boolean
  serviceCommand: string
  collector: { lastPollAt: number | null; lastError: string | null }
}

export interface ReleaseInfo {
  tag: string
  publishedAt: string
  url: string
  notes: string
}

export interface OutputLine {
  seq: number
  ts: number
  stream: 'stdout' | 'stderr' | 'console'
  text: string
}

/**
 * Token counts mean the same for every provider: input is every prompt token, cache reads (cached)
 * and writes (cacheWrite) included; output includes reasoning; total is input + output.
 */
export interface UsageMetrics {
  requests: number
  failed: number
  input: number
  output: number
  reasoning: number
  cached: number
  cacheWrite: number
  total: number
  avgLatency: number | null
  avgTtft: number | null
}

export interface UsagePoint {
  t: number
  requests: number
  failed: number
  input: number
  output: number
  cached: number
  cacheWrite: number
  total: number
  avgLatency: number | null
}

export interface UsageSummary {
  bucketMs: number
  totals: UsageMetrics
  series: UsagePoint[]
  byModel: (UsageMetrics & { key: string })[]
  byProvider: (UsageMetrics & { key: string })[]
  byCredential: (UsageMetrics & { key: string })[]
  byApiKey: (UsageMetrics & { key: string })[]
}

export interface UsageRequest {
  id: number
  ts: number
  requestId: string | null
  model: string
  alias: string
  provider: string
  endpoint: string
  authIndex: string
  authType: string
  apiKey: string
  failed: 0 | 1
  statusCode: number
  stream: 0 | 1
  latencyMs: number
  ttftMs: number
  input: number
  output: number
  reasoning: number
  cached: number
  cacheWrite: number
  total: number
  reasoningEffort: string
  serviceTier: string
  clientIp: string
  userAgent: string
  error: string
}

export interface UsageFacets {
  models: string[]
  providers: string[]
  credentials: string[]
  apiKeys: string[]
}

export interface ReserveStatus {
  /** Percent of each limit kept back; 0 is off. */
  limits: Record<ReserveWindow, number>
  /** Accounts the reserve disabled, or that were enabled by hand while reserved, by credential file name. */
  accounts: Record<string, ReserveHold>
}

export interface ReserveHold {
  /** When the windows below their reserve reset (ms). */
  until: number
  windows: ReserveWindow[]
  /** Enabled by hand while reserved: left alone until `until`. */
  overridden: boolean
}

// --- CPA management API -------------------------------------------------------------------

export interface RecentBucket {
  time: string
  success: number
  failed: number
}

export interface Cooldown {
  scope: 'credential' | 'model'
  model_key?: string
  reason: string
  retry_at: string
  remaining_seconds: number
  backoff_level?: number
  http_status?: number
}

export type CredentialStatus = 'unknown' | 'active' | 'pending' | 'refreshing' | 'error' | 'disabled'

export interface Credential {
  id: string
  auth_index: string
  name: string
  type: string
  provider: string
  label: string
  status: CredentialStatus
  status_message: string
  disabled: boolean
  unavailable: boolean
  runtime_only: boolean
  source: 'file' | 'memory'
  size: number
  success: number
  failed: number
  recent_requests: RecentBucket[]
  quota?: { observed_at?: string; signals: Record<string, string> }
  cooldowns: Cooldown[] | null
  email?: string
  project_id?: string
  account_type?: 'oauth' | 'api_key'
  account?: string
  created_at?: string
  updated_at?: string
  modtime?: string
  last_refresh?: string
  next_retry_after?: string
  id_token?: { plan_type?: string; chatgpt_account_id?: string }
  priority?: number
  note?: string
  weight?: number
  websockets?: boolean
  request_retry?: number
  prefix?: string
  proxy_url?: string
}

export interface CredentialsList {
  observed_at: string
  files: Credential[]
}

export interface ModelEntry {
  id: string
  display_name?: string
  type?: string
  owned_by?: string
}

export interface ModelMapping {
  name: string
  alias: string
  [k: string]: unknown
}

export interface ApiKeyEntry {
  'api-key': string
  weight?: number
  auth_index?: string
  prefix?: string | null
  'proxy-url'?: string | null
  [k: string]: unknown
}

export interface ApiKeyGroup {
  name?: string
  'base-url'?: string
  priority?: number | null
  prefix?: string | null
  'proxy-url'?: string | null
  headers?: Record<string, string> | null
  models?: ModelMapping[] | null
  'excluded-models'?: string[] | null
  'disable-cooling'?: boolean | null
  'request-retry'?: number | null
  disabled?: boolean
  keys: ApiKeyEntry[]
  auth_index?: string
  [k: string]: unknown
}

export type ApiKeyUsage = Record<
  string,
  Record<string, { success: number; failed: number; recent_requests: RecentBucket[] }>
>

export interface LogsResponse {
  lines: string[]
  'line-count': number
  'latest-timestamp': number
  'next-cursor': string
  'cursor-reset'?: boolean
}

export interface ErrorLogFile {
  name: string
  size: number
  modified: number
}

// The v8 config tree is large; pages read the parts they need.
export type V8Config = Record<string, any>
