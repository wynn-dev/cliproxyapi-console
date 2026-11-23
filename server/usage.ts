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
db.exec('CREATE INDEX IF NOT EXISTS requests_auth ON requests (auth_index, ts)')

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
  scheduleRollUp()
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

/** Rows older than this are pruned; undefined keeps history forever (USAGE_RETENTION_DAYS unset or 0). */
export const retentionCutoff = () => (env.usageRetentionDays > 0 ? Date.now() - env.usageRetentionDays * 86_400_000 : undefined)

export function pruneUsage() {
  const cutoff = retentionCutoff()
  if (cutoff === undefined) return
  db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff)
  db.prepare('DELETE FROM turned_away WHERE ts < ?').run(cutoff)
  scheduleRollUp()
}

export function startCollector() {
  pruneUsage()
  scheduleRollUp()
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    await drain().finally(() => (busy = false))
  }, 5000)
  setInterval(pruneUsage, 6 * 3600_000)
}

// ---------------------------------------------------------------------------------------------
// Queries
//
// Each upstream attempt of a client request (a retry, failover to another account) is its own record,
// and they share the request's request_id. Request counts and success rates count client requests: one
// failed only if every attempt did, so failover that ends well is a success. Per credential stats count
// attempts instead, so an account still shows the attempt that failed on it. Tokens, value and latency
// are summed over attempts, each under its own model and account; a client request counts under its
// first attempt's. Turned-away requests are failed client requests with no tokens and no credential.

export interface UsageFilter {
  from: number
  to: number
  model?: string
  provider?: string
  authIndex?: string
  apiKey?: string
  status?: 'ok' | 'failed' | 'turned_away'
}

/**
 * Whether an attempt starts a client request: no attempt with its request_id came before it, or the
 * one just before succeeded. A Codex websocket session keeps one request_id for all its turns, so
 * there a success ends a request and the next attempt with that id starts a new one.
 */
const FIRST = `(request_id IS NULL OR request_id = '' OR COALESCE((SELECT o.failed FROM requests o
  WHERE o.request_id = requests.request_id AND o.id < requests.id ORDER BY o.id DESC LIMIT 1), 0) = 0)`
/** Whether an attempt's client request succeeded in the end: with this attempt or the next success with its id. */
const REQUEST_OK = `(failed = 0 OR (request_id != '' AND EXISTS (SELECT 1 FROM requests o WHERE o.request_id = requests.request_id
  AND o.failed = 0 AND o.id > requests.id)))`

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

/** The same filter for turned-away requests, which never reached a credential or succeeded. */
const whereTurnedAway = (f: UsageFilter) => filterSql(f, [(!!f.authIndex || f.status === 'ok') && '0'])

// API-price value of an attempt, or NULL without a price, for SQL: node:sqlite calls back into JS per row.
// `band` is how many LONG_CONTEXT_STEPS its input exceeded (BAND).
db.function('api_value', { deterministic: true }, (model, tier, uncached, cacheRead, cacheWrite, output, band) => {
  const tokens = { uncached: Number(uncached), cacheRead: Number(cacheRead), cacheWrite: Number(cacheWrite), output: Number(output) }
  return apiValue(String(model), String(tier), tokens, Number(band)) ?? null
})
const PRICE_MODEL = "COALESCE(NULLIF(response_model, ''), model)"
const PRICE_TIER = "COALESCE(NULLIF(response_service_tier, ''), service_tier)"
const BAND = LONG_CONTEXT_STEPS.map((n) => `(input_tokens > ${n})`).join(' + ') || '0'
const VALUE = `api_value(${PRICE_MODEL}, ${PRICE_TIER},
  MAX(input_tokens - cached_tokens - cache_write_tokens, 0), cached_tokens, cache_write_tokens, output_tokens, ${BAND})`

// ---------------------------------------------------------------------------------------------
// Rollup
//
// Summaries add up usage_rollup, sums per 15 minutes of attempts and turned-away requests alike,
// rather than every attempt: a busy install records tens of thousands a day, and summing them all
// for each refresh of the Usage page took seconds. Triggers mark the slots a write touches dirty and
// rollUp sums them again, in the background (scheduleRollUp) or before a summary reads them. Value
// is left as tokens per price model, tier and band, so it follows the current prices.

const SLOT = 900_000
const ROLLUP_COLUMNS = `slot, model, provider, api_key, auth_index, user_agent, price_model, price_tier, band, ok, away,
  requests, failed, recovered, attempts, failed_attempts, input, output, reasoning, cached, cache_write, uncached,
  total, latency, ttft, ttft_count, turned_away`
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_rollup (
    slot INTEGER NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_key TEXT NOT NULL,
    auth_index TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    price_model TEXT NOT NULL,
    price_tier TEXT NOT NULL,
    band INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    away INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    recovered INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    reasoning INTEGER NOT NULL,
    cached INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    uncached INTEGER NOT NULL,
    total INTEGER NOT NULL,
    latency INTEGER NOT NULL,
    ttft INTEGER NOT NULL,
    ttft_count INTEGER NOT NULL,
    turned_away INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_rollup_slot ON usage_rollup (slot);
  CREATE TABLE IF NOT EXISTS usage_rollup_dirty (slot INTEGER PRIMARY KEY);

  CREATE TRIGGER IF NOT EXISTS requests_rollup_insert AFTER INSERT ON requests BEGIN
    INSERT OR IGNORE INTO usage_rollup_dirty VALUES (NEW.ts - NEW.ts % ${SLOT});
    -- A success makes the failed attempts since the previous success with its id part of a request that succeeded.
    INSERT OR IGNORE INTO usage_rollup_dirty SELECT ts - ts % ${SLOT} FROM requests
      WHERE NEW.failed = 0 AND NEW.request_id != '' AND request_id = NEW.request_id AND id < NEW.id
        AND id > COALESCE((SELECT id FROM requests WHERE request_id = NEW.request_id AND failed = 0 AND id < NEW.id ORDER BY id DESC LIMIT 1), 0);
  END;
  CREATE TRIGGER IF NOT EXISTS requests_rollup_update AFTER UPDATE ON requests BEGIN
    INSERT OR IGNORE INTO usage_rollup_dirty VALUES (OLD.ts - OLD.ts % ${SLOT}), (NEW.ts - NEW.ts % ${SLOT});
  END;
  CREATE TRIGGER IF NOT EXISTS requests_rollup_delete AFTER DELETE ON requests BEGIN
    INSERT OR IGNORE INTO usage_rollup_dirty VALUES (OLD.ts - OLD.ts % ${SLOT});
  END;
  CREATE TRIGGER IF NOT EXISTS turned_away_rollup_insert AFTER INSERT ON turned_away BEGIN
    INSERT OR IGNORE INTO usage_rollup_dirty VALUES (NEW.ts - NEW.ts % ${SLOT});
  END;
  CREATE TRIGGER IF NOT EXISTS turned_away_rollup_update AFTER UPDATE ON turned_away BEGIN
    INSERT OR IGNORE INTO usage_rollup_dirty VALUES (OLD.ts - OLD.ts % ${SLOT}), (NEW.ts - NEW.ts % ${SLOT});
  END;
  CREATE TRIGGER IF NOT EXISTS turned_away_rollup_delete AFTER DELETE ON turned_away BEGIN
    INSERT OR IGNORE INTO usage_rollup_dirty VALUES (OLD.ts - OLD.ts % ${SLOT});
  END;
`)

// Version 2 adds the rollup: every slot with history starts dirty. Only the slots are listed here,
// which reads the ts indexes; scheduleRollUp sums them a few hours at a time, so the first start
// after an update never holds the database or the event loop for long.
if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 2) {
  db.exec(`
    BEGIN;
    INSERT OR IGNORE INTO usage_rollup_dirty SELECT DISTINCT ts - ts % ${SLOT} FROM requests;
    INSERT OR IGNORE INTO usage_rollup_dirty SELECT DISTINCT ts - ts % ${SLOT} FROM turned_away;
    PRAGMA user_version = 2;
    COMMIT;
  `)
}

/**
 * Rollup rows straight from the attempts and turned-away requests in [lo, hi) (named parameters),
 * per `ms`. Only the first attempt of a client request counts it, and only there as failed or recovered.
 */
const rawRows = (ms: number, lo = '$from', hi = '$to') => `
  SELECT ts - ts % ${ms} AS slot, model, provider, api_key, auth_index, user_agent, ${PRICE_MODEL} AS price_model, ${PRICE_TIER} AS price_tier,
    ${BAND} AS band, ok, 0 AS away, SUM(first) AS requests, SUM(first AND NOT ok) AS failed, SUM(first AND failed AND ok) AS recovered,
    COUNT(*) AS attempts, SUM(failed) AS failed_attempts, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
    SUM(reasoning_tokens) AS reasoning, SUM(cached_tokens) AS cached, SUM(cache_write_tokens) AS cache_write,
    SUM(MAX(input_tokens - cached_tokens - cache_write_tokens, 0)) AS uncached, SUM(total_tokens) AS total, SUM(latency_ms) AS latency,
    SUM(CASE WHEN stream = 1 AND ttft_ms > 0 THEN ttft_ms ELSE 0 END) AS ttft, SUM(stream = 1 AND ttft_ms > 0) AS ttft_count, 0 AS turned_away
  FROM (SELECT *, ${FIRST} AS first, ${REQUEST_OK} AS ok FROM requests WHERE ts >= ${lo} AND ts < ${hi} LIMIT -1)
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  UNION ALL
  SELECT ts - ts % ${ms}, model, provider, api_key, '', '', '', '', 0, 0, 1, COUNT(*), COUNT(*), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, COUNT(*)
  FROM turned_away WHERE ts >= ${lo} AND ts < ${hi} GROUP BY 1, 2, 3, 4`

const dirtySlots = db.prepare('SELECT slot FROM usage_rollup_dirty WHERE slot >= ? AND slot < ? ORDER BY slot DESC LIMIT ?')
const clearSlot = db.prepare('DELETE FROM usage_rollup WHERE slot = ?')
const fillSlot = db.prepare(`INSERT INTO usage_rollup (${ROLLUP_COLUMNS}) ${rawRows(SLOT)}`)
const cleanSlot = db.prepare('DELETE FROM usage_rollup_dirty WHERE slot = ?')

/**
 * Sums the dirty slots in [from, to) again, newest first, stopping after the slot that passes
 * `budgetMs`. Returns whether any are left.
 */
function rollUp(from: number, to: number, budgetMs = Infinity) {
  const start = performance.now()
  for (;;) {
    const slots = (dirtySlots.all(from, to, 64) as { slot: number }[]).map((r) => r.slot)
    if (!slots.length) return false
    db.exec('BEGIN')
    try {
      for (const slot of slots) {
        clearSlot.run(slot)
        fillSlot.run({ from: slot, to: slot + SLOT })
        cleanSlot.run(slot)
        if (performance.now() - start > budgetMs) break
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    if (performance.now() - start > budgetMs) return true
  }
}

let rolling = false
/**
 * Rolls up every dirty slot, about 20 ms of them per turn of the event loop so requests are served
 * in between. A burst of traffic can put over 10,000 attempts in one slot, so a count of slots
 * would not bound it.
 */
function scheduleRollUp() {
  if (rolling) return
  rolling = true
  const step = () => {
    try {
      if (rollUp(0, Number.MAX_SAFE_INTEGER, 20)) return void setImmediate(step)
    } catch (err) {
      console.error(`Usage rollup failed: ${err instanceof Error ? err.message : err}`)
    }
    rolling = false
  }
  setImmediate(step)
}

/**
 * Runs `read` with temp.usage_rows holding the rollup rows for [f.from, f.to) in the filter, per `ms`
 * (SLOT or less), each with its API-price value as `value`. Whole slots come from usage_rollup, the
 * rest from the attempts.
 */
export function withUsageRows<T>(f: UsageFilter, read: () => T, ms = SLOT): T {
  const clauses = ['1']
  const params: Record<string, SQLInputValue> = { from: f.from, to: f.to }
  for (const [col, name, v] of [['model', 'model', f.model], ['provider', 'provider', f.provider], ['api_key', 'apiKey', f.apiKey], ['auth_index', 'authIndex', f.authIndex]] as const) {
    if (v) {
      clauses.push(`${col} = $${name}`)
      params[name] = v
    }
  }
  if (f.status) clauses.push({ ok: 'ok = 1', failed: 'ok = 0', turned_away: 'away = 1' }[f.status])

  const a = Math.ceil(f.from / SLOT) * SLOT
  const b = Math.floor(f.to / SLOT) * SLOT
  let parts = [rawRows(ms)]
  if (ms === SLOT && a < b) {
    rollUp(a, b)
    Object.assign(params, { a, b })
    parts = [`SELECT ${ROLLUP_COLUMNS} FROM usage_rollup WHERE slot >= $a AND slot < $b`]
    if (f.from < a) parts.push(rawRows(SLOT, '$from', '$a'))
    if (b < f.to) parts.push(rawRows(SLOT, '$b', '$to'))
    if (f.from >= a) delete params.from
    if (b >= f.to) delete params.to
  }
  db.exec('DROP TABLE IF EXISTS temp.usage_rows')
  db.prepare(
    `CREATE TEMP TABLE usage_rows AS SELECT *, api_value(price_model, price_tier, uncached, cached, cache_write, output, band) AS value
     FROM (${parts.join(' UNION ALL ')}) WHERE ${clauses.join(' AND ')}`,
  ).run(params)
  try {
    return read()
  } finally {
    db.exec('DROP TABLE temp.usage_rows')
  }
}

/** Metrics over rows of temp.usage_rows. */
const METRICS = `
  TOTAL(requests) AS requests,
  TOTAL(failed) AS failed,
  TOTAL(recovered) AS recovered,
  TOTAL(turned_away) AS turnedAway,
  TOTAL(attempts) AS attempts,
  TOTAL(failed_attempts) AS failedAttempts,
  TOTAL(input) AS input,
  TOTAL(output) AS output,
  TOTAL(reasoning) AS reasoning,
  TOTAL(cached) AS cached,
  TOTAL(cache_write) AS cacheWrite,
  TOTAL(total) AS total,
  TOTAL(latency) / TOTAL(attempts) AS avgLatency,
  TOTAL(ttft) / TOTAL(ttft_count) AS avgTtft,
  TOTAL(value) AS value,
  TOTAL(CASE WHEN value IS NULL THEN input + output END) AS unpricedTokens`

/** A row of METRICS; `key` in breakdowns. */
export interface Metrics {
  key?: string
  requests: number
  failed: number
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
  value: number
  unpricedTokens: number
}

const WEEK = 7 * 86_400_000
const BUCKETS = [60_000, 300_000, 900_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 86_400_000, WEEK]

/** The first record's time, or undefined without any. Both tables are indexed on ts, so this is a lookup. */
function oldestTs() {
  const { ts } = db.prepare('SELECT MIN(ts) AS ts FROM (SELECT MIN(ts) AS ts FROM requests UNION ALL SELECT MIN(ts) FROM turned_away)').get() as { ts: number | null }
  return ts ?? undefined
}

export function usageSummary(f: UsageFilter, tzOffsetMin: number) {
  // All time asks from the epoch: the chart starts at the first record instead.
  const from = Math.max(f.from, oldestTs() ?? f.to)
  const bucket = BUCKETS.find((b) => (f.to - from) / b <= 120) ?? WEEK
  // Align day buckets to the viewer's local midnight, and weeks to Monday (the epoch was a Thursday).
  const shift = -tzOffsetMin * 60_000 + (bucket === WEEK ? 3 * 86_400_000 : 0)
  return withUsageRows(f, () => {
    const totals = {
      ...(db.prepare(`SELECT ${METRICS} FROM usage_rows`).get() as unknown as Metrics),
      unpricedModels: (db.prepare('SELECT DISTINCT model FROM usage_rows WHERE value IS NULL AND input + output > 0 ORDER BY 1').all() as { model: string }[]).map((r) => r.model),
    }

    const rows = db
      .prepare(
        `SELECT ((slot + ?) / ?) * ? - ? AS t, TOTAL(requests) AS requests, TOTAL(failed) AS failed, TOTAL(turned_away) AS turnedAway,
          TOTAL(input) AS input, TOTAL(output) AS output, TOTAL(cached) AS cached, TOTAL(cache_write) AS cacheWrite, TOTAL(total) AS total,
          TOTAL(latency) / TOTAL(attempts) AS avgLatency
         FROM usage_rows GROUP BY t ORDER BY t`,
      )
      // node:sqlite binds JS numbers as REAL; BigInt keeps the bucket math in integer division.
      .all(BigInt(shift), BigInt(bucket), BigInt(bucket), BigInt(shift)) as { t: number }[]
    const byT = new Map(rows.map((r) => [r.t, r]))
    const series = []
    const start = Math.floor((from + shift) / bucket) * bucket - shift
    for (let t = start; t < f.to; t += bucket) {
      series.push(byT.get(t) ?? { t, requests: 0, failed: 0, turnedAway: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0, avgLatency: null })
    }

    const group = (col: string) =>
      db.prepare(`SELECT ${col} AS key, ${METRICS} FROM usage_rows GROUP BY 1 ORDER BY TOTAL(requests) DESC LIMIT 50`).all() as unknown as (Metrics & { key: string })[]
    // Attempts, so an account shows the attempts that failed on it. Turned-away requests never reached one.
    const byCredential = db
      .prepare(
        `SELECT auth_index AS key, TOTAL(attempts) AS requests, TOTAL(failed_attempts) AS failed, 0 AS recovered, 0 AS turnedAway,
          TOTAL(attempts) AS attempts, TOTAL(failed_attempts) AS failedAttempts, TOTAL(input) AS input, TOTAL(output) AS output,
          TOTAL(reasoning) AS reasoning, TOTAL(cached) AS cached, TOTAL(cache_write) AS cacheWrite, TOTAL(total) AS total,
          TOTAL(latency) / TOTAL(attempts) AS avgLatency, TOTAL(ttft) / TOTAL(ttft_count) AS avgTtft, TOTAL(value) AS value,
          TOTAL(CASE WHEN value IS NULL THEN input + output END) AS unpricedTokens
         FROM usage_rows WHERE away = 0 GROUP BY 1 ORDER BY TOTAL(attempts) DESC LIMIT 50`,
      )
      .all() as unknown as (Metrics & { key: string })[]
    return { bucketMs: bucket, totals, series, byModel: group('model'), byProvider: group('provider'), byCredential, byApiKey: group('api_key') }
  }, Math.min(bucket, SLOT))
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
  return withUsageRows({ from, to }, () => {
    const distinct = (col: string) =>
      (db.prepare(`SELECT DISTINCT ${col} AS v FROM usage_rows WHERE ${col} != '' ORDER BY v`).all() as { v: string }[]).map((r) => r.v)
    return { models: distinct('model'), providers: distinct('provider'), credentials: distinct('auth_index'), apiKeys: distinct('api_key') }
  })
}

/**
 * What one credential (an upstream API key) spent at API list prices, over the last day, week and
 * 30 days and since `balance` (0 without one), with its attempts and tokens over the 30 days.
 */
export function apiKeySpend(authIndex: string, since: { day: number; week: number; month: number; balance?: number }) {
  const balance = since.balance ?? Number.MAX_SAFE_INTEGER
  return db
    .prepare(
      `SELECT TOTAL(CASE WHEN ts >= $day THEN v END) AS day, TOTAL(CASE WHEN ts >= $week THEN v END) AS week,
        TOTAL(CASE WHEN ts >= $month THEN v END) AS month, TOTAL(CASE WHEN ts >= $balance THEN v END) AS sinceBalance,
        TOTAL(ts >= $month) AS requests, TOTAL(ts >= $month AND failed) AS failed,
        TOTAL(CASE WHEN ts >= $month THEN input_tokens END) AS input, TOTAL(CASE WHEN ts >= $month THEN output_tokens END) AS output,
        TOTAL(CASE WHEN ts >= $month THEN cached_tokens END) AS cached,
        TOTAL(CASE WHEN ts >= $month AND v IS NULL THEN input_tokens + output_tokens END) AS unpricedTokens
       FROM (SELECT *, ${VALUE} AS v FROM requests WHERE auth_index = $index AND ts >= $from LIMIT -1)`,
    )
    .get({ index: authIndex, from: Math.min(since.month, balance), day: since.day, week: since.week, month: since.month, balance }) as {
    day: number
    week: number
    month: number
    sinceBalance: number
    requests: number
    failed: number
    input: number
    output: number
    cached: number
    unpricedTokens: number
  }
}

export function clearUsage() {
  db.exec('DELETE FROM requests; DELETE FROM turned_away; DELETE FROM usage_rollup; DELETE FROM usage_rollup_dirty')
}
