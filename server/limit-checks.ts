import fs from 'node:fs'
import YAML from 'yaml'
import { paths } from './env.ts'
import { recordLimitReading } from './limit-history.ts'
import { limitReadings, saveReading, type ListedCredential } from './limits.ts'
import { management } from './management.ts'
import { reserveStatus } from './reserve.ts'
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
 * For tests only: CPA_CONSOLE_CLAUDE_USAGE_URL and CPA_CONSOLE_CODEX_USAGE_URL point one provider's
 * checks at a mock on this machine, reached directly rather than through the account's proxy. Not a
 * user option. So a test never reaches a real provider, setting either one turns off checks for a
 * provider without its own, and any host but this machine turns off that provider's checks.
 */
const TESTING = !!(process.env.CPA_CONSOLE_CLAUDE_USAGE_URL || process.env.CPA_CONSOLE_CODEX_USAGE_URL)

function endpoint(provider: string, variable: string, real: string) {
  const override = process.env[variable]
  if (!override && TESTING) {
    console.error(`Limit check: ${variable} is not set while testing; ${provider} accounts won't be checked.`)
    return undefined
  }
  if (!override) return { url: real, direct: false }
  let host = ''
  try {
    host = new URL(override).hostname
  } catch {
    // Not a URL: refused below.
  }
  if (host === '127.0.0.1' || host === 'localhost') return { url: override, direct: true }
  console.error(`Limit check: ${variable} must point at 127.0.0.1 or localhost; ${provider} accounts won't be checked.`)
  return undefined
}

const ENDPOINTS: Record<string, { url: string; direct: boolean } | undefined> = {
  claude: endpoint('Claude', 'CPA_CONSOLE_CLAUDE_USAGE_URL', 'https://api.anthropic.com/api/oauth/usage'),
  codex: endpoint('Codex', 'CPA_CONSOLE_CODEX_USAGE_URL', 'https://chatgpt.com/backend-api/wham/usage'),
}

/** CPA's own defaults (claude_device_profile.go, codex_executor_request.go), used unless config.yaml sets one. */
const DEFAULT_USER_AGENT = {
  claude: 'claude-cli/2.1.280 (external, cli)',
  codex: 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)',
}

/** The user agent CPA sends for this provider, so a check looks like the account's other traffic. */
function userAgent(provider: 'claude' | 'codex') {
  try {
    const doc = YAML.parse(fs.readFileSync(paths.config, 'utf8')) ?? {}
    const set =
      provider === 'claude'
        ? (doc.upstream?.claude?.['header-defaults'] ?? doc.oauth?.providers?.claude?.['header-defaults'] ?? doc['claude-header-defaults'])
        : (doc.oauth?.providers?.codex?.['header-defaults'] ?? doc['codex-header-defaults'])
    const ua = set?.['user-agent']
    if (typeof ua === 'string' && ua.trim()) return ua.trim()
  } catch {
    // Unreadable config: CPA's defaults.
  }
  return DEFAULT_USER_AGENT[provider]
}

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
const deleteRow = db.prepare('DELETE FROM limit_checks WHERE name = ?')

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

/** Unix seconds from an ISO time or a number of seconds. */
function unixSeconds(v: unknown) {
  const n = num(v)
  if (n !== undefined) return Math.floor(n)
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** A reset time that can belong to a 5-hour or weekly window seen now. */
const plausibleReset = (reset: number | undefined, now: number): reset is number =>
  !!reset && reset * 1000 > now - 3_600_000 && reset * 1000 <= now + 7 * 86_400_000 + 3_600_000

/** A percent from 0 to 100, allowing for rounding just over 100; undefined when it isn't one. */
const percent = (v: number | undefined) => (v !== undefined && v >= 0 && v <= 101 ? Math.min(v, 100) : undefined)

/**
 * Claude's usage response as the `anthropic-ratelimit-unified-*` headers it stands for, or why it
 * can't be used. Only the 5-hour and weekly windows are read: their `utilization` is a percent,
 * where the headers carry a share. Newer responses also list limits with a `percent` whose scale is
 * unconfirmed, so those are left out rather than guessed at. A number that could release a held
 * account wrongly fails the check instead.
 */
export function claudeSignals(body: unknown, now: number): Record<string, string> | string {
  const b = obj(body) ?? {}
  const out: Record<string, string> = {}
  for (const [key, id, label] of [['five_hour', '5h', '5-hour'], ['seven_day', '7d', 'weekly']]) {
    // No 5-hour window running: left out, as nothing has been used.
    if (key === 'five_hour' && b[key] === null) continue
    const w = obj(b[key])
    const used = percent(num(w?.utilization))
    if (used === undefined) return `The answer had no valid ${label} usage`
    const reset = unixSeconds(w?.resets_at)
    // A window that hasn't started has no reset yet. 0% used without a reset can't release a held
    // account: the reserve only trusts a window with a reset time.
    if (!plausibleReset(reset, now) && !(used === 0 && w?.resets_at == null)) return `The answer had no valid ${label} reset time`
    out[`anthropic-ratelimit-unified-${id}-utilization`] = String(used / 100)
    if (reset) out[`anthropic-ratelimit-unified-${id}-reset`] = String(reset)
  }
  return out
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Codex's usage response as the `x-codex-*` headers it stands for, or why it can't be used. The main
 * 5-hour window is required. Reset times are stored as absolute times only. Extra limits (a model
 * with its own allowance) are named after their metered feature, as in the headers (`codex_bengalfox`
 * there is `x-codex-bengalfox-*`), and an invalid one is left out.
 */
export function codexSignals(body: unknown, now: number): Record<string, string> | string {
  const b = obj(body) ?? {}
  const window = (prefix: string, slot: string, w: Record<string, unknown> | undefined) => {
    const used = percent(num(w?.used_percent))
    const label = slot === 'primary' ? '5-hour' : 'weekly'
    if (!w || used === undefined) return `no valid ${label} usage`
    const after = num(w.reset_after_seconds)
    const reset = unixSeconds(w.reset_at) ?? (after !== undefined && after >= 0 ? Math.floor(now / 1000 + after) : undefined)
    if (!plausibleReset(reset, now)) return `no valid ${label} reset time`
    const seconds = num(w.limit_window_seconds)
    const minutes = num(w.window_minutes) ?? (seconds !== undefined ? Math.round(seconds / 60) : undefined)
    return {
      [`${prefix}${slot}-used-percent`]: String(used),
      [`${prefix}${slot}-reset-at`]: String(reset),
      ...(minutes && minutes > 0 ? { [`${prefix}${slot}-window-minutes`]: String(minutes) } : {}),
    }
  }
  const windows = (prefix: string, rate: Record<string, unknown> | undefined) =>
    ['primary', 'secondary'].map((slot) => (rate?.[`${slot}_window`] ?? rate?.[slot]) == null ? {} : window(prefix, slot, obj(rate?.[`${slot}_window`] ?? rate?.[slot])))

  const rate = obj(b.rate_limit)
  if (!obj(rate?.primary_window ?? rate?.primary)) return 'The answer had no 5-hour usage'
  const out: Record<string, string> = {}
  for (const w of windows('x-codex-', rate)) {
    if (typeof w === 'string') return `The answer had ${w}`
    Object.assign(out, w)
  }
  const extra = Array.isArray(b.additional_rate_limits) ? b.additional_rate_limits : Object.values(obj(b.additional_rate_limits) ?? {})
  for (const a of extra.map(obj)) {
    const name = typeof a?.limit_name === 'string' ? a.limit_name : ''
    const scope = slug(String(a?.metered_feature ?? '').replace(/^codex_/, '') || name)
    const ws = windows(`x-codex-${scope}-`, obj(a?.rate_limit))
    if (!scope || ws.some((w) => typeof w === 'string') || !ws.some((w) => Object.keys(w).length)) continue
    for (const w of ws) Object.assign(out, w)
    if (name) out[`x-codex-${scope}-limit-name`] = name
  }
  return out
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

async function check(f: Listed, prev: Row | undefined, now: number) {
  const provider = f.provider as 'claude' | 'codex'
  const target = ENDPOINTS[provider]!
  const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', Accept: 'application/json', 'User-Agent': userAgent(provider) }
  if (provider === 'claude') header['anthropic-beta'] = 'oauth-2025-04-20'
  else {
    header.Originator = 'codex-tui'
    if (f.id_token?.chatgpt_account_id) header['ChatGPT-Account-Id'] = f.id_token.chatgpt_account_id
  }
  let res: Response | undefined
  try {
    res = await management('/requests/api-call', {
      method: 'POST',
      body: { auth_index: f.auth_index, method: 'GET', url: target.url, header, ...(target.direct && { proxy_url: 'direct' }) },
    })
  } catch (err) {
    // CPA restarting refuses the connection: not the account's fault. A timeout may be.
    const name = (err as Error).name
    if (name !== 'TimeoutError' && name !== 'AbortError') return
    return fail(f.name, prev, now, 0, 'No answer within 10 seconds')
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
  const signals = provider === 'claude' ? claudeSignals(body, now) : codexSignals(body, now)
  if (typeof signals === 'string') return fail(f.name, prev, now, status, signals)
  // Nothing is carried over from the last reading: it would be stored as if seen now.
  const reading = canonical(signals)
  saveReading(f.name, now, reading)
  recordLimitReading(f.name, provider, { observed_at: new Date(now).toISOString(), signals: reading })
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
  const held = reserveStatus().accounts
  // Forget credentials that were removed; an empty list is more likely CPA still loading.
  if (files?.length) for (const name of checks.keys()) if (!files.some((f) => f.name === name)) deleteRow.run(name)
  let next: { f: Listed; readAt: number } | undefined
  for (const f of files ?? []) {
    // Subscription accounts only: an API key has no usage page. Of the disabled ones, only those the
    // reserve holds, so it sees them recover; one the user turned off is left alone.
    if (!f.provider || !ENDPOINTS[f.provider] || f.account_type !== 'oauth' || !f.auth_index) continue
    if (f.disabled && !(f.name in held)) continue
    const readAt = Math.max(Date.parse(readings[f.name]?.observed_at ?? '') || 0, Date.parse(f.quota?.observed_at ?? '') || 0)
    if (now - readAt < STALE_MS) continue
    const row = checks.get(f.name)
    if (row && now < row.checked_at + (row.failures ? backoff(row.failures) : STALE_MS)) continue
    if (!next || readAt < next.readAt) next = { f, readAt }
  }
  if (next) await check(next.f, checks.get(next.f.name), now)
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
