import { credentialByIndex, limitHistory, type LimitSample } from './limit-history.ts'
import { byAccount, leftAt, sampleAt } from './insights-history.ts'
import type { CacheBreak, CacheBreakCause, CacheBreakReport } from './insights-types.ts'
import { reserveLimits } from './reserve.ts'
import { db } from './usage.ts'

/**
 * Cache-break detector. A prompt cache lives on one account, per model, for 5 minutes after its
 * last use (an hour if the client asks for that). A conversation's request normally reads back
 * what the one before it left in the cache; when it reads less than half of that and sends the
 * rest again uncached, the conversation lost its cache. The cause is the most specific of: the
 * client compacted it, it sat idle for over an hour, it moved to another account (and why: the
 * reserve, a limit that ran out, paid extra usage, a failed request), or it sat idle past the
 * 5-minute lifetime.
 *
 * Requests are followed per session and model: a side request on a small model (titles, checks)
 * has its own cache and isn't compared with the main conversation. The first request of a session
 * has nothing to compare with, so it never counts, and neither does a request sent while the
 * previous one was still running.
 *
 * Codex (OpenAI) caching is best effort: a prompt can miss the cache with nothing changed, so
 * "unknown" is common there.
 */

const MINUTE = 60_000
const DAY = 86_400_000
const SHORT_TTL = 5 * MINUTE
const LONG_TTL = 60 * MINUTE
/** Below this the cache is too small to matter (and below some models' minimum cacheable prompt). */
const MIN_CACHED = 4096
/** How far before the range to look for the request a break is compared with. */
const CONTEXT_MS = 6 * 3_600_000

interface Row {
  id: number
  ts: number
  requestId: string | null
  sessionId: string
  model: string
  provider: string
  authIndex: string
  latencyMs: number
  input: number
  cached: number
  cacheWrite: number
  compaction: number
}

const nameOf = (authIndex: string) => credentialByIndex(authIndex)?.name ?? authIndex

const sessionRequests = db.prepare(
  `SELECT id, ts, request_id AS requestId, session_id AS sessionId, model, provider, auth_index AS authIndex,
    latency_ms AS latencyMs, input_tokens AS input, cached_tokens AS cached, cache_write_tokens AS cacheWrite,
    is_compaction AS compaction
   FROM requests WHERE session_id != '' AND failed = 0 AND input_tokens > 0 AND ts >= ? AND ts < ?
   ORDER BY session_id, ts, id`,
)
/** The last failure between two requests of a session: a failed attempt of the later one, or the old account failing. */
const failureBetween = db.prepare(
  `SELECT status_code AS status FROM requests
   WHERE ts > ? AND ts <= ? AND failed = 1 AND (auth_index = ? OR request_id = ?) ORDER BY ts DESC LIMIT 1`,
)

/**
 * Every cache break in [from, to), oldest first, and for each conversation the time of its last
 * request that had one before it to compare with. Rows stream from SQLite; only the previous
 * request of each model in the current session is kept.
 */
function scan(from: number, to: number) {
  const samples = limitHistory(from - CONTEXT_MS, to, undefined, { previous: true })
  const history = byAccount(samples)
  const signals = new Map<string, LimitSample[]>()
  for (const s of samples) if (s.window === 'account') (signals.get(s.name) ?? signals.set(s.name, []).get(s.name)!).push(s)
  const reserve = reserveLimits()

  /** Whether the account was billing paid extra usage at `t`, which the console holds it back for. */
  function billing(name: string, t: number) {
    const s = sampleAt(signals.get(name), t)
    const status = s && (JSON.parse(s.status) as Record<string, string>)['anthropic-ratelimit-unified-overage-status']
    return status === 'allowed' || status === 'allowed_warning'
  }

  /** Why a session left its account between two requests, from what the console saw of that account. */
  function whyMoved(prev: Row, cur: Row): { cause: CacheBreakCause; status?: number } {
    const name = nameOf(prev.authIndex)
    const windows = history.get(name) ?? {}
    let atReserve = false
    for (const kind of ['5h', 'weekly'] as const) {
      const s = sampleAt(windows[kind], cur.ts)
      if (!s) continue
      if (leftAt(s, cur.ts) <= 0) return { cause: billing(name, cur.ts) ? 'extra-usage' : 'limit' }
      if (reserve[kind] && leftAt(s, cur.ts) <= reserve[kind] / 100 + 1e-9) atReserve = true
    }
    if (atReserve) return { cause: 'reserve' }
    const failed = failureBetween.get(prev.ts, cur.ts, prev.authIndex, cur.requestId ?? '') as { status: number } | undefined
    return failed ? { cause: 'failure', status: failed.status || undefined } : { cause: 'moved' }
  }

  const breaks: CacheBreak[] = []
  const compared = new Map<string, number>()
  let session = ''
  const last = new Map<string, Row>()
  for (const row of sessionRequests.iterate(from - CONTEXT_MS, to)) {
    const cur = row as unknown as Row
    if (cur.sessionId !== session) {
      session = cur.sessionId
      last.clear()
    }
    const prev = last.get(cur.model)
    last.set(cur.model, cur)
    // Started before the previous one finished: parallel requests don't build on each other's cache.
    if (!prev || cur.ts < from || cur.ts < prev.ts + prev.latencyMs) continue
    compared.set(cur.sessionId, cur.ts)
    const expected = prev.cached + prev.cacheWrite
    const resent = cur.input - cur.cached
    if (expected < MIN_CACHED || cur.cached >= expected / 2 || resent < expected / 2) continue
    // A new thread sharing the session id starts smaller than the conversation it is compared with;
    // a conversation that lost its cache sends all of it again.
    if (cur.input < expected * 0.9 && cur.cacheWrite < expected / 2) continue
    const gapMs = Math.max(0, cur.ts - (prev.ts + prev.latencyMs))
    let why: { cause: CacheBreakCause; status?: number }
    if (cur.compaction) why = { cause: 'compaction' }
    else if (gapMs > LONG_TTL) why = { cause: 'idle' }
    else if (cur.authIndex !== prev.authIndex) why = whyMoved(prev, cur)
    else if (gapMs > SHORT_TTL) why = { cause: 'idle' }
    else why = { cause: 'unknown' }
    breaks.push({
      ts: cur.ts,
      sessionId: cur.sessionId,
      provider: cur.provider,
      model: cur.model,
      ...why,
      from: nameOf(prev.authIndex),
      to: nameOf(cur.authIndex),
      gapMs,
      expected,
      resent,
    })
  }
  return { breaks: breaks.sort((a, b) => a.ts - b.ts), compared }
}

/**
 * The last scan, reused for a minute by every open tab and the digest. It covers at least eight
 * days, so the 7-day views (local days, or the last 168 hours) share one.
 */
let cached: { at: number; from: number } & ReturnType<typeof scan> | undefined
const CACHE_MS = 60_000

/** Every cache break from `from` until about now, oldest first, and how many conversations had a request to compare there. */
export function cacheBreaks(from: number, now = Date.now()) {
  if (!cached || cached.from > from || now - cached.at > CACHE_MS) {
    const start = Math.min(from, now - 8 * DAY)
    cached = { at: now, from: start, ...scan(start, now) }
  }
  let sessions = 0
  for (const t of cached.compared.values()) if (t >= from) sessions++
  return { breaks: cached.breaks.filter((b) => b.ts >= from), sessions }
}

const ORDER: CacheBreakCause[] = ['reserve', 'extra-usage', 'limit', 'failure', 'moved', 'idle', 'compaction', 'unknown']

/** Breaks and the conversations they hit, per cause, most conversations first. */
function byCause(breaks: CacheBreak[]) {
  const counts = new Map<CacheBreakCause, { breaks: number; ids: Set<string> }>()
  for (const b of breaks) {
    const c = counts.get(b.cause) ?? counts.set(b.cause, { breaks: 0, ids: new Set() }).get(b.cause)!
    c.breaks++
    c.ids.add(b.sessionId)
  }
  return [...counts]
    .map(([cause, c]) => ({ cause, breaks: c.breaks, sessions: c.ids.size }))
    .sort((a, b) => b.sessions - a.sessions || b.breaks - a.breaks || ORDER.indexOf(a.cause) - ORDER.indexOf(b.cause))
}

export function summarizeBreaks(breaks: CacheBreak[]) {
  return {
    breaks: breaks.length,
    brokenSessions: new Set(breaks.map((b) => b.sessionId)).size,
    resent: breaks.reduce((s, b) => s + b.resent, 0),
    causes: byCause(breaks),
  }
}

/** Breaks over the last `days` days, per local day of a viewer `tzOffsetMin` minutes behind UTC (as getTimezoneOffset gives it). */
export function cacheBreakReport(days: number, tzOffsetMin: number, now = Date.now()): CacheBreakReport {
  const shift = -tzOffsetMin * MINUTE
  const dayOf = (t: number) => Math.floor((t + shift) / DAY) * DAY - shift
  const from = dayOf(now) - (days - 1) * DAY
  const { breaks, sessions } = cacheBreaks(from, now)
  const byDay = new Map<number, CacheBreak[]>()
  for (let day = from; day <= now; day += DAY) byDay.set(day, [])
  for (const b of breaks) byDay.get(dayOf(b.ts))?.push(b)
  return {
    from,
    to: now,
    sessions,
    ...summarizeBreaks(breaks),
    days: [...byDay].map(([day, list]) => {
      const { brokenSessions, ...rest } = summarizeBreaks(list)
      return { day, ...rest, sessions: brokenSessions }
    }),
    recent: breaks.slice(-20).reverse(),
  }
}
