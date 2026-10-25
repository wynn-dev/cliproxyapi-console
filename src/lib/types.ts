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
    /** The current run was started after CPA exited on its own, at lastExit.at. */
    startedAfterCrash?: boolean
  }
  cpa: { version: string | null; install: InstallProgress | null }
  config: { host: string; port: number; tls: boolean; clientKeys: string[] } | null
  /** This machine's network addresses, for clients on other machines. */
  addresses: string[]
  /** Whether the console runs as a background service, and the command that installs it as one. */
  service: boolean
  serviceCommand: string
  /** accessLogError: why turned-away requests are not being read from CPA's log. */
  collector: { lastPollAt: number | null; lastError: string | null; accessLogError: string | null }
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
 *
 * requests and failed count client requests: one that failed over to another account and then
 * succeeded is one success. Turned-away requests are included in both. attempts counts every
 * upstream attempt; per credential rows count attempts as requests.
 */
export interface UsageMetrics {
  requests: number
  failed: number
  /** Client requests that succeeded after a failed attempt. */
  recovered: number
  turnedAway: number
  attempts: number
  failedAttempts: number
  input: number
  output: number
  reasoning: number
  cached: number
  cacheWrite: number
  total: number
  avgLatency: number | null
  avgTtft: number | null
  /** USD at public API list prices (server/api-prices.ts). */
  value: number
  /** Tokens of models with no list price, left out of value. */
  unpricedTokens: number
}

export interface UsagePoint {
  t: number
  requests: number
  failed: number
  turnedAway: number
  input: number
  output: number
  cached: number
  cacheWrite: number
  total: number
  avgLatency: number | null
}

export interface UsageSummary {
  bucketMs: number
  totals: UsageMetrics & { unpricedModels: string[] }
  series: UsagePoint[]
  byModel: (UsageMetrics & { key: string })[]
  byProvider: (UsageMetrics & { key: string })[]
  byCredential: (UsageMetrics & { key: string })[]
  byApiKey: (UsageMetrics & { key: string })[]
}

/** A turned-away reason, as the server's access-log.ts classifies it. */
export type TurnedAwayReason = 'cooldown' | 'no_account' | 'unknown_model' | 'client_key' | ''

/** An upstream attempt, or a turned-away request (turnedAway 1, negative id, no credential or tokens). */
export interface UsageRequest {
  id: number
  ts: number
  /** For turned-away requests, the short id from CPA's log (the last 8 characters). */
  requestId: string | null
  model: string
  alias: string
  provider: string
  endpoint: string
  authIndex: string
  authType: string
  apiKey: string
  failed: 0 | 1
  /** The client request succeeded in the end, on this attempt or another. */
  requestOk: 0 | 1
  turnedAway: 0 | 1
  reason: TurnedAwayReason
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
  responseModel: string
  responseServiceTier: string
  clientIp: string
  userAgent: string
  error: string
  /** USD at public API list prices; null without a price. */
  value: number | null
}

/** The share card's numbers for a time range (server/share.ts). Accounts are auth_index keys, most tokens first. */
export interface ShareSummary {
  from: number
  to: number
  requests: number
  tokens: number
  value: number
  unpricedTokens: number
  unpricedModels: string[]
  topModel: { model: string; tokens: number } | null
  /** Up to 5, most tokens first. */
  topModels: { model: string; tokens: number }[]
  cacheHitRate: number | null
  accounts: { key: string; tokens: number }[]
  /** Tokens per hour, hours with traffic only. */
  hours: { t: number; tokens: number }[]
  /** Input counts cache reads and writes; cached is the cache-read part. Output includes reasoning. */
  input: number
  output: number
  cached: number
  avgTtft: number | null
  /** Up to 5, most tokens first. */
  providers: { name: string; tokens: number }[]
  /** Conversations (CPA session ids), and the one with the most requests. */
  sessions: { count: number; compactions: number; longest: { requests: number; tokens: number; ms: number } | null }
  /** Client tools by user agent, up to 5, most tokens first. */
  clients: { name: string; tokens: number }[]
  planPrice: number | null
}

export interface UsageFacets {
  models: string[]
  providers: string[]
  credentials: string[]
  apiKeys: string[]
}

export interface ReserveStatus {
  /** Percent of each limit kept back; 0 is off. `fable` holds only the Fable models. */
  limits: Record<ReserveWindow | 'fable', number>
  /** Whether accounts that start using paid extra usage are held back. */
  extraUsage: boolean
  /** Whether the reserved account with the most left is released when every account of a provider is held back. */
  releaseWhenAllHeld: boolean
  /** Accounts the console disabled, or that were enabled by hand while reserved, by credential file name. */
  accounts: Record<string, ReserveHold>
  /** Accounts whose Fable models are held back, by credential file name. */
  fable: Record<string, FableHold>
  /** Accounts that look signed out but stay in rotation, by credential file name. */
  warnings: Record<string, SignInWarning>
}

export interface SignInWarning {
  /** `signed-out`: likely needs a new sign-in. `problem`: 403s, which a new sign-in may not fix. */
  kind: 'signed-out' | 'problem'
  detail: string
  /** Why the console did not turn it off although CPA says its tokens are dead. */
  kept?: string
}

export type ReserveHold = {
  /** When the hold ends (ms); 0 when it waits for a new sign-in. */
  until: number
  /** Enabled by hand while reserved: left alone until `until`. */
  overridden: boolean
  /** Overridden by the console because every account was held back. */
  released?: boolean
} & (
  | { reason: 'reserve'; windows: ReserveWindow[] }
  /** Billing its owner for extra usage; `windows` are the labels of the limits that ran out. Never overridden. */
  | { reason: 'extra-usage'; windows: string[] }
  /** Needs a new sign-in; `detail` is the error the provider gave. Never overridden. */
  | { reason: 'signed-out'; windows: string[]; detail?: string }
)

export interface OrderStatus {
  /** The setting. */
  enabled: boolean
  /** On and the routing strategy is fill first, so the console sets priorities. */
  active: boolean
  strategy: string | null
  /** routing.session-affinity: whether conversations stay on their account when it drops. */
  affinity: boolean
  /** Where the console last put each enabled Claude and Codex account, by credential file name. */
  accounts: Record<string, OrderPlacement>
  /** Each managed account's own priority, by credential file name. */
  own: Record<string, number>
}

export interface OrderPlacement {
  /** `first`: has room, ordered by weekly reset. `unknown`: no weekly reading. `held`: close to its reserve. */
  tier: 'first' | 'unknown' | 'held'
  /** 1-based position among the provider's accounts. */
  rank: number
  of: number
  weeklyResetsAt?: number
  windows?: ReserveWindow[]
  releaseAt?: number
  /** The account's own priority, the first sort key; restored when the feature is turned off. */
  original: number
  /** The priority the console gives it in CPA. */
  effective: number
}

export interface LimitChecks {
  /** Whether the console asks each provider's usage endpoint about idle accounts. */
  enabled: boolean
  /** Each account's last check, by credential file name. */
  accounts: Record<string, LimitCheck>
}

export interface LimitCheck {
  checkedAt: number
  /** The last successful check: the observed_at of the reading it stored. */
  okAt?: number
  /** Why the last check failed, and when the next try is. */
  error?: string
  status?: number
  retryAt?: number
}

export interface FableHold {
  /** When the Fable window resets (ms). */
  until: number
  /** Held because the Fable limit ran out with paid extra usage on, not for the reserve. */
  billing: boolean
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
