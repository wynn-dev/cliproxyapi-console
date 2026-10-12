import { readCpaConfig } from './cpa-config.ts'
import { RESERVE_WINDOWS, limitWindows, type LimitReading, type ReserveWindow } from './limit-windows.ts'
import type { ListedCredential } from './limits.ts'
import { management } from './management.ts'
import { reserveLimits, type ReserveLimits } from './reserve.ts'
import { readState, updateState } from './state.ts'
import { db } from './usage.ts'

/**
 * Smart account order: rewrites each Claude and Codex account's priority so fill-first uses the
 * weekly capacity that expires soonest first, and stops starting new conversations on accounts
 * close to their reserve. CPA's session affinity spans priority tiers, so a conversation already
 * on an account stays there when it drops and keeps its prompt cache.
 *
 * Each account's own priority is saved before the first rewrite, breaks ties, and is put back
 * when the feature is turned off.
 */

const PROVIDERS = ['claude', 'codex']
/** Points above the reserve at which an account stops taking new conversations, and must be back above to take them again. */
const HOLD_MARGIN = 3
const RELEASE_MARGIN = 5
const HOUR = 3_600_000
/** How long an account may be missing from CPA's list before its saved priority is forgotten. */
const FORGET_AFTER_MS = 10 * 60_000

export type OrderTier = 'first' | 'unknown' | 'held'

export interface OrderPlacement {
  tier: OrderTier
  /** 1-based position among the provider's accounts. */
  rank: number
  of: number
  /** For `first`: when the weekly limit resets (ms). */
  weeklyResetsAt?: number
  /** For `held`: the windows close to their reserve. */
  windows?: ReserveWindow[]
  /** The account's own priority, restored when the feature is off. */
  original: number
}

db.exec(`CREATE TABLE IF NOT EXISTS account_order (
  name TEXT PRIMARY KEY,
  original INTEGER NOT NULL,
  priority INTEGER,
  pending INTEGER NOT NULL DEFAULT 0,
  held INTEGER NOT NULL DEFAULT 0
)`)

interface Row {
  name: string
  /** The priority the account had before the console took it over. */
  original: number
  /** The priority the console last set, or null before its first write. */
  priority: number | null
  /** Asked CPA to set `priority` but not yet seen it applied. */
  pending: boolean
  /** Held back from new conversations; released only once clear of RELEASE_MARGIN. */
  held: boolean
}

function rows() {
  const all = db.prepare('SELECT name, original, priority, pending, held FROM account_order').all() as
    { name: string; original: number; priority: number | null; pending: number; held: number }[]
  return new Map<string, Row>(all.map((r) => [r.name, { ...r, pending: !!r.pending, held: !!r.held }]))
}

const save = db.prepare(`
  INSERT INTO account_order (name, original, priority, pending, held) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET original = excluded.original, priority = excluded.priority, pending = excluded.pending, held = excluded.held`)
const saveRow = (r: Row) => save.run(r.name, r.original, r.priority, r.pending ? 1 : 0, r.held ? 1 : 0)
const removeRow = db.prepare('DELETE FROM account_order WHERE name = ?')

export const orderEnabled = () => readState().smartOrder !== false

/** Priority only decides the order under fill-first; under round robin, distinct priorities would stop the rotation. */
const orderActive = () => orderEnabled() && readCpaConfig()?.strategy === 'fill-first'

export function setOrderEnabled(on: boolean) {
  updateState({ smartOrder: on })
}

/** Where the last pass put each account, by file name. */
let placements: Record<string, OrderPlacement> = {}

export function orderStatus() {
  const active = orderActive()
  return { enabled: orderEnabled(), active, strategy: readCpaConfig()?.strategy ?? null, accounts: active ? placements : {} }
}

/** First-seen time of accounts missing from CPA's list. */
const missingSince = new Map<string, number>()
/** Accounts whose last update failed, so a failure that repeats every tick is logged once. */
const failing = new Set<string>()

type Listed = ListedCredential & { priority?: number }

const listedPriority = (f: Listed) => (typeof f.priority === 'number' ? f.priority : 0)

async function setPriority(name: string, priority: number) {
  const res = await management('/credentials/fields', { method: 'PATCH', body: { name, priority } })
  if (!res?.ok) throw new Error(`could not set the priority of ${name}${res ? ` (HTTP ${res.status})` : ''}`)
}

async function attempt(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    failing.delete(name)
  } catch (err) {
    // Retried next tick; other accounts still get their turn.
    if (!failing.has(name)) console.error(`Account order: ${(err as Error).message}`)
    failing.add(name)
  }
}

function place(provider: string, reading: LimitReading | undefined, held: boolean, limits: ReserveLimits, now: number) {
  const windows: ReserveWindow[] = []
  let weeklyResetsAt: number | undefined
  for (const w of limitWindows(provider, reading, now)) {
    const id = RESERVE_WINDOWS[w.label]
    if (!id) continue
    if (w.left * 100 <= limits[id] + (held ? RELEASE_MARGIN : HOLD_MARGIN) + 1e-9) windows.push(id)
    if (id === 'weekly') weeklyResetsAt = w.resetsAt
  }
  if (windows.length) return { tier: 'held' as const, windows }
  // A week that has reset (or never started) has its full capacity until a week after its next use.
  return weeklyResetsAt === undefined ? { tier: 'unknown' as const } : { tier: 'first' as const, weeklyResetsAt }
}

const TIERS: OrderTier[] = ['first', 'unknown', 'held']

/** Brings each account's priority in line with the order. `files` is CPA's full credential list. */
export async function applyOrder(files: Listed[], readings: Record<string, LimitReading>, now = Date.now()) {
  const tracked = rows()
  const listed = new Set(files.map((f) => f.name))
  for (const name of tracked.keys()) {
    if (listed.has(name)) {
      missingSince.delete(name)
      continue
    }
    const since = missingSince.get(name) ?? now
    missingSince.set(name, since)
    // Deleted, or briefly missing: forget it once it has been gone a while.
    if (now - since >= FORGET_AFTER_MS) {
      removeRow.run(name)
      missingSince.delete(name)
    }
  }

  if (!orderActive()) {
    placements = {}
    for (const f of files) {
      const row = tracked.get(f.name)
      if (!row) continue
      await attempt(f.name, async () => {
        if (listedPriority(f) !== row.original) await setPriority(f.name, row.original)
        removeRow.run(f.name)
      })
    }
    return
  }

  const limits = reserveLimits()
  const next: Record<string, OrderPlacement> = {}
  for (const provider of PROVIDERS) {
    const accounts = files.filter((f) => f.provider === provider).map((f) => {
      const current = listedPriority(f)
      let row = tracked.get(f.name)
      if (!row) {
        // Saved before the first rewrite.
        row = { name: f.name, original: current, priority: null, pending: false, held: false }
        saveRow(row)
      } else if (!row.pending && row.priority !== null && current !== row.priority) {
        // Changed outside the console's order: that is the account's own priority from now on.
        row = { ...row, original: current }
        saveRow(row)
      }
      const p = place(provider, readings[f.name], row.held, limits, now)
      if (row.held !== (p.tier === 'held')) {
        row = { ...row, held: p.tier === 'held' }
        saveRow(row)
      }
      return { f, row, current, p }
    })

    // Earliest weekly reset first (to the hour, so a reset time that wobbles between readings
    // doesn't swap accounts), then the user's own order: priority, then file name as CPA does.
    accounts.sort(
      (a, b) =>
        TIERS.indexOf(a.p.tier) - TIERS.indexOf(b.p.tier) ||
        Math.round((a.p.weeklyResetsAt ?? 0) / HOUR) - Math.round((b.p.weeklyResetsAt ?? 0) / HOUR) ||
        b.row.original - a.row.original ||
        (a.f.name < b.f.name ? -1 : a.f.name > b.f.name ? 1 : 0),
    )

    for (const [i, { f, row, current, p }] of accounts.entries()) {
      const priority = accounts.length - i
      next[f.name] = { ...p, rank: i + 1, of: accounts.length, original: row.original }
      if (current === priority && row.priority === priority && !row.pending) continue
      await attempt(f.name, async () => {
        if (current === priority) {
          saveRow({ ...row, priority, pending: false })
          return
        }
        // Saved first, so a write CPA applies but reports as failed isn't taken for the user's own edit.
        saveRow({ ...row, priority, pending: true })
        await setPriority(f.name, priority)
        saveRow({ ...row, priority, pending: false })
        console.log(`Account order: ${f.name} priority ${current} → ${priority} (${p.tier})`)
      })
    }
  }
  placements = next
}
