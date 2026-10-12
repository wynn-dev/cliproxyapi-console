/** What the insights endpoints return. Shared by the server and the SPA, so it imports nothing. */

/**
 * When a provider's pool of accounts runs down to its reserve at the pace of recent use. Capacity is
 * in "account-windows": 1 is one account's whole weekly (or 5-hour) limit, counted above the reserve.
 */
export interface WindowForecast {
  /**
   * `learning`: too little history to tell a pace. `idle`: no use in the history. `dry`: at the
   * reserve now. `runs-out`: reaches it within the horizon. `lasts`: does not.
   */
  status: 'learning' | 'idle' | 'dry' | 'runs-out' | 'lasts'
  /** Capacity left above the reserve now, in account-windows. */
  left: number
  /** Accounts in the pool with a reading of this window; the others are left out. */
  read: number
  /** Of those, readings over 12 hours old. */
  stale: number
  /** Use per hour, in account-windows, over `basisMs` of history. */
  perHour?: number
  basisMs: number
  /** History still needed before there is a pace (status `learning`). */
  needMs?: number
  /** When the pool reaches its reserve, and when a reset brings capacity back after that. */
  dryAt?: number
  backAt?: number
  /** The soonest reset of this window across the pool. */
  nextResetAt?: number
  horizonMs: number
}

export interface PoolForecast {
  provider: string
  /** Accounts in the pool: enabled, or held back by the reserve. Disabled by hand doesn't count. */
  accounts: number
  weekly: WindowForecast
  fiveHour: WindowForecast
}

export interface ForecastReport {
  at: number
  reserve: { '5h': number; weekly: number }
  providers: PoolForecast[]
}

/**
 * Why a conversation lost its prompt cache. `moved`, `reserve`, `extra-usage`, `limit` and `failure`
 * mean it went to another account (all but `moved` say why); `idle` means the gap since its last
 * request outlived the cache; `compaction` means the client compacted the conversation.
 */
export type CacheBreakCause = 'reserve' | 'extra-usage' | 'limit' | 'failure' | 'moved' | 'idle' | 'compaction' | 'unknown'

export interface CacheBreak {
  ts: number
  sessionId: string
  provider: string
  model: string
  cause: CacheBreakCause
  /** Credential file names (or auth_index when CPA no longer lists it) before and at the break. */
  from: string
  to: string
  /** Time since the session's previous request. */
  gapMs: number
  /** HTTP status of the failure behind the move. */
  status?: number
  /** Prompt tokens the previous request left in the cache, and how many this one had to send again uncached. */
  expected: number
  resent: number
}

/** Breaks of one cause, and how many conversations they hit. */
export interface CauseCount {
  cause: CacheBreakCause
  breaks: number
  sessions: number
}

export interface CacheBreakDay {
  /** Local midnight (ms) of the viewer's time zone. */
  day: number
  breaks: number
  /** Conversations that lost their cache that day. */
  sessions: number
  resent: number
  causes: CauseCount[]
}

export interface CacheBreakReport {
  from: number
  to: number
  /** Conversations (sessions with two or more requests on the same model) seen in the range. */
  sessions: number
  breaks: number
  brokenSessions: number
  resent: number
  causes: CauseCount[]
  days: CacheBreakDay[]
  /** Newest first. */
  recent: CacheBreak[]
}

export interface DigestAccount {
  name: string
  provider: string
  /** Highest share of the weekly limit in use this week; absent when the account served nothing (no reading this week). */
  peakWeekly?: number
  /** Times a window went down to its reserve. */
  reserveHits: number
  /** Attempts served by this account, like the Usage page's credential stats. */
  requests: number
  failed: number
  tokens: number
  /** USD at public API list prices (api-prices.ts). */
  value: number
}

export interface DigestPool {
  provider: string
  accounts: number
  /** Time every account in the pool was at its reserve or limit, the longest stretch, and how many stretches. */
  dryMs: number
  longestDryMs: number
  dryStretches: number
}

export interface DigestReport {
  from: number
  to: number
  /** When limit history starts, if within the week: the dry-time figures only cover the time since. */
  historyFrom?: number
  pools: DigestPool[]
  accounts: DigestAccount[]
  cacheBreaks: Pick<CacheBreakReport, 'sessions' | 'breaks' | 'brokenSessions' | 'resent' | 'causes'>
  /** Client requests, as Usage counts them: failover that ends in success is one success; turned-away ones count as failed. */
  requests: number
  failed: number
  /** Requests CPA refused before trying any account, how many came while a pool was dry, and why (access-log.ts reasons). */
  turnedAway: { total: number; whileDry: number; byReason: Record<string, number> }
  /** USD at public API list prices, all traffic. */
  value: number
}
