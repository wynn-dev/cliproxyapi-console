import { env } from './env.ts'
import { limitWindows, type LimitReading } from './limit-windows.ts'
import { db, onUsageRecords } from './usage.ts'

/**
 * How each account's limits fill up over time, for forecasting when the pool runs out. CPA only
 * keeps the latest reading, so history builds up from the readings the console sees: the
 * rate-limit headers on every usage record, and the per-account readings it polls from CPA.
 *
 * A window gets a row when its reading changes, at most once per five minutes, so a busy account
 * adds about 300 rows a day per window. Only a change of level (warning, exhausted) or a reset is
 * written right away. A change held back waits in memory: it is written once the gap has passed or
 * when the console shuts down, so only a crash loses it. Rows are kept as long as usage records.
 *
 * `window_id` is limitWindows' id (`5h`, `7d`, `7d_oi` for Claude, `:primary`, `<scope>:secondary`
 * for Codex), or `account` for account-wide signals (extra usage, credits) kept as JSON in `status`.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS limit_history (
    name TEXT NOT NULL,
    window_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL,
    used REAL,
    resets_at INTEGER,
    status TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS limit_history_window ON limit_history (name, window_id, ts);
  CREATE INDEX IF NOT EXISTS limit_history_ts ON limit_history (ts);
`)

const MIN_GAP_MS = 5 * 60_000
/** Reset times derived from "resets in N seconds" drift by a second or two between readings. */
const RESET_SLACK_MS = 60_000

/** Headers worth reading: limit windows plus the account-wide signals below. Everything else is ignored. */
const LIMIT_HEADER = /^(anthropic-ratelimit-unified-|x-codex-)/
const ACCOUNT_SIGNAL = /^(anthropic-ratelimit-unified-(status|representative-claim|overage-.+)|x-codex-(credits-.+|limit-reached|allowed|active-limit|plan-type))$/

interface Sample {
  ts: number
  label: string
  used: number | null
  resetsAt: number | null
  status: string
}

const sameReset = (a: Sample, b: Sample) => a.resetsAt === b.resetsAt || Math.abs((a.resetsAt ?? 0) - (b.resetsAt ?? 0)) < RESET_SLACK_MS
const same = (a: Sample, b: Sample) => a.used === b.used && a.status === b.status && sameReset(a, b)
/** Events worth their exact time: a window changing level or starting over. Account signals can creep, so they wait. */
const urgent = (a: Sample, b: Sample) => b.used !== null && (a.status !== b.status || !sameReset(a, b))

function samples(provider: string, reading: LimitReading, at: number) {
  const out = new Map<string, Sample>()
  for (const w of limitWindows(provider, reading, at)) {
    out.set(w.id, { ts: at, label: w.label, used: w.used, resetsAt: w.resetsAt ?? null, status: w.level })
  }
  const account = Object.entries(reading.signals)
    .map(([k, v]) => [k.toLowerCase(), v])
    .filter(([k]) => ACCOUNT_SIGNAL.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
  if (account.length) out.set('account', { ts: at, label: '', used: null, resetsAt: null, status: JSON.stringify(Object.fromEntries(account)) })
  return out
}

const insert = db.prepare('INSERT INTO limit_history (name, window_id, label, ts, used, resets_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
const latest = db.prepare('SELECT label, ts, used, resets_at AS resetsAt, status FROM limit_history WHERE name = ? AND window_id = ? ORDER BY ts DESC LIMIT 1')

interface Track {
  written?: Sample
  writtenAt: number
  pending?: Sample
  /** Newest observation seen, so an older reading arriving late is ignored. */
  seen: number
}
const tracks = new Map<string, Track>()

function write(name: string, id: string, t: Track, s: Sample) {
  insert.run(name, id, s.label, s.ts, s.used, s.resetsAt, s.status)
  Object.assign(t, { written: s, writtenAt: Date.now(), pending: undefined })
}

/** Records one reading of a credential's limits. Exported for other sources of readings. */
export function recordLimitReading(name: string, provider: string, reading: LimitReading) {
  const at = Date.parse(reading.observed_at ?? '')
  if (!at) return
  for (const [id, s] of samples(provider, reading, at)) {
    const key = `${name}\n${id}`
    let t = tracks.get(key)
    if (!t) {
      const last = latest.get(name, id) as Sample | undefined
      t = { written: last, writtenAt: last?.ts ?? 0, seen: last?.ts ?? 0 }
      tracks.set(key, t)
    }
    if (at <= t.seen) continue
    t.seen = at
    if (t.written && same(t.written, s)) t.pending = undefined
    else if (!t.written || urgent(t.written, s) || Date.now() - t.writtenAt >= MIN_GAP_MS) write(name, id, t, s)
    else t.pending = s
  }
}

/** Writes changes held back by the five-minute gap once it has passed, or all of them (on shutdown). */
export function flushLimitHistory(all = false) {
  const now = Date.now()
  for (const [key, t] of tracks) {
    if (t.pending && (all || now - t.writtenAt >= MIN_GAP_MS)) {
      const [name, id] = key.split('\n')
      write(name, id, t, t.pending)
    }
  }
}

let prunedAt = 0
function prune() {
  if (Date.now() - prunedAt < 6 * 3600_000) return
  prunedAt = Date.now()
  db.prepare('DELETE FROM limit_history WHERE ts < ?').run(Date.now() - env.usageRetentionDays * 86_400_000)
}

/** Usage records name their credential by auth_index; history is kept by file name, like the limits table. */
const credentials = new Map<string, { name: string; provider: string }>()

/** Fed from the limits recorder's poll of CPA's credential list. */
export function recordCredentialLimits(files: { name: string; auth_index?: string; provider?: string; quota?: Partial<LimitReading> }[]) {
  credentials.clear()
  try {
    for (const f of files) {
      if (f.auth_index) credentials.set(f.auth_index, { name: f.name, provider: f.provider ?? '' })
      if (f.quota?.signals) recordLimitReading(f.name, f.provider ?? '', { observed_at: f.quota.observed_at, signals: f.quota.signals })
    }
    flushLimitHistory()
    prune()
  } catch (err) {
    // Never in the way of the reserve, which runs after this on the same poll.
    console.error(`Limit history failed: ${err instanceof Error ? err.message : err}`)
  }
}

onUsageRecords((records) => {
  for (const r of records) {
    const cred = credentials.get(r.auth_index ?? '')
    if (!cred || !r.response_headers) continue
    const signals: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.response_headers)) {
      const name = k.toLowerCase()
      if (LIMIT_HEADER.test(name) && v.length) signals[name] = v[v.length - 1]
    }
    if (!Object.keys(signals).length) continue
    // CPA takes its own reading when the response arrives; match it so the two dedupe.
    const at = (Date.parse(r.timestamp) || Date.now()) + Math.round(r.latency_ms ?? 0)
    recordLimitReading(cred.name, cred.provider || r.provider || '', { observed_at: new Date(at).toISOString(), signals })
  }
})

export interface LimitSample {
  name: string
  window: string
  label: string
  ts: number
  used: number | null
  resetsAt: number | null
  status: string
}

/**
 * Samples in [from, to), oldest first, for one credential or all of them. With `previous`, each
 * window's last sample before `from` comes first too: a window that didn't change during the range
 * has no sample in it, and a forecast needs to know where it stood at the start.
 */
export function limitHistory(from: number, to: number, name?: string, { previous = false } = {}): LimitSample[] {
  const byName = name ? ' AND name = ?' : ''
  const cols = (ts: string) => `name, window_id AS window, label, ${ts} AS ts, used, resets_at AS resetsAt, status`
  const rows = db
    .prepare(`SELECT ${cols('ts')} FROM limit_history WHERE ts >= ? AND ts < ?${byName} ORDER BY name, window_id, ts`)
    .all(from, to, ...(name ? [name] : [])) as unknown as LimitSample[]
  if (!previous) return rows
  // SQLite fills the other (bare) columns from the row that holds MAX(ts).
  const before = db
    .prepare(`SELECT ${cols('MAX(ts)')} FROM limit_history WHERE ts < ?${byName} GROUP BY name, window_id`)
    .all(from, ...(name ? [name] : [])) as unknown as LimitSample[]
  const all = [...before, ...rows]
  return all.sort((a, b) => a.name.localeCompare(b.name) || a.window.localeCompare(b.window) || a.ts - b.ts)
}
