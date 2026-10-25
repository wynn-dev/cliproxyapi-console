import crypto from 'node:crypto'
import { availability, type PoolAccount } from './availability.ts'
import type { ListedCredential } from './limits.ts'
import { management } from './management.ts'
import { readState, updateState, type ApiKeyMark } from './state.ts'
import { apiKeySpend, db, onUsageRecords } from './usage.ts'

/**
 * API key fallback: a group of upstream API keys that only takes traffic while none of its
 * provider's subscription accounts can. CPA already prefers the highest priority tier, so the
 * group is kept one below every account. But with session affinity, a conversation that landed on
 * a key stays there (billed) even after an account is back. So the console also takes the group
 * out of rotation while an account is available, the way CPA disables a config API key: an
 * excluded-models pattern matching every model. Bound conversations then move back to an account.
 *
 * A group whose keys have all run out of credits stays out until the user enters a new balance.
 *
 * The console also keeps, per API key, the last upstream rate-limit headers and whether the
 * provider turned it away for lack of credits, for the Providers page.
 */

const PROVIDERS = ['claude', 'codex']
/** CPA's own pattern for a disabled config API key (config_apikey_disable.go). */
const ALL_MODELS = '*'
/** How long an account must stay available before the fallback goes out of rotation again, so a short cooldown ending doesn't flap it. */
const STABLE_MS = 60_000
/** Upstream errors that mean the key's account has no credits left (Anthropic, then OpenAI). */
const NO_CREDITS = /credit balance is too low|billing_error|insufficient_quota|exceeded your current quota/i
/** Per-key API rate limits: Anthropic's anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-*, OpenAI's x-ratelimit-*. */
const RATE_HEADER = /^(anthropic-ratelimit-(requests|tokens|input-tokens|output-tokens)-(limit|remaining|reset)|x-ratelimit-(limit|remaining|reset)-(requests|tokens))$/

/** A hash of an API key, so console state never holds the key itself. */
export const keyId = (apiKey: string) => crypto.createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16)

db.exec(`CREATE TABLE IF NOT EXISTS api_key_status (
  auth_index TEXT PRIMARY KEY,
  ok_at INTEGER NOT NULL DEFAULT 0,
  out_at INTEGER NOT NULL DEFAULT 0,
  out_error TEXT NOT NULL DEFAULT '',
  limits TEXT NOT NULL DEFAULT '{}',
  limits_at INTEGER NOT NULL DEFAULT 0
)`)

interface KeyStatus {
  okAt: number
  outAt: number
  outError: string
  limits: Record<string, string>
  limitsAt: number
}

const saveStatus = db.prepare(`
  INSERT INTO api_key_status (auth_index, ok_at, out_at, out_error, limits, limits_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (auth_index) DO UPDATE SET ok_at = MAX(ok_at, excluded.ok_at),
    out_at = MAX(out_at, excluded.out_at),
    out_error = CASE WHEN excluded.out_at > out_at THEN excluded.out_error ELSE out_error END,
    limits = CASE WHEN excluded.limits_at > limits_at THEN excluded.limits ELSE limits END,
    limits_at = MAX(limits_at, excluded.limits_at)`)

function statuses() {
  const rows = db.prepare('SELECT auth_index, ok_at, out_at, out_error, limits, limits_at FROM api_key_status').all() as
    { auth_index: string; ok_at: number; out_at: number; out_error: string; limits: string; limits_at: number }[]
  return new Map<string, KeyStatus>(
    rows.map((r) => [r.auth_index, { okAt: r.ok_at, outAt: r.out_at, outError: r.out_error, limits: JSON.parse(r.limits), limitsAt: r.limits_at }]),
  )
}

onUsageRecords((records) => {
  const batch = new Map<string, KeyStatus>()
  for (const r of records) {
    if (r.auth_type !== 'apikey' || !r.auth_index) continue
    const s = batch.get(r.auth_index) ?? { okAt: 0, outAt: 0, outError: '', limits: {}, limitsAt: 0 }
    batch.set(r.auth_index, s)
    const at = (Date.parse(r.timestamp) || Date.now()) + Math.round(r.latency_ms ?? 0)
    if (!r.failed) s.okAt = Math.max(s.okAt, at)
    else if (NO_CREDITS.test(r.fail?.body ?? '') && at > s.outAt) {
      s.outAt = at
      s.outError = errorMessage(r.fail?.body ?? '')
    }
    const limits: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.response_headers ?? {})) {
      const name = k.toLowerCase()
      if (RATE_HEADER.test(name) && v.length) limits[name] = v[v.length - 1]
    }
    if (Object.keys(limits).length && at > s.limitsAt) {
      s.limits = limits
      s.limitsAt = at
    }
  }
  for (const [index, s] of batch) saveStatus.run(index, s.okAt, s.outAt, s.outError, JSON.stringify(s.limits), s.limitsAt)
})

/** The provider's message out of an error body, which is usually JSON. */
function errorMessage(body: string) {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const msg = typeof parsed.error === 'object' ? parsed.error?.message : (parsed.message ?? parsed.error)
    if (msg) return String(msg).slice(0, 500)
  } catch {
    // Not JSON: the body itself.
  }
  return body.slice(0, 500)
}

/** Out of credits: turned away for it after its last success and after the user last entered a balance. */
const outOfCredits = (s: KeyStatus | undefined, mark: ApiKeyMark | undefined) => !!s && s.outAt > Math.max(s.okAt, mark?.creditsAt ?? mark?.balanceAt ?? 0)

// --- Config ------------------------------------------------------------------------------------

interface Key {
  'api-key': string
  auth_index?: string
  [k: string]: unknown
}
interface Group {
  priority?: number | null
  'excluded-models'?: string[] | null
  keys?: Key[]
  auth_index?: string
  [k: string]: unknown
}

/** The provider's list, and the config's ETag so a write can't overwrite a save made after this read. */
async function readGroups(provider: string) {
  const res = await management(`/config/api-keys/${provider}`)
  const etag = res?.headers.get('etag') ?? undefined
  // A provider without keys has no list.
  if (res?.status === 404) return { groups: [] as Group[], etag }
  if (!res?.ok) throw new Error(`could not read the ${provider} API keys${res ? ` (HTTP ${res.status})` : ''}`)
  return { groups: ((await res.json()) ?? []) as Group[], etag }
}

function withoutAuthIndex<T extends { auth_index?: string }>(o: T): T {
  const copy = { ...o }
  delete copy.auth_index
  return copy
}

/**
 * Replaces the provider's whole list, as the Providers page does (lists can't be patched by index).
 * With the ETag of the read, a save in between (say from the Providers page) makes CPA answer 412
 * instead of losing it: false then, and the next tick works from the new list.
 */
async function writeGroups(provider: string, groups: Group[], etag: string | undefined) {
  const body = groups.map((g) => ({ ...withoutAuthIndex(g), keys: (g.keys ?? []).map(withoutAuthIndex) }))
  const res = await management(`/config/api-keys/${provider}`, { method: 'PUT', body, headers: etag ? { 'If-Match': etag } : undefined })
  if (res?.status === 412) return false
  if (!res?.ok) throw new Error(`could not update the ${provider} API keys${res ? ` (HTTP ${res.status})` : ''}`)
  return true
}

const marks = () => readState().apiKeys ?? {}
const isFallback = (g: Group, m: Record<string, ApiKeyMark>) => (g.keys ?? []).some((k) => m[keyId(k['api-key'] ?? '')]?.fallback)
const excludesAll = (g: Group) => (g['excluded-models'] ?? []).some((p) => p.trim() === ALL_MODELS)
const withAll = (g: Group, on: boolean): Group => {
  const rest = (g['excluded-models'] ?? []).filter((p) => p.trim() !== ALL_MODELS)
  return { ...g, 'excluded-models': on ? [...rest, ALL_MODELS] : rest }
}

/** Ticks and the endpoints below each read and write whole lists, so they take turns. */
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

// --- Rotation ----------------------------------------------------------------------------------

export interface FallbackState {
  /** Fallback groups in rotation right now. */
  active: boolean
  /** The provider's accounts that can take requests. */
  available: number
  /** Accounts available, but for less than STABLE_MS: still active until then (ms). */
  until?: number
  /** Every fallback key of the provider has run out of credits. */
  outOfCredits: boolean
}

/** Per provider, from the last pass. */
let states: Record<string, FallbackState> = {}
/** Per provider: since when an account has been available. */
const availableSince = new Map<string, number>()
/** Failures that repeat every tick are logged once. */
const failing = new Set<string>()

type Listed = ListedCredential & { priority?: number }

export function applyFallback(files: Listed[], now = Date.now()) {
  return exclusive(async () => {
    const m = marks()
    // Only the lists that have a fallback; marks from before the provider was stored count for both.
    const marked = new Set(Object.values(m).flatMap((x) => (x.fallback ? (x.provider ? [x.provider] : PROVIDERS) : [])))
    if (!marked.size) {
      states = {}
      availableSince.clear()
      return
    }
    const status = statuses()
    const next: Record<string, FallbackState> = {}
    for (const provider of PROVIDERS) {
      if (!marked.has(provider)) {
        availableSince.delete(provider)
        continue
      }
      const accounts = files.filter((f) => f.provider === provider)
      const available = accounts.filter((f) => availability(f as PoolAccount, undefined, now).state === 'available').length
      if (available) availableSince.set(provider, availableSince.get(provider) ?? now)
      else availableSince.delete(provider)
      try {
        const { groups, etag } = await readGroups(provider)
        if (!groups.some((g) => isFallback(g, m))) {
          failing.delete(provider)
          continue
        }
        // Below every account, including disabled ones, so one enabled again is preferred at once.
        const priority = accounts.length ? Math.min(...accounts.map((f) => (typeof f.priority === 'number' ? f.priority : 0))) - 1 : undefined
        const settled = available > 0 && now - availableSince.get(provider)! >= STABLE_MS
        let changed = false
        const flips: string[] = []
        let active = false
        let allOut = true
        const updated = groups.map((g) => {
          if (!isFallback(g, m)) return g
          const out = (g.keys ?? []).length > 0 && (g.keys ?? []).every((k) => outOfCredits(status.get(k.auth_index ?? ''), m[keyId(k['api-key'] ?? '')]))
          if (!out) allOut = false
          // While accounts are back but not yet settled, a group already in rotation stays in.
          const on = !out && (available === 0 || (!settled && !excludesAll(g)))
          if (on) active = true
          let result = g
          if (excludesAll(g) === on) {
            result = withAll(result, !on)
            flips.push(`${on ? 'in rotation' : 'out of rotation'}${out ? ' (out of credits)' : on ? ' (no account available)' : ' (an account is available)'}`)
          }
          if (priority !== undefined && (g.priority ?? 0) !== priority) result = { ...result, priority }
          if (result !== g) changed = true
          return result
        })
        // Lost to a save in between: the next tick decides again from the new list.
        if (changed && (await writeGroups(provider, updated, etag))) for (const f of flips) console.log(`API key fallback: ${provider} ${f}`)
        next[provider] = {
          active,
          available,
          until: active && available ? availableSince.get(provider)! + STABLE_MS : undefined,
          outOfCredits: allOut,
        }
        failing.delete(provider)
      } catch (err) {
        if (!failing.has(provider)) console.error(`API key fallback: ${(err as Error).message}`)
        failing.add(provider)
        if (states[provider]) next[provider] = states[provider]
      }
    }
    states = next
  })
}

/** Marks or unmarks the groups holding these keys as fallback. Unmarking puts them back in rotation. */
export function setFallback(provider: string, apiKeys: string[], on: boolean) {
  return exclusive(async () => {
    const ids = new Set(apiKeys.map(keyId))
    const m = { ...marks() }
    for (const id of ids) m[id] = { ...m[id], fallback: on || undefined, provider: on ? provider : undefined }
    updateState({ apiKeys: prune(m) })
    if (on) return
    // A list saved in between is read again, so it is never written back stale.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { groups, etag } = await readGroups(provider)
      let changed = false
      const updated = groups.map((g) => {
        if (!excludesAll(g) || isFallback(g, m) || !(g.keys ?? []).some((k) => ids.has(keyId(k['api-key'] ?? '')))) return g
        changed = true
        return withAll(g, false)
      })
      if (!changed || (await writeGroups(provider, updated, etag))) return
    }
    throw new Error(`the ${provider} API keys kept changing; try again`)
  })
}

/** Sets or clears the credit balance of a key, as of now. */
export function setBalance(apiKey: string, balance: number | null) {
  const id = keyId(apiKey)
  const m = { ...marks() }
  const now = Date.now()
  m[id] = { ...m[id], balance: balance ?? undefined, balanceAt: balance == null ? undefined : now, creditsAt: balance == null ? m[id]?.creditsAt : now }
  updateState({ apiKeys: prune(m) })
}

const prune = (m: Record<string, ApiKeyMark>) =>
  Object.fromEntries(Object.entries(m).filter(([, v]) => v.fallback || v.balance !== undefined || v.creditsAt !== undefined))

// --- Status ------------------------------------------------------------------------------------

const DAY = 86_400_000

/** Anthropic and OpenAI rate-limit headers as one shape: per kind, its limit, what's left and when it resets. */
function rateLimits(h: Record<string, string>) {
  const out: Record<string, { limit?: number; remaining?: number; reset?: string }> = {}
  const set = (kind: string, field: 'limit' | 'remaining' | 'reset', v: string | undefined) => {
    if (v === undefined) return
    const entry = (out[kind] ??= {})
    if (field === 'reset') entry.reset = v
    else if (Number.isFinite(Number(v))) entry[field] = Number(v)
  }
  for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    for (const field of ['limit', 'remaining', 'reset'] as const) set(kind, field, h[`anthropic-ratelimit-${kind}-${field}`])
  }
  for (const kind of ['requests', 'tokens']) {
    for (const field of ['limit', 'remaining', 'reset'] as const) set(kind, field, h[`x-ratelimit-${field}-${kind}`])
  }
  return out
}

/** Every configured API key of every provider, by auth_index, with its spend, credits and limits. */
export async function apiKeyStatus(now = Date.now()) {
  const res = await management('/config/api-keys')
  if (!res?.ok) throw new Error(`could not read the API keys${res ? ` (HTTP ${res.status})` : ''}`)
  const all = ((await res.json()) ?? {}) as Record<string, Group[] | null>
  const m = marks()
  const status = statuses()
  const keys: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const [provider, groups] of Object.entries(all)) {
    for (const g of groups ?? []) {
      const fallback = isFallback(g, m)
      for (const k of g.keys ?? []) {
        const index = k.auth_index
        if (!index || !k['api-key']) continue
        const id = keyId(k['api-key'])
        seen.add(id)
        const mark = m[id]
        const s = status.get(index)
        const spend = apiKeySpend(index, { day: now - DAY, week: now - 7 * DAY, month: now - 30 * DAY, balance: mark?.balanceAt })
        keys[index] = {
          provider,
          fallback,
          inRotation: !excludesAll(g),
          spend,
          balance:
            mark?.balance !== undefined
              ? { set: mark.balance, at: mark.balanceAt, spent: spend.sinceBalance, left: mark.balance - spend.sinceBalance }
              : undefined,
          outOfCredits: outOfCredits(s, mark) ? { at: s!.outAt, error: s!.outError } : undefined,
          lastOkAt: s?.okAt || undefined,
          limits: s && Object.keys(s.limits).length ? { at: s.limitsAt, ...rateLimits(s.limits) } : undefined,
        }
      }
    }
  }
  // Keys removed from the config take their marks with them.
  if (Object.keys(m).some((id) => !seen.has(id))) updateState({ apiKeys: Object.fromEntries(Object.entries(m).filter(([id]) => seen.has(id))) })
  return { keys, fallback: states }
}
