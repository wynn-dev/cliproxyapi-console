import { RESERVE_WINDOWS, extraUsage, limitWindows, type LimitReading, type ReserveWindow } from './limit-windows.ts'
import type { ListedCredential } from './limits.ts'
import { management } from './management.ts'
import { readState, updateState } from './state.ts'
import { db } from './usage.ts'

/**
 * Account reserve: keeps a share of each subscription account's 5-hour and weekly limits for people
 * who use the account directly. CPA only moves off an account once upstream rejects it, so the
 * console disables an account once a window is down to its reserve, and enables it again when
 * that window resets.
 *
 * Only accounts the console disabled itself are tracked here. Enabling one by hand overrides the
 * reserve until the window that tripped it resets.
 *
 * An account billing its owner for paid extra usage is held the same way, until the limit that ran
 * out resets, except that enabling it by hand does not stick: the console disables it again.
 *
 * Accounts that need a new sign-in are held in the same table (see sign-in.ts), and so is the
 * account released when every account is held back (see release.ts).
 */

/** Percent kept back of each window; `fable` is held per model (see fable.ts), not per account. */
export type ReserveLimits = Record<ReserveWindow | 'fable', number>
/** Why the console holds an account back. */
export type HoldReason = 'reserve' | 'extra-usage' | 'signed-out'

const DEFAULT_LIMITS: ReserveLimits = { '5h': 5, weekly: 5, fable: 5 }
const PROVIDERS = new Set(['claude', 'codex'])

db.exec(`CREATE TABLE IF NOT EXISTS reserve (
  name TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  windows TEXT NOT NULL,
  overridden INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0
)`)
const columns = new Set((db.prepare('PRAGMA table_info(reserve)').all() as { name: string }[]).map((c) => c.name))
if (!columns.has('reason')) db.exec("ALTER TABLE reserve ADD COLUMN reason TEXT NOT NULL DEFAULT 'reserve'")
if (!columns.has('released')) db.exec('ALTER TABLE reserve ADD COLUMN released INTEGER NOT NULL DEFAULT 0')
if (!columns.has('detail')) db.exec("ALTER TABLE reserve ADD COLUMN detail TEXT NOT NULL DEFAULT ''")
if (!columns.has('held_at')) db.exec('ALTER TABLE reserve ADD COLUMN held_at INTEGER')

export interface Row {
  name: string
  /** When the windows below their reserve reset (ms). */
  until: number
  /** Reserve windows below their reserve, or for extra usage the labels of the limits that ran out. */
  windows: string[]
  /** Enabled by hand while reserved: left alone until `until`. Never set for extra usage. */
  overridden: boolean
  /** Asked CPA to disable it but not yet seen disabled. */
  pending: boolean
  reason: HoldReason
  /** Overridden by the console itself because every account was held back. */
  released?: boolean
  /** Why it needs a new sign-in: the error the provider gave. */
  detail?: string
  /** When a sign-in hold began (ms): a token refresh after it ends the hold. */
  heldAt?: number
}

export function rows() {
  const all = db.prepare('SELECT name, until, windows, overridden, pending, reason, released, detail, held_at FROM reserve').all() as
    { name: string; until: number; windows: string; overridden: number; pending: number; reason: HoldReason; released: number; detail: string; held_at: number | null }[]
  return new Map<string, Row>(
    all.map((r) => [
      r.name,
      { ...r, windows: JSON.parse(r.windows) as string[], overridden: !!r.overridden, pending: !!r.pending, released: !!r.released, heldAt: r.held_at ?? undefined },
    ]),
  )
}

const save = db.prepare(`
  INSERT INTO reserve (name, until, windows, overridden, pending, reason, released, detail, held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET until = excluded.until, windows = excluded.windows, overridden = excluded.overridden,
    pending = excluded.pending, reason = excluded.reason, released = excluded.released, detail = excluded.detail, held_at = excluded.held_at`)
export const saveRow = (r: Row) =>
  save.run(r.name, r.until, JSON.stringify(r.windows), r.overridden ? 1 : 0, r.pending ? 1 : 0, r.reason, r.released ? 1 : 0, r.detail ?? '', r.heldAt ?? null)
const remove = db.prepare('DELETE FROM reserve WHERE name = ?')
export const removeRow = (name: string) => remove.run(name)

export const reserveLimits = (): ReserveLimits => ({ ...DEFAULT_LIMITS, ...readState().reserve })

export function setReserveLimits(patch: Partial<ReserveLimits>) {
  updateState({ reserve: { ...reserveLimits(), ...patch } })
}

/** Whether accounts that start billing paid extra usage are held back. On unless turned off. */
export const holdsExtraUsage = () => readState().holdExtraUsage !== false

export function setHoldExtraUsage(on: boolean) {
  updateState({ holdExtraUsage: on })
}

/** When every account of a provider is held back, release the reserved one with the most left. Off unless true. */
export const releasesWhenAllHeld = () => readState().releaseWhenAllHeld === true

export function setReleaseWhenAllHeld(on: boolean) {
  updateState({ releaseWhenAllHeld: on })
}

/** Accounts the reserve holds back, or that were enabled by hand while held back, by file name. */
export function reserveStatus() {
  return {
    limits: reserveLimits(),
    extraUsage: holdsExtraUsage(),
    releaseWhenAllHeld: releasesWhenAllHeld(),
    accounts: Object.fromEntries(
      [...rows().values()].map((r) => [
        r.name,
        { until: r.until, windows: r.windows, overridden: r.overridden, reason: r.reason, released: r.released, detail: r.detail || undefined },
      ]),
    ),
  }
}

/**
 * The windows of an account at or below their reserve and when the last of them resets, plus every
 * reserved window the reading covers at all.
 */
export function shortfall(provider: string, reading: LimitReading | undefined, limits: ReserveLimits, now: number) {
  const windows: string[] = []
  const seen = new Set<ReserveWindow>()
  let until = 0
  for (const w of limitWindows(provider, reading, now)) {
    const id = RESERVE_WINDOWS[w.label]
    // Without a reset time the account could never be enabled again.
    if (!id || !limits[id] || w.resetsAt === undefined) continue
    seen.add(id)
    if (w.left > limits[id] / 100 + 1e-9) continue
    windows.push(id)
    until = Math.max(until, w.resetsAt)
  }
  return { short: windows.length ? { windows, until } : undefined, seen }
}

export async function setDisabled(name: string, disabled: boolean, why = '', who = 'Account reserve') {
  const res = await management('/credentials/status', { method: 'PATCH', body: { name, disabled } })
  if (!res?.ok) throw new Error(`could not ${disabled ? 'disable' : 'enable'} ${name}${res ? ` (HTTP ${res.status})` : ''}`)
  console.log(`${who}: ${disabled ? 'disabled' : 'enabled'} ${name}${why}`)
}

/** Accounts whose last update failed, so a failure that repeats every tick is logged once. */
const failing = new Set<string>()

/** Brings each account's enabled state in line with the reserve. `files` is CPA's full credential list. */
export async function applyReserve(files: ListedCredential[], readings: Record<string, LimitReading>, now = Date.now()) {
  const limits = reserveLimits()
  const extra = holdsExtraUsage()
  const tracked = rows()
  for (const f of files) {
    const row = tracked.get(f.name)
    tracked.delete(f.name)
    // Needs a new sign-in: held by sign-in.ts until then, whatever its limits say.
    if (row?.reason === 'signed-out') continue
    if (!f.provider || !PROVIDERS.has(f.provider)) continue
    try {
      const billing = extra ? (extraUsage(f.provider, readings[f.name], now) ?? heldForExtraUsage(row, now)) : undefined
      if (billing) await holdExtraUsage(f, row, billing)
      else {
        // An extra-usage hold that ended, or was turned off, is released unless the reserve still applies.
        const held = row?.reason === 'extra-usage' ? { ...row, reason: 'reserve' as const, windows: [] } : row
        await applyOne(f, held, shortfall(f.provider, readings[f.name], limits, now), limits, now)
      }
      failing.delete(f.name)
    } catch (err) {
      // Retried next tick; other accounts still get their turn.
      if (!failing.has(f.name)) console.error(`Account reserve: ${(err as Error).message}`)
      failing.add(f.name)
    }
  }
  // Credentials no longer listed (deleted, or briefly missing): forget them once their windows reset,
  // or for a needed sign-in (no reset) once they have been gone a while.
  for (const row of tracked.values()) {
    const since = missingSince.get(row.name) ?? now
    missingSince.set(row.name, since)
    if (row.reason === 'signed-out' ? now - since >= FORGET_AFTER_MS : now >= row.until) {
      removeRow(row.name)
      missingSince.delete(row.name)
    }
  }
  for (const name of missingSince.keys()) if (!tracked.has(name)) missingSince.delete(name)
}

/** How long a signed-out account may be missing from CPA's list before it is forgotten. */
const FORGET_AFTER_MS = 10 * 60_000
/** First-seen time of held accounts missing from CPA's list. */
const missingSince = new Map<string, number>()

/**
 * A held account gets no new readings, and one still in flight can come back without the overage
 * headers; neither means the limit has reset. So the hold lasts until `until`.
 */
function heldForExtraUsage(row: Row | undefined, now: number) {
  return row?.reason === 'extra-usage' && now < row.until ? { until: row.until, windows: row.windows } : undefined
}

async function holdExtraUsage(f: ListedCredential, row: Row | undefined, billing: { until: number; windows: string[] }) {
  const held: Row = { name: f.name, ...billing, overridden: false, pending: false, reason: 'extra-usage' }
  if (!f.disabled) {
    // Also when enabled by hand: the owner pays for every request it serves.
    saveRow({ ...held, pending: true })
    const again = row?.reason === 'extra-usage' && !row.pending ? ' again' : ''
    await setDisabled(f.name, true, `${again}: it is using paid extra usage`)
    saveRow(held)
  } else if (row && !row.overridden && (row.reason !== 'extra-usage' || row.pending || row.until !== held.until || row.windows.join() !== held.windows.join())) {
    saveRow(held)
  }
  // Disabled by the user, untracked or after overriding the reserve: theirs to enable, and held once they do.
}

async function applyOne(f: ListedCredential, row: Row | undefined, { short, seen }: ReturnType<typeof shortfall>, limits: ReserveLimits, now: number) {
  if (row?.overridden) {
    if (now < row.until) return
    removeRow(f.name)
    row = undefined
  }
  if (short) {
    if (row && !row.pending && !f.disabled) {
      // Enabled by hand while reserved.
      saveRow({ name: f.name, ...short, overridden: true, pending: false, reason: 'reserve' })
    } else if (row?.pending || (!row && !f.disabled)) {
      // Saved first, so a disable CPA applies but reports as failed is still ours.
      saveRow({ name: f.name, ...short, overridden: false, pending: true, reason: 'reserve' })
      if (!f.disabled) await setDisabled(f.name, true)
      saveRow({ name: f.name, ...short, overridden: false, pending: false, reason: 'reserve' })
    } else if (row && (row.until !== short.until || row.windows.join() !== short.windows.join() || row.reason !== 'reserve')) {
      saveRow({ ...row, ...short, reason: 'reserve' })
    }
    // Disabled by the user: theirs to enable.
    return
  }
  if (!row) return
  // A response can carry rate-limit headers without a window's utilization; that is no sign the
  // window recovered. Hold the account until each window that tripped shows up above its reserve,
  // its reserve is turned off, or it resets.
  if (now < row.until && row.windows.some((id) => limits[id as ReserveWindow] && !seen.has(id as ReserveWindow))) return
  if (f.disabled) await setDisabled(f.name, false)
  removeRow(f.name)
}
