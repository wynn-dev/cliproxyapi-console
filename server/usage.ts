import fs from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { LONG_CONTEXT_STEPS, apiValue } from './api-prices.ts'
import { keyMatchesConfig } from './auth.ts'
import { env, paths } from './env.ts'
import { readState } from './state.ts'
import { supervisor } from './supervisor.ts'

/**
 * CPA only keeps per-request usage records in a short-lived, destructive queue. The console is
 * its single consumer: it drains the queue every few seconds and persists records in SQLite.
 */

fs.mkdirSync(paths.data, { recursive: true, mode: 0o700 })
fs.chmodSync(paths.data, 0o700) // holds secrets: auth files, keys, usage with client keys
export const db = new DatabaseSync(paths.usageDb)
fs.chmodSync(paths.usageDb, 0o600)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA temp_store = MEMORY;
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    request_id TEXT,
    model TEXT NOT NULL DEFAULT '',
    alias TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    failed INTEGER NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 0,
    stream INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_effort TEXT NOT NULL DEFAULT '',
    service_tier TEXT NOT NULL DEFAULT '',
    client_ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
`)

/**
 * Columns added after the first release. ADD COLUMN only, so a database from any earlier version
 * opens as is. They feed later insights: attempts of one request (execution_id), conversations and
 * their prompt cache (session ids, forks, compactions), and API-price value (served model and tier).
 */
const ADDED_COLUMNS: Record<string, string> = {
  execution_id: "TEXT NOT NULL DEFAULT ''",
  session_id: "TEXT NOT NULL DEFAULT ''",
  parent_session_id: "TEXT NOT NULL DEFAULT ''",
  is_fork: 'INTEGER NOT NULL DEFAULT 0',
  is_compaction: 'INTEGER NOT NULL DEFAULT 0',
  response_model: "TEXT NOT NULL DEFAULT ''",
  response_service_tier: "TEXT NOT NULL DEFAULT ''",
}
const columns = new Set((db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name))
for (const [col, type] of Object.entries(ADDED_COLUMNS)) if (!columns.has(col)) db.exec(`ALTER TABLE requests ADD COLUMN ${col} ${type}`)
db.exec("CREATE INDEX IF NOT EXISTS requests_session ON requests (session_id, ts) WHERE session_id != ''")
db.exec('CREATE INDEX IF NOT EXISTS requests_request_id ON requests (request_id)')

/**
 * Client requests CPA turned away before any account served them: every account cooling down or
 * held back, a model no available account serves, a client key it does not accept. CPA writes no
 * usage record for those, only an access log line, which access-log.ts reads. request_id is the
 * log's short id, the last 8 characters of the request_id usage records carry.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS turned_away (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    endpoint TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    client_ip TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    UNIQUE (request_id, ts)
  );
  CREATE INDEX IF NOT EXISTS turned_away_ts ON turned_away (ts);
`)

/*
 * Version 1 gives token counts one meaning across providers (see tokenCounts). Rows stored before
 * it kept CPA's raw fields, and only Claude's differ: Anthropic reports cache reads and writes
 * apart from input_tokens, while OpenAI-style providers (Codex) count them inside it. So Claude rows
 * get their cache tokens added to input. Their total already included them (CPA adds them up), but
 * MAX keeps it at least input + output either way.
 *
 * Before that, a Claude row with no cache read stored its cache write as the read: CPA sets
 * cached_tokens to the write count then, and the old code fell back to it. CPA's total counts each
 * once, so total = input + output + write singles those rows out; a real read of the same size
 * would have made the total larger.
 *
 * Gemini-family APIs report reasoning apart from output, unlike the rest, so it is added to output
 * where the total shows it was left out.
 */
if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 1) {
  db.exec(`
    BEGIN;
    UPDATE requests SET cached_tokens = 0
      WHERE provider = 'claude' AND cached_tokens > 0 AND cached_tokens = cache_write_tokens
        AND total_tokens = input_tokens + output_tokens + cache_write_tokens;
    UPDATE requests SET input_tokens = input_tokens + cached_tokens + cache_write_tokens,
        total_tokens = MAX(total_tokens, input_tokens + cached_tokens + cache_write_tokens + output_tokens)
      WHERE provider = 'claude' AND (cached_tokens > 0 OR cache_write_tokens > 0);
    UPDATE requests SET output_tokens = output_tokens + reasoning_tokens
      WHERE reasoning_tokens > 0 AND total_tokens = input_tokens + output_tokens + reasoning_tokens
        AND (provider LIKE '%gemini%' OR provider IN ('aistudio', 'antigravity', 'vertex'));
    PRAGMA user_version = 1;
    COMMIT;
  `)
  // One transaction over every row grows the WAL to about the size of the database; give it back.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

/** CPA's canonical token accounting (sdk/cliproxy/usage/accounting.go): buckets that never overlap. */
interface TokenBreakdown {
  schema_version?: number
  quality?: string
  total_tokens?: number
  input?: Partial<Record<'total_tokens' | 'uncached_tokens' | 'cache_read_tokens' | 'cache_write_tokens', number>>
  output?: Partial<Record<'total_tokens' | 'non_reasoning_tokens' | 'reasoning_tokens', number>>
  unclassified_tokens?: number
}

export interface QueueRecord {
  timestamp: string
  latency_ms?: number
  ttft_ms?: number
  auth_index?: string
  client_ip?: string
  resolved_client_ip?: string
  user_agent?: string
  tokens?: Partial<Record<'input_tokens' | 'output_tokens' | 'reasoning_tokens' | 'cache_read_tokens' | 'cached_tokens' | 'cache_creation_tokens' | 'total_tokens', number>>
  token_breakdown?: TokenBreakdown
  failed?: boolean
  stream?: boolean
  fail?: { status_code?: number; body?: string }
  provider?: string
  executor_type?: string
  model?: string
  alias?: string
  endpoint?: string
  auth_type?: string
  api_key?: string
  /** The client's request. Each upstream attempt of it (a retry, another account) has its own execution_id. */
  request_id?: string
  execution_id?: string
  session_id?: string
  parent_session_id?: string
  is_fork?: boolean
  is_compaction?: boolean
  reasoning_effort?: string
  service_tier?: string
  response_service_tier?: string
  response_model?: string
  /** The upstream response headers of this attempt, canonical names. Only read, never stored. */
  response_headers?: Record<string, string[]>
}

const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : NaN)

/** The breakdown's counts when it holds CPA's own invariants (as TokenBreakdown.Valid checks them) and splits input from output. */
function breakdownCounts(b: TokenBreakdown | undefined) {
  // "inconsistent" means CPA could not split the upstream's numbers at all.
  if (b?.schema_version !== 2 || (b.quality !== 'complete' && b.quality !== 'unclassified')) return
  const [input, uncached, cached, cacheWrite] = [b.input?.total_tokens, b.input?.uncached_tokens, b.input?.cache_read_tokens, b.input?.cache_write_tokens].map(count)
  const [output, nonReasoning, reasoning] = [b.output?.total_tokens, b.output?.non_reasoning_tokens, b.output?.reasoning_tokens].map(count)
  const [total, unclassified] = [b.total_tokens, b.unclassified_tokens].map(count)
  if (input !== uncached + cached + cacheWrite || output !== nonReasoning + reasoning || total !== input + output + unclassified) return
  // An "unclassified" breakdown with empty buckets only knows the total; the plain fields may know more.
  if (b.quality === 'complete' ? unclassified !== 0 : input + output === 0) return
  return { input, cached, cacheWrite, output, reasoning, total }
}

/**
 * How a provider's plain token fields overlap, as CPA's tokenAccountingSemanticsFor decides it:
 * Anthropic's API counts cache tokens apart from input, Gemini's counts reasoning apart from output.
 */
function semantics(provider = '', executor = '') {
  const v = `${provider} ${executor}`.toLowerCase()
  if (/^openai-compat/.test(provider.toLowerCase()) || executor.toLowerCase() === 'openaicompatexecutor') return 'subset'
  if (/claude|anthropic/.test(v)) return 'cache-apart'
  if (/gemini|aistudio|antigravity|vertex|interaction/.test(v)) return 'reasoning-apart'
  return 'subset'
}

/**
 * Token counts with one meaning for every provider: input is every prompt token, cache reads and
 * writes included; cached is the cache-read part of it; output includes reasoning; total is input +
 * output (plus any tokens CPA could not classify). CPA's plain token fields follow each upstream's
 * own convention, so its breakdown wins when it is usable.
 */
export function tokenCounts(r: Pick<QueueRecord, 'tokens' | 'token_breakdown' | 'provider' | 'executor_type'>) {
  const b = breakdownCounts(r.token_breakdown)
  if (b) return b
  const t = r.tokens ?? {}
  // Not cached_tokens first: for Claude, CPA sets it to the cache write when nothing was read.
  const cached = t.cache_read_tokens ?? t.cached_tokens ?? 0
  const cacheWrite = t.cache_creation_tokens ?? 0
  const reasoning = t.reasoning_tokens ?? 0
  const kind = semantics(r.provider, r.executor_type)
  const input = (t.input_tokens ?? 0) + (kind === 'cache-apart' ? cached + cacheWrite : 0)
  const output = (t.output_tokens ?? 0) + (kind === 'reasoning-apart' ? reasoning : 0)
  return { input, cached, cacheWrite, output, reasoning, total: t.total_tokens || input + output }
}

const insert = db.prepare(`
  INSERT INTO requests (ts, request_id, model, alias, provider, endpoint, auth_index, auth_type, api_key, failed,
    status_code, stream, latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
    cache_write_tokens, total_tokens, reasoning_effort, service_tier, client_ip, user_agent, error, execution_id,
    session_id, parent_session_id, is_fork, is_compaction, response_model, response_service_tier)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

const listeners: ((records: QueueRecord[]) => void)[] = []
/** Called with each batch of records once stored, e.g. to read the rate-limit headers they carry. */
export function onUsageRecords(fn: (records: QueueRecord[]) => void) {
  listeners.push(fn)
}

function store(records: QueueRecord[]) {
  db.exec('BEGIN')
  try {
    for (const r of records) {
      const t = tokenCounts(r)
      insert.run(
        Date.parse(r.timestamp) || Date.now(),
        r.request_id ?? null,
        r.model ?? '',
        r.alias ?? '',
        r.provider ?? '',
        r.endpoint ?? '',
        r.auth_index ?? '',
        r.auth_type ?? '',
        r.api_key ?? '',
        r.failed ? 1 : 0,
        r.fail?.status_code ?? 0,
        r.stream ? 1 : 0,
        Math.round(r.latency_ms ?? 0),
        Math.round(r.ttft_ms ?? 0),
        t.input,
        t.output,
        t.reasoning,
        t.cached,
        t.cacheWrite,
        t.total,
        r.reasoning_effort ?? '',
        r.service_tier ?? '',
        r.resolved_client_ip || r.client_ip || '',
        r.user_agent ?? '',
        r.failed ? (r.fail?.body ?? '').slice(0, 8192) : '',
        r.execution_id ?? '',
        r.session_id ?? '',
        r.parent_session_id ?? '',
        r.is_fork ? 1 : 0,
        r.is_compaction ? 1 : 0,
        r.response_model ?? '',
        r.response_service_tier ?? '',
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  for (const fn of listeners) {
    try {
      fn(records)
    } catch (err) {
      console.error(`Usage listener failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

export const collector = { lastPollAt: 0, lastError: undefined as string | undefined }

async function drain() {
  const key = readState().managementKey
  if (supervisor.state !== 'running' || !supervisor.port) return
  // Never send a stale key: CPA bans 127.0.0.1 (i.e. the console) after five failures.
  if (!keyMatchesConfig(key)) {
    collector.lastError = 'The management key changed. Sign in to the console again to resume usage collection.'
    return
  }
  const batch = 500
  try {
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`http://127.0.0.1:${supervisor.port}/v8/management/observability/usage/queue?count=${batch}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`usage queue returned HTTP ${res.status}`)
      const records = ((await res.json()) ?? []) as QueueRecord[]
      if (records.length) store(records)
      if (records.length < batch) break
    }
    collector.lastPollAt = Date.now()
    collector.lastError = undefined
  } catch (err) {
    collector.lastError = err instanceof Error ? err.message : String(err)
  }
}

function prune() {
  const cutoff = Date.now() - env.usageRetentionDays * 86_400_000
  db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff)
  db.prepare('DELETE FROM turned_away WHERE ts < ?').run(cutoff)
}

export function startCollector() {
  prune()
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    await drain().finally(() => (busy = false))
  }, 5000)
  setInterval(prune, 6 * 3600_000)
}

// ---------------------------------------------------------------------------------------------
// Queries
//
// Each upstream attempt of a client request (a retry, failover to another account) is its own record,
// and they share the request's request_id. Request counts and success rates count client requests: one
// failed only if every attempt did, so failover that ends well is a success. Per credential stats count
// attempts instead, so an account still shows the attempt that failed on it. Tokens, value and latency
// are summed or averaged over attempts. Turned-away requests are failed client requests with no tokens
// and no credential.

export interface UsageFilter {
  from: number
  to: number
  model?: string
  provider?: string
  authIndex?: string
  apiKey?: string
  status?: 'ok' | 'failed' | 'turned_away'
}

/** The client request an attempt belongs to (see TURN_KEY for ids with several successes). */
const REQUEST_KEY = "COALESCE(NULLIF(request_id, ''), '#' || id)"
/**
 * A Codex websocket session keeps one request_id for all its turns, so there a success ends a
 * request and the next attempt with that id starts a new one. Sorting every attempt for this costs
 * as much as the rest of the summary, so it is only done for ids with more than one success.
 */
const TURN_KEY = `request_id || ':' || TOTAL(failed = 0) OVER (PARTITION BY request_id ORDER BY ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`
/** Whether an attempt's client request succeeded in the end: with this attempt or the next success with its id. */
const REQUEST_OK = `(failed = 0 OR (request_id != '' AND EXISTS (SELECT 1 FROM requests o WHERE o.request_id = requests.request_id
  AND o.failed = 0 AND (o.ts > requests.ts OR (o.ts = requests.ts AND o.id > requests.id)))))`

function filterSql(f: UsageFilter, extra: (string | false)[]) {
  const clauses = ['ts >= ?', 'ts < ?']
  const params: SQLInputValue[] = [f.from, f.to]
  for (const [col, v] of [['model', f.model], ['provider', f.provider], ['api_key', f.apiKey]] as const) {
    if (v) {
      clauses.push(`${col} = ?`)
      params.push(v)
    }
  }
  for (const c of extra) if (c) clauses.push(c)
  return { sql: clauses.join(' AND '), params }
}

function where(f: UsageFilter) {
  const w = filterSql(f, [f.status === 'ok' && REQUEST_OK, f.status === 'failed' && `NOT ${REQUEST_OK}`, f.status === 'turned_away' && '0'])
  if (f.authIndex) {
    w.sql += ' AND auth_index = ?'
    w.params.push(f.authIndex)
  }
  return w
}

/**
 * Reading most of the table through the ts index is many times slower than scanning all of it, so
 * wide ranges scan. Counting the rows in range only reads the index, which is cheap.
 */
function source(from: number, to: number) {
  const { rows, inRange } = db
    .prepare('SELECT (SELECT COUNT(*) FROM requests) AS rows, (SELECT COUNT(*) FROM requests WHERE ts >= ? AND ts < ?) AS inRange')
    .get(from, to) as { rows: number; inRange: number }
  return inRange * 10 > rows ? 'requests NOT INDEXED' : 'requests'
}

/** The same filter for turned-away requests, which never reached a credential or succeeded. */
const whereTurnedAway = (f: UsageFilter) => filterSql(f, [(!!f.authIndex || f.status === 'ok') && '0'])

// API-price value of an attempt, or NULL without a price, for SQL: node:sqlite calls back into JS per row.
db.function('api_value', { deterministic: true }, (model, tier, uncached, cacheRead, cacheWrite, output, input) => {
  const band = LONG_CONTEXT_STEPS.filter((n) => Number(input) > n).length
  const tokens = { uncached: Number(uncached), cacheRead: Number(cacheRead), cacheWrite: Number(cacheWrite), output: Number(output) }
  return apiValue(String(model), String(tier), tokens, band) ?? null
})
const PRICE_MODEL = "COALESCE(NULLIF(response_model, ''), model)"
const PRICE_TIER = "COALESCE(NULLIF(response_service_tier, ''), service_tier)"
const VALUE = `api_value(${PRICE_MODEL}, ${PRICE_TIER},
  MAX(input_tokens - cached_tokens - cache_write_tokens, 0), cached_tokens, cache_write_tokens, output_tokens, input_tokens)`
/**
 * Attempts in the filter with their value as `v`. LIMIT keeps SQLite from inlining the subquery,
 * which would call api_value once for each use of `v`.
 */
const valued = (src: string, w: { sql: string }, extra = '') => `(SELECT *, ${VALUE} AS v${extra} FROM ${src} WHERE ${w.sql} LIMIT -1)`

/** Sums over attempts, for one client request or one credential. */
const ATTEMPT_SUMS = `
  COUNT(*) AS attempts, TOTAL(failed) AS failedAttempts,
  TOTAL(input_tokens) AS input, TOTAL(output_tokens) AS output, TOTAL(reasoning_tokens) AS reasoning,
  TOTAL(cached_tokens) AS cached, TOTAL(cache_write_tokens) AS cacheWrite, TOTAL(total_tokens) AS total,
  TOTAL(latency_ms) AS latency, TOTAL(CASE WHEN stream = 1 AND ttft_ms > 0 THEN ttft_ms END) AS ttft,
  TOTAL(stream = 1 AND ttft_ms > 0) AS ttftCount, TOTAL(v) AS value, TOTAL(CASE WHEN v IS NULL THEN input_tokens + output_tokens END) AS unpricedTokens`

/**
 * Metrics from rows of ATTEMPT_SUMS. With one row per client request, a request failed when all its
 * attempts did; with one row per attempt (credentials) that is just the attempt failing.
 */
const METRICS = `
  COUNT(*) AS requests,
  TOTAL(failedAttempts = attempts) AS failed,
  TOTAL(failedAttempts > 0 AND failedAttempts < attempts) AS recovered,
  TOTAL(attempts) AS attempts,
  TOTAL(failedAttempts) AS failedAttempts,
  TOTAL(input) AS input,
  TOTAL(output) AS output,
  TOTAL(reasoning) AS reasoning,
  TOTAL(cached) AS cached,
  TOTAL(cacheWrite) AS cacheWrite,
  TOTAL(total) AS total,
  TOTAL(latency) / TOTAL(attempts) AS avgLatency,
  TOTAL(ttft) / TOTAL(ttftCount) AS avgTtft,
  TOTAL(value) AS value,
  TOTAL(unpricedTokens) AS unpricedTokens`

interface Metrics {
  requests: number
  failed: number
  [k: string]: unknown
}

const BUCKETS = [60_000, 300_000, 900_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 86_400_000]

export function usageSummary(f: UsageFilter, tzOffsetMin: number) {
  const w = where(f)
  const ta = whereTurnedAway(f)
  const src = source(f.from, f.to)
  const bucket = BUCKETS.find((b) => (f.to - f.from) / b <= 120) ?? 86_400_000
  const shift = -tzOffsetMin * 60_000 // align day buckets to the viewer's local midnight
  const turnedAway = (col: string) =>
    new Map(
      (db.prepare(`SELECT ${col} AS key, COUNT(*) AS n FROM turned_away WHERE ${ta.sql} GROUP BY 1`).all(...ta.params) as { key: string | number; n: number }[]).map(
        (r) => [r.key, r.n],
      ),
    )
  const withTurnedAway = (m: Metrics, n = 0) => ({ ...m, requests: m.requests + n, failed: m.failed + n, turnedAway: n })

  // One row per client request, built once. Bare columns come from its first attempt (SQLite takes
  // them from the MIN(ts) row), so a request belongs to the model, provider and key it started with.
  const requestRow = `MIN(ts) AS ts, model, provider, api_key, request_id AS rid, TOTAL(failed = 0) AS successes, ${ATTEMPT_SUMS}`
  db.exec('DROP TABLE IF EXISTS temp.client_requests')
  db.prepare(`CREATE TEMP TABLE client_requests AS SELECT ${requestRow} FROM ${valued(src, w)} GROUP BY ${REQUEST_KEY}`).run(...w.params)
  const multi = (db.prepare('SELECT rid FROM client_requests WHERE successes > 1').all() as { rid: string }[]).map((r) => r.rid)
  if (multi.length) {
    db.exec('DELETE FROM client_requests WHERE successes > 1')
    db.prepare(
      `INSERT INTO client_requests SELECT ${requestRow}
       FROM ${valued(src, { sql: `${w.sql} AND request_id IN (SELECT value FROM json_each(?))` }, `, ${TURN_KEY} AS rk`)} GROUP BY rk`,
    ).run(...w.params, JSON.stringify(multi))
  }
  try {
    const totals = {
      ...withTurnedAway(db.prepare(`SELECT ${METRICS} FROM client_requests`).get() as Metrics, turnedAway("''").get('')),
      unpricedModels: (db.prepare('SELECT DISTINCT model FROM client_requests WHERE unpricedTokens > 0 ORDER BY 1').all() as { model: string }[]).map((r) => r.model),
    }

    const rows = db
      .prepare(
        `SELECT ((ts + ?) / ?) * ? - ? AS t, COUNT(*) AS requests, TOTAL(failedAttempts = attempts) AS failed, TOTAL(input) AS input,
          TOTAL(output) AS output, TOTAL(cached) AS cached, TOTAL(cacheWrite) AS cacheWrite, TOTAL(total) AS total,
          TOTAL(latency) / TOTAL(attempts) AS avgLatency
         FROM client_requests GROUP BY t ORDER BY t`,
      )
      // node:sqlite binds JS numbers as REAL; BigInt keeps the bucket math in integer division.
      .all(BigInt(shift), BigInt(bucket), BigInt(bucket), BigInt(shift)) as { t: number; requests: number; failed: number }[]
    const byT = new Map(rows.map((r) => [r.t, r]))
    const awayByT = turnedAway(`((ts + ${shift}) / ${bucket}) * ${bucket} - ${shift}`)
    const series = []
    const start = Math.floor((f.from + shift) / bucket) * bucket - shift
    for (let t = start; t < f.to; t += bucket) {
      const p = byT.get(t) ?? { t, requests: 0, failed: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0, avgLatency: null }
      series.push(withTurnedAway(p, awayByT.get(t)))
    }

    const group = (col: string) => {
      const metrics = db.prepare(`SELECT ${col} AS key, ${METRICS} FROM client_requests GROUP BY 1 ORDER BY requests DESC LIMIT 50`).all() as (Metrics & { key: string })[]
      const away = turnedAway(col)
      const out = metrics.map((m) => withTurnedAway(m, away.get(m.key)))
      for (const [key, n] of away) if (!metrics.some((m) => m.key === key)) out.push(withTurnedAway({ key: String(key), ...EMPTY }, n))
      return out.sort((a, b) => b.requests - a.requests)
    }
    // Attempts, so an account shows the attempts that failed on it. Turned-away requests never reached one.
    const byCredential = db
      .prepare(
        `SELECT auth_index AS key, COUNT(*) AS requests, TOTAL(failed) AS failed, 0 AS recovered, COUNT(*) AS attempts,
          TOTAL(failed) AS failedAttempts, TOTAL(input_tokens) AS input, TOTAL(output_tokens) AS output,
          TOTAL(reasoning_tokens) AS reasoning, TOTAL(cached_tokens) AS cached, TOTAL(cache_write_tokens) AS cacheWrite,
          TOTAL(total_tokens) AS total, AVG(latency_ms) AS avgLatency, AVG(CASE WHEN stream = 1 AND ttft_ms > 0 THEN ttft_ms END) AS avgTtft,
          TOTAL(v) AS value, TOTAL(CASE WHEN v IS NULL THEN input_tokens + output_tokens END) AS unpricedTokens
         FROM ${valued(src, w)} GROUP BY 1 ORDER BY requests DESC LIMIT 50`,
      )
      .all(...w.params)
      .map((m) => withTurnedAway(m as Metrics))
    return { bucketMs: bucket, totals, series, byModel: group('model'), byProvider: group('provider'), byCredential, byApiKey: group('api_key') }
  } finally {
    db.exec('DROP TABLE temp.client_requests')
  }
}

const EMPTY = {
  requests: 0, failed: 0, recovered: 0, attempts: 0, failedAttempts: 0, input: 0, output: 0, reasoning: 0,
  cached: 0, cacheWrite: 0, total: 0, avgLatency: null, avgTtft: null, value: 0, unpricedTokens: 0,
}

/** Newest first. Attempts and turned-away requests (negative ids) share one list, paged by (ts, id). */
export function usageRequests(f: UsageFilter, limit: number, before?: { ts: number; id: number }) {
  const w = where(f)
  const ta = whereTurnedAway(f)
  if (before) {
    w.sql += ' AND (ts < ? OR (ts = ? AND id < ?))'
    w.params.push(before.ts, before.ts, before.id)
    ta.sql += ' AND (ts < ? OR (ts = ? AND -id < ?))'
    ta.params.push(before.ts, before.ts, before.id)
  }
  const rows = db
    .prepare(
      `SELECT id, ts, request_id AS requestId, model, alias, provider, endpoint, auth_index AS authIndex,
        auth_type AS authType, api_key AS apiKey, failed, status_code AS statusCode, stream, latency_ms AS latencyMs,
        ttft_ms AS ttftMs, input_tokens AS input, output_tokens AS output, reasoning_tokens AS reasoning,
        cached_tokens AS cached, cache_write_tokens AS cacheWrite, total_tokens AS total,
        reasoning_effort AS reasoningEffort, service_tier AS serviceTier, client_ip AS clientIp,
        user_agent AS userAgent, error, ${REQUEST_OK} AS requestOk, 0 AS turnedAway, '' AS reason,
        response_model AS responseModel, response_service_tier AS responseServiceTier
       FROM requests WHERE ${w.sql}
       UNION ALL
       SELECT -id, ts, request_id, model, '', provider, endpoint, '', '', api_key, 1, status_code, 0, latency_ms,
        0, 0, 0, 0, 0, 0, 0, '', '', client_ip, '', error, 0, 1, reason, '', ''
       FROM turned_away WHERE ${ta.sql}
       ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...w.params, ...ta.params, limit) as unknown as ({
      model: string
      responseModel: string
      serviceTier: string
      responseServiceTier: string
      input: number
      cached: number
      cacheWrite: number
      output: number
      turnedAway: number
    } & Record<string, unknown>)[]
  return rows.map((r) => {
    const model = r.responseModel || r.model
    const band = LONG_CONTEXT_STEPS.filter((n) => r.input > n).length
    const tokens = { uncached: Math.max(0, r.input - r.cached - r.cacheWrite), cacheRead: r.cached, cacheWrite: r.cacheWrite, output: r.output }
    return { ...r, value: r.turnedAway ? null : (apiValue(model, r.responseServiceTier || r.serviceTier, tokens, band) ?? null) }
  })
}

export function usageFacets(from: number, to: number) {
  const src = source(from, to)
  const distinct = (col: string, turnedAway = true) =>
    (
      db
        .prepare(
          `SELECT DISTINCT ${col} AS v FROM ${src} WHERE ts >= ? AND ts < ? AND ${col} != ''` +
            (turnedAway ? ` UNION SELECT ${col} FROM turned_away WHERE ts >= ? AND ts < ? AND ${col} != ''` : '') +
            ' ORDER BY v',
        )
        .all(from, to, ...(turnedAway ? [from, to] : [])) as { v: string }[]
    ).map((r) => r.v)
  return { models: distinct('model'), providers: distinct('provider'), credentials: distinct('auth_index', false), apiKeys: distinct('api_key') }
}

export function clearUsage() {
  db.exec('DELETE FROM requests; DELETE FROM turned_away')
}
