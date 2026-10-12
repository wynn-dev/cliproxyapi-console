import { readCpaConfig } from './cpa-config.ts'
import { management } from './management.ts'
import { db, onUsageRecords } from './usage.ts'

/**
 * CPA writes no usage record for a request it turns away before any account serves it (every
 * account cooling down or held back, say), so Usage would look healthy while clients fail. Its
 * access log has a line for every API request though: main.log, written while logging-to-file is on,
 * which the console's config sets. This follows that log through the management API, like the Logs
 * page, and keeps the failed requests that have no usage record in `turned_away`.
 *
 * A line has no client key, so it is taken from CPA's error request log for that request when one
 * is still there (CPA keeps the last 10): its Authorization header is masked to the first and last
 * four characters, which picks out one of the configured client keys. Nothing else from it is kept.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS access_log_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS requests_short_id ON requests (substr(request_id, -8));
`)

// [2026-10-12 14:44:56] [25d0a0da] [warn ] [gin_logger.go:106] 429 |           1ms |       127.0.0.1 | POST    "/v1/messages"
// Only API paths get a request id; the rest log "--------".
const ACCESS_LINE = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\] \[([0-9a-f]{8})\] \[\w+ *\] (?:\[gin_logger\.go:\d+\] )?(\d{3}) \| +(\S+) \| +(\S+) \| ([A-Z]+) +"([^"?]*)/
// auth unavailable: 3 of 3 candidate(s) for model "claude-sonnet-4-6" (provider=claude) are in cooldown: [...]
const COOLDOWN_LINE = /^\[[^\]]+\] \[([0-9a-f]{8})\] .*auth unavailable: .* for model "([^"]+)" \(provider=([^)]*)\) are in cooldown/

const UNITS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, µs: 0.001, us: 0.001, ns: 0.000001 }

/** A Go duration as CPA prints it ("4ms", "1.25s", "2m3s"), in ms. */
function durationMs(s: string) {
  let ms = 0
  for (const [, n, unit] of s.matchAll(/([\d.]+)(h|ms|m|s|µs|us|ns)/g)) ms += Number(n) * (UNITS[unit] ?? 0)
  return Math.round(ms)
}

/** Why CPA refused, for the UI to word. Empty when the logs don't say. */
function reasonFor(status: number, cooldown: boolean, message: string) {
  if (status === 401 || status === 403) return 'client_key'
  if (cooldown || /cooling down/i.test(message)) return 'cooldown'
  if (/unknown provider for model|no auth available|auth_(unavailable|not_found)/i.test(message)) return 'no_account'
  return ''
}

/** CPA's util.HideAPIKey. */
function maskKey(k: string) {
  if (k.length > 8) return `${k.slice(0, 4)}...${k.slice(-4)}`
  if (k.length > 4) return `${k.slice(0, 2)}...${k.slice(-2)}`
  if (k.length > 2) return `${k[0]}...${k.slice(-1)}`
  return k
}

const served = db.prepare('SELECT 1 FROM requests WHERE substr(request_id, -8) = ? AND ts > ? LIMIT 1')
const insert = db.prepare(`
  INSERT OR IGNORE INTO turned_away (ts, request_id, status_code, endpoint, latency_ms, client_ip, model, provider, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const enrich = db.prepare(`
  UPDATE turned_away SET api_key = ?, model = CASE WHEN model = '' THEN ? ELSE model END, error = ?,
    reason = CASE WHEN reason = '' THEN ? ELSE reason END
  WHERE id = ?`)
const forget = db.prepare('DELETE FROM turned_away WHERE request_id = ?')

// Attempts that were made after all get a usage record, often a few seconds after the log line.
onUsageRecords((records) => {
  for (const r of records) if (r.request_id) forget.run(r.request_id.slice(-8))
})

/** Cooldown lines come just before the request's access line, maybe in the previous batch. */
const cooldowns = new Map<string, { model: string; provider: string }>()

function ingest(lines: string[]) {
  const added: { id: number; requestId: string; status: number }[] = []
  for (const line of lines) {
    const c = COOLDOWN_LINE.exec(line)
    if (c) {
      cooldowns.set(c[1], { model: c[2], provider: c[3] })
      if (cooldowns.size > 1000) cooldowns.delete(cooldowns.keys().next().value!)
      continue
    }
    const m = ACCESS_LINE.exec(line)
    if (!m) continue
    const [, y, mo, d, h, mi, s, requestId, code, latency, ip, method, path] = m
    const status = Number(code)
    const cooldown = cooldowns.get(requestId)
    cooldowns.delete(requestId)
    if (status < 400) continue
    // CPA logs local time, like the console's clock.
    const ts = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime()
    if (served.get(requestId, ts - 86_400_000)) continue
    const res = insert.run(ts, requestId, status, `${method} ${path}`, durationMs(latency), ip, cooldown?.model ?? '', cooldown?.provider ?? '', reasonFor(status, !!cooldown, ''))
    if (res.changes) added.push({ id: Number(res.lastInsertRowid), requestId, status })
  }
  return added
}

function section(log: string, name: string) {
  const start = log.indexOf(`=== ${name} ===`)
  if (start < 0) return ''
  const rest = log.slice(start + name.length + 8)
  const end = rest.search(/\n=== [A-Z ]+ ===/)
  return end < 0 ? rest : rest.slice(0, end)
}

const jsonAt = (text: string) => {
  try {
    return JSON.parse(text.slice(text.indexOf('{')))
  } catch {
    return undefined
  }
}

/** Client key, model and error message from CPA's request log for this request, when it still has one. */
async function addDetails(row: { id: number; requestId: string; status: number }) {
  const res = await management(`/observability/logs/requests/${row.requestId}`)
  if (!res?.ok || Number(res.headers.get('content-length')) > 8 << 20) return void (await res?.body?.cancel())
  const log = await res.text()
  const masked = [...section(log, 'HEADERS').matchAll(/^(?:authorization|x-api-key|x-goog-api-key|api-key): *(?:bearer +)?(\S+)/gim)].map((m) => m[1])
  const keys = (readCpaConfig()?.clientKeys ?? []).filter((k) => masked.includes(maskKey(k)))
  const body = jsonAt(section(log, 'REQUEST BODY'))
  const model = typeof body?.model === 'string' ? body.model.slice(0, 200) : ''
  const response = jsonAt(section(log, 'API RESPONSE'))
  const err = response?.error
  const message = String((typeof err === 'string' ? err : err?.message) ?? response?.message ?? '').slice(0, 500)
  enrich.run(keys.length === 1 ? keys[0] : '', model, message, reasonFor(row.status, false, message), row.id)
}

const BATCH = 2000

export const accessLog = { lastError: undefined as string | undefined }

async function poll() {
  const saved = (db.prepare('SELECT cursor FROM access_log_cursor').get() as { cursor: string } | undefined)?.cursor
  let cursor = saved
  const added: ReturnType<typeof ingest> = []
  // Without a cursor (first run) this reads the newest lines, which is all that's worth backfilling.
  for (let i = 0; i < 50; i++) {
    const res = await management(`/observability/logs?limit=${BATCH}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!res) return
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(error === 'logging to file disabled' ? 'Turn on "Log to file" in Settings to see turned-away requests.' : `CLIProxyAPI's log returned ${error ?? `HTTP ${res.status}`}`)
    }
    const page = (await res.json()) as { lines?: string[]; 'next-cursor'?: string }
    added.push(...ingest(page.lines ?? []))
    const next = page['next-cursor']
    if (next && next !== cursor) db.prepare('INSERT OR REPLACE INTO access_log_cursor (id, cursor) VALUES (1, ?)').run(next)
    if (!cursor || !next || (page.lines?.length ?? 0) < BATCH) break
    cursor = next
  }
  // CPA keeps 10 error logs, so only the newest are worth a look.
  for (const row of added.slice(-10)) await addDetails(row).catch(() => {})
}

export function startAccessLog() {
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      await poll()
      accessLog.lastError = undefined
    } catch (err) {
      accessLog.lastError = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }, 5000)
}
