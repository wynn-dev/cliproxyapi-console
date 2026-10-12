import { limitReadings, saveReading, type ListedCredential } from './limits.ts'
import { management } from './management.ts'
import { readState, updateState } from './state.ts'
import { db } from './usage.ts'

/**
 * Limit checks for idle accounts. CPA only learns an account's limits from the headers of requests
 * it serves, so with fill-first every account but the one in use shows old numbers, and the reserve
 * cannot see a held-back account recover. When turned on, the console asks the provider's usage
 * endpoint (the one Claude Code and Codex show their usage from) about each account whose reading is
 * over 10 minutes old. It goes through CPA's api-call, which fills in the account's token.
 *
 * Opt-in: the endpoints are undocumented, and calling them is a terms-of-service grey area.
 */

/** A reading this old gets checked. Also the shortest gap between two checks of one account. */
const STALE_MS = 10 * 60_000
/** At most one check per tick, so accounts are checked one after another, never all at once. */
const TICK_MS = 30_000
const MAX_BACKOFF_MS = 6 * 3600_000
/** Failed checks wait 20m, 40m, 80m… before the next try. */
const backoff = (failures: number) => Math.min(MAX_BACKOFF_MS, STALE_MS * 2 ** failures)

/**
 * For tests only: CPA_CONSOLE_CLAUDE_USAGE_URL and CPA_CONSOLE_CODEX_USAGE_URL point the checks at a
 * mock instead of the real providers. Not a user option.
 */
const USAGE_URL: Record<string, string> = {
  claude: process.env.CPA_CONSOLE_CLAUDE_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage',
  codex: process.env.CPA_CONSOLE_CODEX_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage',
}
/** A local mock is reached directly, not through the account's proxy. */
const MOCKED = !!(process.env.CPA_CONSOLE_CLAUDE_USAGE_URL || process.env.CPA_CONSOLE_CODEX_USAGE_URL)
/** CPA's default Claude Code fingerprint, so the check looks like the account's other traffic. */
const CLAUDE_USER_AGENT = 'claude-cli/2.1.280 (external, cli)'

db.exec(`CREATE TABLE IF NOT EXISTS limit_checks (
  name TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  ok_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
)`)

interface Row {
  name: string
  checked_at: number
  /** The last successful check, which is also the observed_at of the reading it stored. */
  ok_at: number | null
  /** Failed checks in a row. */
  failures: number
  /** Upstream HTTP status of the last failed check; 0 when it never got an answer. */
  status: number
  error: string
}

const rows = () => new Map((db.prepare('SELECT * FROM limit_checks').all() as unknown as Row[]).map((r) => [r.name, r]))
const saveRow = db.prepare(`
  INSERT INTO limit_checks (name, checked_at, ok_at, failures, status, error) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET checked_at = excluded.checked_at, ok_at = excluded.ok_at, failures = excluded.failures,
    status = excluded.status, error = excluded.error`)

export const limitChecksEnabled = () => readState().limitChecks === true

export function setLimitChecks(enabled: boolean) {
  updateState({ limitChecks: enabled })
}

/**
 * Each account's last check, by credential file name. `error` and `status` describe the last check
 * when it failed (a 401 or 403 usually means the account's sign-in no longer works).
 */
export function limitCheckStatus() {
  return {
    enabled: limitChecksEnabled(),
    accounts: Object.fromEntries(
      [...rows().values()].map((r) => [
        r.name,
        {
          checkedAt: r.checked_at,
          okAt: r.ok_at ?? undefined,
          ...(r.failures ? { error: r.error, status: r.status || undefined, retryAt: r.checked_at + backoff(r.failures) } : {}),
        },
      ]),
    ),
  }
}

type Listed = ListedCredential & { auth_index?: string; account_type?: string; id_token?: { chatgpt_account_id?: string } }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)

/** Unix seconds from an ISO time or a number of seconds or milliseconds. */
function unixSeconds(v: unknown) {
  const n = num(v)
  if (n !== undefined) return Math.floor(n > 1e12 ? n / 1000 : n)
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/**
 * Claude's usage response as the `anthropic-ratelimit-unified-*` headers it stands for. Utilization
 * there is a percent, in the headers a share. Newer responses also carry a `limits` list; the
 * model-scoped weekly entry for Fable is the `7d_oi` (overage included) window.
 */
export function claudeSignals(body: unknown) {
  const b = obj(body) ?? {}
  const out: Record<string, string> = {}
  const set = (id: string, used: unknown, resetsAt: unknown) => {
    const pct = num(used)
    if (pct === undefined || `anthropic-ratelimit-unified-${id}-utilization` in out) return
    out[`anthropic-ratelimit-unified-${id}-utilization`] = String(pct / 100)
    const reset = unixSeconds(resetsAt)
    if (reset) out[`anthropic-ratelimit-unified-${id}-reset`] = String(reset)
  }
  for (const [key, id] of [['five_hour', '5h'], ['seven_day', '7d'], ['seven_day_overage_included', '7d_oi']]) {
    set(id, obj(b[key])?.utilization, obj(b[key])?.resets_at)
  }
  for (const l of Array.isArray(b.limits) ? b.limits.map(obj) : []) {
    const scope = String(obj(obj(l?.scope)?.model)?.display_name ?? '')
    const id = l?.kind === 'session' ? '5h' : l?.kind === 'weekly_all' ? '7d' : l?.kind === 'weekly_scoped' && /fable/i.test(scope) ? '7d_oi' : undefined
    if (id) set(id, l?.percent ?? l?.utilization, l?.resets_at)
  }
  return out
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Codex's usage response as the `x-codex-*` headers it stands for. Extra limits (e.g. a model with
 * its own allowance) are named after their metered feature, as in the headers (`codex_bengalfox`
 * there is `x-codex-bengalfox-*`).
 */
export function codexSignals(body: unknown) {
  const b = obj(body) ?? {}
  const out: Record<string, string> = {}
  const windows = (prefix: string, rate: Record<string, unknown> | undefined) => {
    let any = false
    for (const slot of ['primary', 'secondary']) {
      const w = obj(rate?.[`${slot}_window`] ?? rate?.[slot])
      const used = num(w?.used_percent)
      if (!w || used === undefined) continue
      const p = `${prefix}${slot}-`
      out[`${p}used-percent`] = String(used)
      const seconds = num(w.limit_window_seconds)
      const minutes = num(w.window_minutes) ?? (seconds !== undefined ? Math.round(seconds / 60) : undefined)
      if (minutes) out[`${p}window-minutes`] = String(minutes)
      const resetAt = unixSeconds(w.reset_at)
      if (resetAt) out[`${p}reset-at`] = String(resetAt)
      const after = num(w.reset_after_seconds)
      if (after !== undefined) out[`${p}reset-after-seconds`] = String(after)
      any = true
    }
    return any
  }
  windows('x-codex-', obj(b.rate_limit))
  const extra = Array.isArray(b.additional_rate_limits) ? b.additional_rate_limits : Object.values(obj(b.additional_rate_limits) ?? {})
  for (const a of extra.map(obj)) {
    const name = typeof a?.limit_name === 'string' ? a.limit_name : ''
    const scope = slug(String(a?.metered_feature ?? '').replace(/^codex_/, '') || name)
    if (scope && windows(`x-codex-${scope}-`, obj(a?.rate_limit)) && name) out[`x-codex-${scope}-limit-name`] = name
  }
  if (Object.keys(out).length && typeof b.plan_type === 'string') out['x-codex-plan-type'] = b.plan_type
  return out
}

/**
 * Signals of the previous reading for windows the check did not report (another model's limit, extra
 * usage), so a check never makes them disappear. They stay as old as they were.
 */
function carried(provider: string, prev: Record<string, string> | undefined, fresh: Record<string, string>) {
  const owned: string[] = []
  for (const k of Object.keys(fresh)) {
    const m = provider === 'claude' ? /^(anthropic-ratelimit-unified-.+?-)utilization$/.exec(k) : /^(x-codex-(?:.+-)?)(?:primary|secondary)-used-percent$/.exec(k)
    if (!m) continue
    if (provider === 'claude') owned.push(m[1])
    else owned.push(`${m[1]}primary-`, `${m[1]}secondary-`, `${m[1]}limit-name`)
  }
  return Object.fromEntries(Object.entries(prev ?? {}).filter(([k]) => !owned.some((p) => k.toLowerCase().startsWith(p))))
}

/** Header-name case as CPA stores signals (Go's canonical form), for readers that look keys up as is. */
const canonical = (signals: Record<string, string>) =>
  Object.fromEntries(Object.entries(signals).map(([k, v]) => [k.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase()), v]))

/** The upstream's own error message, if it sent one. */
function upstreamError(body: string | undefined) {
  try {
    const b = obj(JSON.parse(body ?? ''))
    const e = b?.error
    const msg = typeof e === 'string' ? e : (obj(e)?.message ?? b?.detail ?? b?.message)
    return typeof msg === 'string' && msg.trim() ? msg.trim().slice(0, 200) : undefined
  } catch {
    return undefined
  }
}

function fail(name: string, prev: Row | undefined, now: number, status: number, error: string) {
  const failures = (prev?.failures ?? 0) + 1
  saveRow.run(name, now, prev?.ok_at ?? null, failures, status, error)
  // Logged once per run of failures; the backoff keeps it from retrying in a loop.
  if (failures === 1) console.error(`Limit check: ${name} failed: ${error}. Trying again less often.`)
}

async function check(f: Listed, prev: Row | undefined, reading: Record<string, string> | undefined, now: number) {
  const provider = f.provider as 'claude' | 'codex'
  const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' }
  if (provider === 'claude') {
    header['anthropic-beta'] = 'oauth-2025-04-20'
    header['User-Agent'] = CLAUDE_USER_AGENT
  } else {
    header['User-Agent'] = 'codex_cli_rs'
    header.Originator = 'codex_cli_rs'
    if (f.id_token?.chatgpt_account_id) header['ChatGPT-Account-Id'] = f.id_token.chatgpt_account_id
  }
  let res: Response | undefined
  try {
    res = await management('/requests/api-call', { method: 'POST', body: { auth_index: f.auth_index, method: 'GET', url: USAGE_URL[provider], header, ...(MOCKED && { proxy_url: 'direct' }) } })
  } catch (err) {
    return fail(f.name, prev, now, 0, `No answer: ${(err as Error).message}`)
  }
  // CPA stopped or restarting: not the account's fault.
  if (!res) return
  const out = (await res.json().catch(() => ({}))) as { status_code?: number; body?: string; error?: string }
  if (!res.ok) return fail(f.name, prev, now, 0, `CLIProxyAPI could not make the call: ${out.error ?? `HTTP ${res.status}`}`)
  const status = out.status_code ?? 0
  if (status < 200 || status > 299) {
    const detail = upstreamError(out.body)
    return fail(f.name, prev, now, status, `HTTP ${status}${detail ? `: ${detail}` : ''}`)
  }
  let body: unknown
  try {
    body = JSON.parse(out.body ?? '')
  } catch {
    return fail(f.name, prev, now, status, 'The answer was not JSON')
  }
  const signals = provider === 'claude' ? claudeSignals(body) : codexSignals(body)
  if (!Object.keys(signals).length) return fail(f.name, prev, now, status, 'The answer had no limits in it')
  saveReading(f.name, now, { ...carried(provider, reading, signals), ...canonical(signals) })
  saveRow.run(f.name, now, now, 0, 0, '')
  if (prev?.failures) console.log(`Limit check: ${f.name} works again`)
}

/** Checks the account with the oldest reading, if any is due. */
async function checkNext(now = Date.now()) {
  const res = await management('/credentials')
  if (!res?.ok) return
  const { files } = (await res.json()) as { files?: Listed[] }
  const readings = limitReadings()
  const checks = rows()
  let next: { f: Listed; readAt: number } | undefined
  for (const f of files ?? []) {
    // Subscription accounts only: an API key has no usage page. Disabled ones are checked too, so the
    // reserve sees a held-back account recover.
    if (!f.provider || !(f.provider in USAGE_URL) || f.account_type !== 'oauth' || !f.auth_index) continue
    const readAt = Math.max(Date.parse(readings[f.name]?.observed_at ?? '') || 0, Date.parse(f.quota?.observed_at ?? '') || 0)
    if (now - readAt < STALE_MS) continue
    const row = checks.get(f.name)
    if (row && now < row.checked_at + (row.failures ? backoff(row.failures) : STALE_MS)) continue
    if (!next || readAt < next.readAt) next = { f, readAt }
  }
  if (next) await check(next.f, checks.get(next.f.name), readings[next.f.name]?.signals, now)
}

export function startLimitChecks() {
  let busy = false
  setInterval(async () => {
    if (busy || !limitChecksEnabled()) return
    busy = true
    try {
      await checkNext()
    } catch {
      // CPA restarting or busy: try again on the next tick.
    } finally {
      busy = false
    }
  }, TICK_MS)
}
