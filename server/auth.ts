import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { readCpaConfig } from './cpa-config.ts'
import { readState, updateState } from './state.ts'

const MAX_FAILURES = 5
const BAN_MS = 15 * 60_000

const failures = new Map<string, { count: number; since: number; bannedUntil: number }>()
// bcrypt is deliberately slow; remember keys already verified against the current hash.
const verified = new Map<string, string>()

export type AuthResult = { ok: true } | { ok: false; status: 401 | 403 | 503; error: string }

function matches(key: string, secret: string) {
  if (!secret) return false
  if (secret.startsWith('$2')) {
    if (verified.get(key) === secret) return true
    const ok = bcrypt.compareSync(key, secret)
    if (ok) verified.set(key, secret)
    return ok
  }
  const a = Buffer.from(key)
  const b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Verifies a management key against CPA's config.yaml. The console checks the key itself so
 * that wrong keys never reach CPA, whose lockout would otherwise ban localhost (= the console).
 */
export function authenticate(ip: string, key: string | undefined): AuthResult {
  const entry = failures.get(ip)
  if (entry && entry.bannedUntil > Date.now()) {
    const mins = Math.ceil((entry.bannedUntil - Date.now()) / 60_000)
    return { ok: false, status: 403, error: `Too many failed attempts. Try again in ${mins} min.` }
  }
  const cfg = readCpaConfig()
  if (!cfg?.secretKey) return { ok: false, status: 503, error: 'Console is not set up yet' }
  if (key && matches(key, cfg.secretKey)) {
    failures.delete(ip)
    // Keep the console's own copy of the key current (e.g. after it was rotated in config.yaml).
    if (readState().managementKey !== key) updateState({ managementKey: key })
    return { ok: true }
  }
  // Failures are counted within a sliding window, so occasional typos never add up to a ban.
  const fresh = entry && !entry.bannedUntil && Date.now() - entry.since < BAN_MS
  const count = (fresh ? entry.count : 0) + 1
  failures.set(ip, {
    count,
    since: fresh ? entry.since : Date.now(),
    bannedUntil: count >= MAX_FAILURES ? Date.now() + BAN_MS : 0,
  })
  return { ok: false, status: 401, error: key ? 'Invalid management key' : 'Missing management key' }
}

/** Whether a key (e.g. the console's stored copy) is the management key currently in config.yaml. */
export function keyMatchesConfig(key: string | undefined) {
  const secret = readCpaConfig()?.secretKey
  return !!key && !!secret && matches(key, secret)
}

export function extractKey(headers: Headers) {
  const auth = headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return headers.get('x-management-key')?.trim() || undefined
}
