import { credentialByIndex, limitHistory, type LimitSample } from './limit-history.ts'
import { byAccount, leftAt, sampleAt } from './insights-history.ts'
import type { CacheBreak, CacheBreakCause, CacheBreakDay, CacheBreakReport } from './insights-types.ts'
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
 * has nothing to compare with, so it never counts.
 */

const MINUTE = 60_000
const SHORT_TTL = 5 * MINUTE
const LONG_TTL = 60 * MINUTE
/** Below this the cache is too small to matter (and below some models' minimum cacheable prompt). */
const MIN_CACHED = 4096
/** How far before the range to look for the request a break is compared with. */
const CONTEXT_MS = 6 * 3_600_000

interface Row {
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

interface Failure {
  ts: number
  requestId: string | null
  authIndex: string
  status: number
}

const nameOf = (authIndex: string) => credentialByIndex(authIndex)?.name ?? authIndex

/** Every cache break in [from, to), oldest first, and how many conversations had a request to compare there. */
export function cacheBreaks(from: number, to: number) {
  const rows = db
    .prepare(
      `SELECT ts, request_id AS requestId, session_id AS sessionId, model, provider, auth_index AS authIndex,
        latency_ms AS latencyMs, input_tokens AS input, cached_tokens AS cached, cache_write_tokens AS cacheWrite,
        is_compaction AS compaction
       FROM requests WHERE session_id != '' AND failed = 0 AND input_tokens > 0 AND ts >= ? AND ts < ?
       ORDER BY session_id, model, ts, id`,
    )
    .all(from - CONTEXT_MS, to) as unknown as Row[]
  const failures = db
    .prepare('SELECT ts, request_id AS requestId, auth_index AS authIndex, status_code AS status FROM requests WHERE failed = 1 AND ts >= ? AND ts < ? ORDER BY ts')
    .all(from - CONTEXT_MS, to) as unknown as Failure[]
  const failuresBy = new Map<string, Failure[]>()
  for (const f of failures) {
    for (const key of [`a:${f.authIndex}`, f.requestId ? `r:${f.requestId}` : '']) {
      if (key) (failuresBy.get(key) ?? failuresBy.set(key, []).get(key)!).push(f)
    }
  }
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
    // A failed attempt of this very request, or the old account failing since the session's last request.
    const failed = [
      ...(cur.requestId ? (failuresBy.get(`r:${cur.requestId}`) ?? []) : []),
      ...(failuresBy.get(`a:${prev.authIndex}`) ?? []).filter((f) => f.ts > prev.ts && f.ts <= cur.ts),
    ]
    const last = failed.sort((a, b) => a.ts - b.ts).at(-1)
    return last ? { cause: 'failure', status: last.status || undefined } : { cause: 'moved' }
  }

  const breaks: CacheBreak[] = []
  const sessions = new Set<string>()
  for (let i = 1; i < rows.length; i++) {
    const [prev, cur] = [rows[i - 1], rows[i]]
    if (prev.sessionId !== cur.sessionId || prev.model !== cur.model || cur.ts < from) continue
    sessions.add(cur.sessionId)
    const expected = prev.cached + prev.cacheWrite
    const resent = cur.input - cur.cached
    if (expected < MIN_CACHED || cur.cached >= expected / 2 || resent < expected / 2) continue
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
  return { breaks: breaks.sort((a, b) => a.ts - b.ts), sessions: sessions.size }
}

const ORDER: CacheBreakCause[] = ['reserve', 'extra-usage', 'limit', 'failure', 'moved', 'idle', 'compaction', 'unknown']

export function summarizeBreaks(breaks: CacheBreak[]) {
  const counts = new Map<CacheBreakCause, number>()
  for (const b of breaks) counts.set(b.cause, (counts.get(b.cause) ?? 0) + 1)
  return {
    breaks: breaks.length,
    brokenSessions: new Set(breaks.map((b) => b.sessionId)).size,
    resent: breaks.reduce((s, b) => s + b.resent, 0),
    causes: [...counts].map(([cause, n]) => ({ cause, breaks: n })).sort((a, b) => b.breaks - a.breaks || ORDER.indexOf(a.cause) - ORDER.indexOf(b.cause)),
  }
}

/** Breaks over the last `days` days, per local day of a viewer `tzOffsetMin` minutes behind UTC (as getTimezoneOffset gives it). */
export function cacheBreakReport(days: number, tzOffsetMin: number, now = Date.now()): CacheBreakReport {
  const shift = -tzOffsetMin * MINUTE
  const dayOf = (t: number) => Math.floor((t + shift) / 86_400_000) * 86_400_000 - shift
  const from = dayOf(now) - (days - 1) * 86_400_000
  const { breaks, sessions } = cacheBreaks(from, now)
  const byDay = new Map<number, CacheBreakDay & { ids: Set<string> }>()
  for (let day = from; day <= now; day += 86_400_000) byDay.set(day, { day, breaks: 0, sessions: 0, resent: 0, causes: {}, ids: new Set() })
  for (const b of breaks) {
    const d = byDay.get(dayOf(b.ts))
    if (!d) continue
    d.breaks++
    d.resent += b.resent
    d.ids.add(b.sessionId)
    d.causes[b.cause] = (d.causes[b.cause] ?? 0) + 1
  }
  return {
    from,
    to: now,
    sessions,
    ...summarizeBreaks(breaks),
    days: [...byDay.values()].map(({ ids, ...d }) => ({ ...d, sessions: ids.size })),
    recent: breaks.slice(-20).reverse(),
  }
}
