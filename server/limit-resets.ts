import { db } from './usage.ts'

/**
 * Limit resets: Claude lets some subscription accounts clear their 5-hour limit once a week, which
 * Claude Code offers when that limit is reached. What is used after a reset still counts toward
 * the weekly limit. This keeps what the provider last said about each account's reset; asking and
 * using one go through CPA like limit checks do (limit-checks.ts). A reset is only ever used when
 * the user asks for it.
 *
 * A second kind, the Fable reset, clears the Fable limit and gives what Fable used that week back to
 * the weekly limit. It is not weekly: the provider grants an account a number of them, to use by a
 * date.
 *
 * Undocumented, like the usage endpoint: read from Claude Code, which names the 5-hour reset's
 * program `juniper_tide`, and `cedar_ember` the one whose grants include the Fable reset.
 */

export type ResetKind = '5h' | 'fable'

// Before the Fable reset there was one row per account, the 5-hour reset's.
const before = (db.prepare('PRAGMA table_info(limit_resets)').all() as { name: string }[]).map((c) => c.name)
const single = before.length > 0 && !before.includes('kind')
if (single) db.exec('ALTER TABLE limit_resets RENAME TO limit_resets_single')
db.exec(`CREATE TABLE IF NOT EXISTS limit_resets (
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  next_available_at INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  resets_left INTEGER,
  ends_at INTEGER,
  PRIMARY KEY (name, kind)
)`)
if (single) {
  db.exec(`INSERT INTO limit_resets (name, kind, read_at, state, next_available_at, reason)
    SELECT name, '5h', read_at, state, next_available_at, reason FROM limit_resets_single;
    DROP TABLE limit_resets_single`)
}

export interface ResetStatus {
  /** When the provider said so (ms). */
  readAt: number
  /** `used`: this week's reset is spent, or no Fable reset is left. `not-offered`: the provider gives this account none. */
  state: 'available' | 'used' | 'not-offered'
  /** When a used reset is available again (ms), if the provider said. */
  nextAvailableAt?: number
  /** Why the account is not offered a reset, in the provider's own word (`tier`, `tenure`…). */
  reason?: string
  /** Fable resets left to use. */
  left?: number
  /** When the Fable resets that are left expire (ms), if the provider said. */
  endsAt?: number
}

const save = db.prepare(`
  INSERT INTO limit_resets (name, kind, read_at, state, next_available_at, reason, resets_left, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (name, kind) DO UPDATE SET read_at = excluded.read_at, state = excluded.state,
    next_available_at = excluded.next_available_at, reason = excluded.reason, resets_left = excluded.resets_left, ends_at = excluded.ends_at`)
const remove = db.prepare('DELETE FROM limit_resets WHERE name = ?')

export const saveReset = (name: string, s: ResetStatus, kind: ResetKind = '5h') =>
  save.run(name, kind, s.readAt, s.state, s.nextAvailableAt ?? null, s.reason ?? '', s.left ?? null, s.endsAt ?? null)
export const forgetReset = (name: string) => remove.run(name)

/** What the provider last said about each account's limit reset of one kind, by credential file name. */
export function limitResets(kind: ResetKind = '5h'): Record<string, ResetStatus> {
  const rows = db.prepare('SELECT * FROM limit_resets WHERE kind = ?').all(kind) as {
    name: string
    read_at: number
    state: ResetStatus['state']
    next_available_at: number | null
    reason: string
    resets_left: number | null
    ends_at: number | null
  }[]
  return Object.fromEntries(
    rows.map((r) => [
      r.name,
      {
        readAt: r.read_at,
        state: r.state,
        nextAvailableAt: r.next_available_at ?? undefined,
        reason: r.reason || undefined,
        ...(kind === 'fable' && { left: r.resets_left ?? undefined, endsAt: r.ends_at ?? undefined }),
      },
    ]),
  )
}

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)

/** A time the provider sent (ISO), in ms, when it is one. */
function time(v: unknown) {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

/** A count the provider sent, when it is one. */
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)

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

/** A grant's id as Claude Code accepts it; it goes into the request that uses the grant. */
const GRANT_ID = /^[a-z0-9_-]{1,40}$/
/** The Fable limit, as a grant names the limits it clears. */
const FABLE_LIMIT = 'seven_day_overage_included'

/**
 * The `cedar_ember` block of a usage response as the status of the account's Fable reset, read the
 * way Claude Code reads it. The block lists the account's grants, each with the resets it has left;
 * a Fable reset is a grant that `gives_back_weekly`. `grantId` is the one a reset would use now, if
 * the provider says one can be used and it clears the Fable limit. An answer without the block
 * offers none. Undefined when the block is malformed or says the provider can't tell right now.
 */
export function fableResetStatus(block: unknown, now: number): (ResetStatus & { grantId?: string }) | undefined {
  if (block == null) return { readAt: now, state: 'not-offered' }
  const b = obj(block)
  if (!b || typeof b.eligible !== 'boolean' || b.ineligible_reason === 'unavailable') return undefined
  if (!b.eligible) return { readAt: now, state: 'not-offered', reason: typeof b.ineligible_reason === 'string' ? b.ineligible_reason : undefined }
  const grants = (Array.isArray(b.grants) ? b.grants.map(obj) : []).flatMap((g) =>
    g?.gives_back_weekly === true && typeof g.id === 'string' && GRANT_ID.test(g.id)
      ? [
          {
            id: g.id,
            left: count(g.resets_left) ?? 0,
            endsAt: time(g.ends_at),
            paused: g.paused === true,
            usable: g.usable_now === true && Array.isArray(g.clears) && g.clears.includes(FABLE_LIMIT),
          },
        ]
      : [],
  )
  if (!grants.length) return { readAt: now, state: 'not-offered' }
  const held = grants.filter((g) => g.left > 0 && !g.paused && (g.endsAt ?? Infinity) > now)
  if (!held.length) return { readAt: now, state: 'used' }
  const usable = held.find((g) => g.usable)
  return { readAt: now, state: 'available', left: held.reduce((sum, g) => sum + g.left, 0), endsAt: (usable ?? held[0]).endsAt, grantId: usable?.id }
}

export interface ResetOutcome {
  ok: boolean
  /** What happened, in plain words. */
  message: string
  /** The account's reset status after this answer, when the answer says. */
  status?: ResetStatus
  /** Whether the answer tells if the reset was used. When it doesn't, it may or may not have been. */
  settled?: boolean
}

/**
 * The provider's answer to using a reset, in plain words. For a Fable reset, `before` is the
 * account's status when it was asked for, and `retried` that the request repeats one whose answer
 * never came: `already_used` then means that one went through.
 */
export function resetOutcome(httpStatus: number, body: string, now: number, kind: ResetKind = '5h', before?: ResetStatus, retried = false): ResetOutcome {
  const fable = kind === 'fable'
  const limit = fable ? 'Fable limit' : '5-hour limit'
  if (httpStatus === 401 || httpStatus === 403) {
    return { ok: false, settled: true, message: `The provider refused this account's sign-in (HTTP ${httpStatus}). Sign in again, then try again.` }
  }
  if (httpStatus === 429) return { ok: false, settled: true, message: 'The provider is getting too many requests from this account. Try again in a moment.' }
  let b: Record<string, unknown> | undefined
  try {
    b = obj(JSON.parse(body))
  } catch {
    // Not JSON: told apart by the status below.
  }
  if (httpStatus < 200 || httpStatus > 299) {
    const e = b?.error
    const detail = typeof e === 'string' ? e : (obj(e)?.message ?? b?.message)
    return {
      ok: false,
      settled: false,
      message: `The provider answered HTTP ${httpStatus}${typeof detail === 'string' && detail.trim() ? `: ${detail.trim().slice(0, 200)}` : ''}. The limit was not reset.`,
    }
  }
  const nextAvailableAt = time(b?.next_available_at)
  /** The status once a reset is spent: the week's only 5-hour one, or one of the Fable resets the account had. */
  const spent = (): ResetStatus => {
    if (!fable) return { readAt: now, state: 'used', nextAvailableAt }
    const left = count(b?.resets_left) ?? Math.max(0, (before?.left ?? 1) - 1)
    return left ? { readAt: now, state: 'available', left, endsAt: before?.endsAt } : { readAt: now, state: 'used' }
  }
  switch (b?.result) {
    case 'reset':
      return {
        ok: true,
        settled: true,
        message: fable ? 'The Fable limit was reset. What Fable used this week is back in the weekly limit.' : 'The 5-hour limit was reset. The weekly limit still applies.',
        status: spent(),
      }
    case 'not_limited':
      return { ok: false, settled: true, message: `The ${limit} was not in effect, so there was nothing to reset.` }
    case 'already_used':
      if (fable && retried) return { ok: true, settled: true, message: 'The earlier try went through after all: the Fable limit was reset.', status: spent() }
      return {
        ok: false,
        settled: true,
        message: fable ? 'That Fable reset was already used. The limit was not reset.' : "This week's reset was already used. The limit was not reset.",
        status: spent(),
      }
    case 'ineligible':
      return {
        ok: false,
        settled: true,
        message: `The provider does not offer this account a ${fable ? 'Fable' : 'limit'} reset right now. The limit was not reset.`,
        status: { readAt: now, state: 'not-offered' },
      }
    case 'unavailable':
      return { ok: false, settled: false, message: 'The provider could not reset the limit right now. Try again in a moment.' }
    default:
      // Between two Fable resets the provider asks for a pause. One that follows a try without an answer may be that try going through.
      if (fable && b?.result === 'cooldown') {
        return { ok: false, settled: !retried, message: 'Another reset was just started on this account. Check the Fable limit in a minute before trying again.' }
      }
      return { ok: false, settled: false, message: `The provider sent an answer the console could not read. Check the ${limit} before trying again.` }
  }
}
