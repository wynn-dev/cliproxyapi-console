import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { paths } from './env.ts'
import { readState, updateState } from './state.ts'
import { db, usageSummary } from './usage.ts'

/** Share card: a summary of a time range and the PNG snapshots the browser renders of it. Mounted behind auth. */
export const share = new Hono()

const SNAPSHOT_DIR = path.join(paths.data, 'share')
const MAX_SNAPSHOT = 2 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** 128 random bits, hex. The only thing that makes a snapshot's public URL hard to guess. */
const SNAPSHOT_FILE = /^[0-9a-f]{32}\.png$/

const HOUR = 3_600_000

/** Client names for the user agents CPA records, by the product before the first "/" or space. */
const CLIENTS: Record<string, string> = {
  'claude-cli': 'Claude Code',
  'claude-code': 'Claude Code',
  codex_cli_rs: 'Codex CLI',
  codex_exec: 'Codex CLI',
  'codex-tui': 'Codex CLI',
  codex_vscode: 'Codex in VS Code',
  opencode: 'OpenCode',
  'factory-cli': 'Factory Droid',
  cursor: 'Cursor',
  'roo-code': 'Roo Code',
  cline: 'Cline',
  'kilo-code': 'Kilo Code',
  pi: 'pi',
}

/** The client's name, or "Other" for user agents the console doesn't know (libraries, browsers). */
export function clientName(userAgent: string) {
  const product = userAgent.trim().split(/[/\s]/)[0]
  if (!product) return ''
  return CLIENTS[product.toLowerCase()] ?? 'Other'
}

/**
 * What the card shows for [from, to): the last 7 days, or a calendar month for the wrapped. tzOffsetMin
 * (Date.getTimezoneOffset) only aligns the hourly series to the viewer's half and quarter hours.
 */
export function shareSummary(from: number, to: number, tzOffsetMin = 0) {
  const s = usageSummary({ from, to }, 0)
  const t = s.totals
  // Straight from the attempts: usageSummary's breakdowns keep the 50 rows with the most requests.
  const models = db
    .prepare("SELECT model, TOTAL(total_tokens) AS tokens FROM requests WHERE ts >= ? AND ts < ? AND model != '' GROUP BY 1 HAVING tokens > 0 ORDER BY 2 DESC LIMIT 5")
    .all(from, to) as { model: string; tokens: number }[]
  // By auth_index, most tokens first. The browser resolves names, or masks them.
  const accounts = db
    .prepare("SELECT auth_index AS key, TOTAL(total_tokens) AS tokens FROM requests WHERE ts >= ? AND ts < ? AND auth_index != '' GROUP BY 1 HAVING tokens > 0 ORDER BY 2 DESC")
    .all(from, to) as { key: string; tokens: number }[]
  // Tokens per hour, hours with traffic only; the browser adds them up by its own calendar days.
  const shift = BigInt((((-tzOffsetMin % 60) + 60) % 60) * 60_000)
  const hours = db
    .prepare('SELECT ((ts + ?) / ?) * ? - ? AS t, TOTAL(total_tokens) AS tokens FROM requests WHERE ts >= ? AND ts < ? GROUP BY 1 ORDER BY 1')
    .all(shift, BigInt(HOUR), BigInt(HOUR), shift, from, to) as { t: number; tokens: number }[]
  const providers = db
    .prepare("SELECT provider AS name, TOTAL(total_tokens) AS tokens FROM requests WHERE ts >= ? AND ts < ? AND provider != '' GROUP BY 1 HAVING tokens > 0 ORDER BY 2 DESC LIMIT 5")
    .all(from, to) as { name: string; tokens: number }[]
  // Conversations: CPA's session ids, one row each. Requests are client requests, not attempts; a
  // Codex websocket session keeps one request_id for all its turns, so its successes count instead.
  const conversations = db
    .prepare(
      `SELECT MAX(COUNT(DISTINCT COALESCE(NULLIF(request_id, ''), '#' || id)), TOTAL(failed = 0)) AS requests, TOTAL(is_compaction) AS compactions,
        TOTAL(total_tokens) AS tokens, MAX(ts) - MIN(ts) AS ms
       FROM requests WHERE ts >= ? AND ts < ? AND session_id != '' GROUP BY session_id`,
    )
    .all(from, to) as { requests: number; compactions: number; tokens: number; ms: number }[]
  const sessions = { count: conversations.length, requests: 0, compactions: 0, longest: null as { requests: number; tokens: number; ms: number } | null }
  for (const c of conversations) {
    sessions.requests += c.requests
    sessions.compactions += c.compactions
    const l = sessions.longest
    if (!l || c.requests > l.requests || (c.requests === l.requests && c.tokens > l.tokens)) sessions.longest = { requests: c.requests, tokens: c.tokens, ms: c.ms }
  }
  const clients = new Map<string, number>()
  const agents = db
    .prepare("SELECT user_agent AS ua, TOTAL(total_tokens) AS tokens FROM requests WHERE ts >= ? AND ts < ? AND user_agent != '' GROUP BY 1")
    .all(from, to) as { ua: string; tokens: number }[]
  for (const a of agents) {
    const name = clientName(a.ua)
    if (name && a.tokens > 0) clients.set(name, (clients.get(name) ?? 0) + a.tokens)
  }
  return {
    from,
    to,
    requests: t.requests,
    tokens: t.total,
    value: t.value,
    unpricedTokens: t.unpricedTokens,
    unpricedModels: t.unpricedModels,
    topModel: models[0] ?? null,
    topModels: models,
    // Cache hit rate = cached input / all input. Input already counts cache reads and writes for
    // every provider (see tokenCounts), so this is cache reads / (uncached + cache reads + cache writes).
    cacheHitRate: t.input ? t.cached / t.input : null,
    accounts,
    hours,
    input: t.input,
    output: t.output,
    cached: t.cached,
    avgTtft: t.avgTtft,
    providers,
    sessions,
    // Most tokens first, "Other" last.
    clients: [...clients]
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => Number(a.name === 'Other') - Number(b.name === 'Other') || b.tokens - a.tokens)
      .slice(0, 5),
    planPrice: readState().planPrice ?? null,
  }
}

/**
 * Calendar months in the viewer's time zone with any usage, newest first, as "2026-09". The fixed
 * offset can put an hour by a DST change in the wrong month; the summary itself uses the browser's dates.
 */
export function shareMonths(tzOffsetMin: number) {
  const { first, last } = db.prepare('SELECT MIN(ts) AS first, MAX(ts) AS last FROM requests').get() as { first: number | null; last: number | null }
  if (first == null || last == null) return []
  const local = (ms: number) => new Date(ms - tzOffsetMin * 60_000)
  const any = db.prepare('SELECT 1 FROM requests WHERE ts >= ? AND ts < ? LIMIT 1')
  const months: string[] = []
  const end = local(last)
  for (let d = local(first), y = d.getUTCFullYear(), m = d.getUTCMonth(); y * 12 + m <= end.getUTCFullYear() * 12 + end.getUTCMonth(); m++) {
    const start = Date.UTC(y, m, 1) + tzOffsetMin * 60_000
    if (any.get(start, Date.UTC(y, m + 1, 1) + tzOffsetMin * 60_000)) months.unshift(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7))
  }
  return months
}

share.get('/summary', (c) => {
  const q = c.req.query()
  const to = q.to ? Number(q.to) : Date.now()
  const from = q.from ? Number(q.from) : to - 7 * 86_400_000
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return c.json({ error: 'from and to must be times in ms, from before to' }, 400)
  if (to - from > 35 * 86_400_000) return c.json({ error: 'At most 35 days at a time' }, 400)
  return c.json(shareSummary(from, to, Number(q.tz) || 0))
})

share.get('/months', (c) => c.json({ months: shareMonths(Number(c.req.query('tz')) || 0) }))

share.get('/plan-price', (c) => c.json({ planPrice: readState().planPrice ?? null }))

share.put('/plan-price', async (c) => {
  const { planPrice } = await c.req.json<{ planPrice?: unknown }>().catch(() => ({ planPrice: undefined }))
  if (planPrice !== null && (typeof planPrice !== 'number' || !Number.isFinite(planPrice) || planPrice <= 0 || planPrice > 100_000)) {
    return c.json({ error: 'Plan price must be a dollar amount above 0, or null to clear it' }, 400)
  }
  updateState({ planPrice: planPrice === null ? undefined : Math.round(planPrice * 100) / 100 })
  return c.json({ planPrice: readState().planPrice ?? null })
})

share.post(
  '/snapshots',
  bodyLimit({ maxSize: MAX_SNAPSHOT, onError: (c) => c.json({ error: 'Snapshots can be at most 2 MB' }, 413) }),
  async (c) => {
    if (c.req.header('content-type')?.split(';')[0].trim() !== 'image/png') return c.json({ error: 'Send the snapshot as image/png' }, 415)
    const png = Buffer.from(await c.req.arrayBuffer())
    if (png.length < PNG_MAGIC.length || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return c.json({ error: 'Not a PNG image' }, 400)
    const file = `${crypto.randomBytes(16).toString('hex')}.png`
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(SNAPSHOT_DIR, file), png, { mode: 0o600 })
    return c.json({ url: `/console/share/${file}` }, 201)
  },
)

/** A stored snapshot, served without auth: anyone with the link can see that image and nothing else. */
export function snapshot(file: string) {
  if (!SNAPSHOT_FILE.test(file)) return
  try {
    return fs.readFileSync(path.join(SNAPSHOT_DIR, file))
  } catch {
    return
  }
}
