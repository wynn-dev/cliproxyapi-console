import { db } from './usage.ts'

/**
 * Limit resets: Claude lets some subscription accounts clear their 5-hour limit once a week, which
 * Claude Code offers when that limit is reached. What is used after a reset still counts toward
 * the weekly limit. This keeps what the provider last said about each account's reset; asking and
 * using one go through CPA like limit checks do (limit-checks.ts). A reset is only ever used when
 * the user asks for it.
 *
 * Undocumented, like the usage endpoint: read from Claude Code, which names the program
 * `juniper_tide`.
 */

db.exec(`CREATE TABLE IF NOT EXISTS limit_resets (
  name TEXT PRIMARY KEY,
  read_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  next_available_at INTEGER,
  reason TEXT NOT NULL DEFAULT ''
)`)

export interface ResetStatus {
  /** When the provider said so (ms). */
  readAt: number
  /** `used`: this week's reset is spent. `not-offered`: the provider gives this account none. */
  state: 'available' | 'used' | 'not-offered'
  /** When a used reset is available again (ms), if the provider said. */
  nextAvailableAt?: number
  /** Why the account is not offered a reset, in the provider's own word (`tier`, `tenure`…). */
  reason?: string
}

const save = db.prepare(`
  INSERT INTO limit_resets (name, read_at, state, next_available_at, reason) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET read_at = excluded.read_at, state = excluded.state,
    next_available_at = excluded.next_available_at, reason = excluded.reason`)
const remove = db.prepare('DELETE FROM limit_resets WHERE name = ?')

export const saveReset = (name: string, s: ResetStatus) => save.run(name, s.readAt, s.state, s.nextAvailableAt ?? null, s.reason ?? '')
export const forgetReset = (name: string) => remove.run(name)

/** What the provider last said about each account's limit reset, by credential file name. */
export function limitResets(): Record<string, ResetStatus> {
  const rows = db.prepare('SELECT * FROM limit_resets').all() as { name: string; read_at: number; state: ResetStatus['state']; next_available_at: number | null; reason: string }[]
  return Object.fromEntries(
    rows.map((r) => [r.name, { readAt: r.read_at, state: r.state, nextAvailableAt: r.next_available_at ?? undefined, reason: r.reason || undefined }]),
  )
}

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)

/** A time the provider sent (ISO), in ms, when it is one. */
function time(v: unknown) {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * The `juniper_tide` block of a usage response as a status, read the way Claude Code reads it: a
 * reset is on offer when `arm` is `reset` and `available` is true, and used when it is not available
 * but has a `next_available_at`; anything else is an account the provider offers none. Undefined
 * when the block is missing, malformed, or only says the account is not at its limit, which tells
 * nothing about the reset.
 */
export function resetStatus(block: unknown, now: number): ResetStatus | undefined {
  const b = obj(block)
  if (!b || typeof b.eligible !== 'boolean' || b.ineligible_reason === 'not_at_wall') return undefined
  if (b.arm !== 'reset') return { readAt: now, state: 'not-offered', reason: typeof b.ineligible_reason === 'string' ? b.ineligible_reason : undefined }
  if (b.available === true) return { readAt: now, state: 'available' }
  const nextAvailableAt = time(b.next_available_at)
  return nextAvailableAt ? { readAt: now, state: 'used', nextAvailableAt } : { readAt: now, state: 'not-offered' }
}

export interface ResetOutcome {
  ok: boolean
  /** What happened, in plain words. */
  message: string
  /** The account's reset status after this answer, when the answer says. */
  status?: ResetStatus
}

/** The provider's answer to using a reset, in plain words. */
export function resetOutcome(httpStatus: number, body: string, now: number): ResetOutcome {
  if (httpStatus === 401 || httpStatus === 403) return { ok: false, message: `The provider refused this account's sign-in (HTTP ${httpStatus}). Sign in again, then try again.` }
  if (httpStatus === 429) return { ok: false, message: 'The provider is getting too many requests from this account. Try again in a moment.' }
  let b: Record<string, unknown> | undefined
  try {
    b = obj(JSON.parse(body))
  } catch {
    // Not JSON: told apart by the status below.
  }
  if (httpStatus < 200 || httpStatus > 299) {
    const e = b?.error
    const detail = typeof e === 'string' ? e : (obj(e)?.message ?? b?.message)
    return { ok: false, message: `The provider answered HTTP ${httpStatus}${typeof detail === 'string' && detail.trim() ? `: ${detail.trim().slice(0, 200)}` : ''}. The limit was not reset.` }
  }
  const nextAvailableAt = time(b?.next_available_at)
  switch (b?.result) {
    case 'reset':
      return { ok: true, message: 'The 5-hour limit was reset. The weekly limit still applies.', status: { readAt: now, state: 'used', nextAvailableAt } }
    case 'not_limited':
      return { ok: false, message: 'The 5-hour limit was not in effect, so there was nothing to reset.' }
    case 'already_used':
      return { ok: false, message: "This week's reset was already used. The limit was not reset.", status: { readAt: now, state: 'used', nextAvailableAt } }
    case 'ineligible':
      return { ok: false, message: 'The provider does not offer this account a limit reset right now. The limit was not reset.', status: { readAt: now, state: 'not-offered' } }
    case 'unavailable':
      return { ok: false, message: 'The provider could not reset the limit right now. Try again in a moment.' }
    default:
      return { ok: false, message: 'The provider sent an answer the console could not read. Check the 5-hour limit before trying again.' }
  }
}
