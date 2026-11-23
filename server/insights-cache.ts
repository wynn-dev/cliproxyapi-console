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
/** How far before the oldest kept break the detector starts reading, for the requests the first breaks compare with. */
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

/** How far back breaks are kept: the longest report (30 days) and a day for its first local day. */
const KEEP_MS = 31 * DAY

/**
 * Requests added since `id`, oldest first, a chunk at a time. Ids follow the order the drain stored
 * them in, which is the order CPA finished them; each chunk is sorted by time before it is read.
 */
const newRequests = db.prepare(
  `SELECT id, ts, request_id AS requestId, session_id AS sessionId, model, provider, auth_index AS authIndex,
    latency_ms AS latencyMs, input_tokens AS input, cached_tokens AS cached, cache_write_tokens AS cacheWrite,
    is_compaction AS compaction
   FROM requests WHERE id > ? AND session_id != '' AND failed = 0 AND input_tokens > 0 ORDER BY id LIMIT 2000`,
)
const firstIdSince = db.prepare('SELECT MIN(id) AS id FROM requests WHERE ts >= ?')
/** The last failure between two requests of a session: a failed attempt of the later one, or the old account failing. */
const failureBetween = db.prepare(
  `SELECT status_code AS status FROM requests
   WHERE ts > ? AND ts <= ? AND failed = 1 AND (auth_index = ? OR request_id = ?) ORDER BY ts DESC LIMIT 1`,
)

/**
 * The detector's state, built up as requests arrive: the last id read, the previous request of
 * each session and model, the time of each conversation's last request that had one before it to
 * compare with, and the breaks of the last KEEP_MS. Each call only reads the requests added since.
 */
const state = { id: undefined as number | undefined, last: new Map<string, Row>(), compared: new Map<string, number>(), breaks: [] as CacheBreak[], prunedAt: 0 }

/** Limit history around [from, to], for why a session moved: the reserve's windows by account and account-wide signals. */
function limitContext(from: number, to: number) {
  const samples = limitHistory(from, to + 1, undefined, { previous: true })
  const history = byAccount(samples)
  const signals = new Map<string, LimitSample[]>()
  for (const s of samples) if (s.window === 'account') (signals.get(s.name) ?? signals.set(s.name, []).get(s.name)!).push(s)
  return { history, signals, reserve: reserveLimits() }
}

/** Compares a chunk of requests, sorted by time, with the request before each in its session and model. */
function detect(rows: Row[]) {
  let context: ReturnType<typeof limitContext> | undefined

  /** Whether the account was billing paid extra usage at `t`, which the console holds it back for. */
  function billing(name: string, t: number) {
    const s = sampleAt(context!.signals.get(name), t)
    const status = s && (JSON.parse(s.status) as Record<string, string>)['anthropic-ratelimit-unified-overage-status']
    return status === 'allowed' || status === 'allowed_warning'
  }

  /** Why a session left its account between two requests, from what the console saw of that account. */
  function whyMoved(prev: Row, cur: Row): { cause: CacheBreakCause; status?: number } {
    context ??= limitContext(rows[0].ts, rows[rows.length - 1].ts)
    const name = nameOf(prev.authIndex)
    const windows = context.history.get(name) ?? {}
    let atReserve = false
    for (const kind of ['5h', 'weekly'] as const) {
      const s = sampleAt(windows[kind], cur.ts)
      if (!s) continue
      if (leftAt(s, cur.ts) <= 0) return { cause: billing(name, cur.ts) ? 'extra-usage' : 'limit' }
      const reserve = context.reserve[kind]
      if (reserve && leftAt(s, cur.ts) <= reserve / 100 + 1e-9) atReserve = true
    }
    if (atReserve) return { cause: 'reserve' }
    const failed = failureBetween.get(prev.ts, cur.ts, prev.authIndex, cur.requestId ?? '') as { status: number } | undefined
    return failed ? { cause: 'failure', status: failed.status || undefined } : { cause: 'moved' }
  }

  for (const cur of rows) {
    const key = `${cur.sessionId}\0${cur.model}`
    const prev = state.last.get(key)
    // One stored late, after a later request of its session: the later one stays the one to compare with.
    if (prev && cur.ts < prev.ts) continue
    state.last.set(key, cur)
    // Started before the previous one finished: parallel requests don't build on each other's cache.
    if (!prev || cur.ts < prev.ts + prev.latencyMs) continue
    state.compared.set(cur.sessionId, cur.ts)
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
    state.breaks.push({
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
}

/** Reads the requests added since the last call, stopping after the chunk that passes `budgetMs`. Returns whether any are left. */
function advance(now: number, budgetMs = Infinity) {
  const start = performance.now()
  // The first call starts KEEP_MS back, with CONTEXT_MS before it for the requests the first breaks compare with.
  state.id ??= ((firstIdSince.get(now - KEEP_MS - CONTEXT_MS) as { id: number | null }).id ?? Number.MAX_SAFE_INTEGER) - 1
  for (;;) {
    const rows = newRequests.all(state.id) as unknown as Row[]
    if (!rows.length) break
    state.id = rows[rows.length - 1].id
    detect(rows.sort((a, b) => a.ts - b.ts || a.id - b.id))
    if (performance.now() - start > budgetMs) return true
  }
  if (now - state.prunedAt > 3_600_000) {
    state.prunedAt = now
    const cutoff = now - KEEP_MS
    state.breaks = state.breaks.filter((b) => b.ts >= cutoff)
    for (const [key, row] of state.last) if (row.ts < cutoff - CONTEXT_MS) state.last.delete(key)
    for (const [id, ts] of state.compared) if (ts < cutoff) state.compared.delete(id)
  }
  return false
}

let warming: Promise<void> | undefined
/** Reads the history the detector keeps in the background after a start, about 20 ms per turn of the event loop. */
export function startCacheBreaks() {
  warming = new Promise((resolve) => {
    const step = () => {
      try {
        if (advance(Date.now(), 20)) return void setImmediate(step)
      } catch (err) {
        console.error(`Cache-break detector failed: ${err instanceof Error ? err.message : err}`)
      }
      resolve()
    }
    setImmediate(step)
  })
}

/** Settles once the detector has read the history it keeps after a start; HTTP reads await it rather than reading it all at once. */
export const cacheBreaksReady = () => warming ?? Promise.resolve()

/** Every cache break from `from` (at most KEEP_MS back) until now, oldest first, and how many conversations had a request to compare there. */
export function cacheBreaks(from: number, now = Date.now()) {
  advance(now)
  let sessions = 0
  for (const t of state.compared.values()) if (t >= from) sessions++
  return { breaks: state.breaks.filter((b) => b.ts >= from).sort((a, b) => a.ts - b.ts), sessions }
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
