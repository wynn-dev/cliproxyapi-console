import fs from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
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
  db.prepare('DELETE FROM requests WHERE ts < ?').run(Date.now() - env.usageRetentionDays * 86_400_000)
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

export interface UsageFilter {
  from: number
  to: number
  model?: string
  provider?: string
  authIndex?: string
  apiKey?: string
  status?: 'ok' | 'failed'
}

function where(f: UsageFilter) {
  const clauses = ['ts >= ?', 'ts < ?']
  const params: SQLInputValue[] = [f.from, f.to]
  const eq = (col: string, v?: string) => {
    if (v !== undefined && v !== '') {
      clauses.push(`${col} = ?`)
      params.push(v)
    }
  }
  eq('model', f.model)
  eq('provider', f.provider)
  eq('auth_index', f.authIndex)
  eq('api_key', f.apiKey)
  if (f.status) clauses.push(f.status === 'failed' ? 'failed = 1' : 'failed = 0')
  return { sql: clauses.join(' AND '), params }
}

const METRICS = `
  COUNT(*) AS requests,
  TOTAL(failed) AS failed,
  TOTAL(input_tokens) AS input,
  TOTAL(output_tokens) AS output,
  TOTAL(reasoning_tokens) AS reasoning,
  TOTAL(cached_tokens) AS cached,
  TOTAL(cache_write_tokens) AS cacheWrite,
  TOTAL(total_tokens) AS total,
  AVG(latency_ms) AS avgLatency,
  AVG(CASE WHEN stream = 1 AND ttft_ms > 0 THEN ttft_ms END) AS avgTtft`

const BUCKETS = [60_000, 300_000, 900_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 86_400_000]

export function usageSummary(f: UsageFilter, tzOffsetMin: number) {
  const w = where(f)
  const bucket = BUCKETS.find((b) => (f.to - f.from) / b <= 120) ?? 86_400_000
  const shift = -tzOffsetMin * 60_000 // align day buckets to the viewer's local midnight
  const totals = db.prepare(`SELECT ${METRICS} FROM requests WHERE ${w.sql}`).get(...w.params)
  const rows = db
    .prepare(
      `SELECT ((ts + ?) / ?) * ? - ? AS t, COUNT(*) AS requests, SUM(failed) AS failed,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached,
        SUM(cache_write_tokens) AS cacheWrite, SUM(total_tokens) AS total, AVG(latency_ms) AS avgLatency
       FROM requests WHERE ${w.sql} GROUP BY t ORDER BY t`,
    )
    // node:sqlite binds JS numbers as REAL; BigInt keeps the bucket math in integer division.
    .all(BigInt(shift), BigInt(bucket), BigInt(bucket), BigInt(shift), ...w.params) as { t: number }[]
  const byT = new Map(rows.map((r) => [r.t, r]))
  const series = []
  const start = Math.floor((f.from + shift) / bucket) * bucket - shift
  for (let t = start; t < f.to; t += bucket) {
    series.push(byT.get(t) ?? { t, requests: 0, failed: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0, avgLatency: null })
  }
  const group = (col: string) =>
    db.prepare(`SELECT ${col} AS key, ${METRICS} FROM requests WHERE ${w.sql} GROUP BY ${col} ORDER BY requests DESC LIMIT 50`).all(...w.params)
  return {
    bucketMs: bucket,
    totals,
    series,
    byModel: group('model'),
    byProvider: group('provider'),
    byCredential: group('auth_index'),
    byApiKey: group('api_key'),
  }
}

export function usageRequests(f: UsageFilter, limit: number, beforeId?: number) {
  const w = where(f)
  if (beforeId) {
    w.sql += ' AND id < ?'
    w.params.push(beforeId)
  }
  return db
    .prepare(
      `SELECT id, ts, request_id AS requestId, model, alias, provider, endpoint, auth_index AS authIndex,
        auth_type AS authType, api_key AS apiKey, failed, status_code AS statusCode, stream, latency_ms AS latencyMs,
        ttft_ms AS ttftMs, input_tokens AS input, output_tokens AS output, reasoning_tokens AS reasoning,
        cached_tokens AS cached, cache_write_tokens AS cacheWrite, total_tokens AS total,
        reasoning_effort AS reasoningEffort, service_tier AS serviceTier, client_ip AS clientIp,
        user_agent AS userAgent, error
       FROM requests WHERE ${w.sql} ORDER BY id DESC LIMIT ?`,
    )
    .all(...w.params, limit)
}

export function usageFacets(from: number, to: number) {
  const distinct = (col: string) =>
    (db.prepare(`SELECT DISTINCT ${col} AS v FROM requests WHERE ts >= ? AND ts < ? AND ${col} != '' ORDER BY v`).all(from, to) as { v: string }[]).map((r) => r.v)
  return { models: distinct('model'), providers: distinct('provider'), credentials: distinct('auth_index'), apiKeys: distinct('api_key') }
}

export function clearUsage() {
  db.exec('DELETE FROM requests')
}
