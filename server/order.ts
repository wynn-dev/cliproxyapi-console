import { readCpaConfig } from './cpa-config.ts'
import { RESERVE_WINDOWS, limitWindows, type LimitReading, type ReserveWindow } from './limit-windows.ts'
import type { ListedCredential } from './limits.ts'
import { management } from './management.ts'
import { reserveLimits, reserveStatus, type ReserveLimits } from './reserve.ts'
import { readState, updateState } from './state.ts'
import { db } from './usage.ts'

/**
 * Smart account order: sets each enabled Claude and Codex account's priority so that, within each
 * group of accounts the user gave the same priority, fill-first uses the weekly capacity that
 * expires soonest first, and accounts close to their reserve stop taking new conversations. CPA's
 * session affinity spans priority tiers, so a conversation already on an account stays there when it
 * drops and keeps its prompt cache.
 *
 * Each account's own priority is saved before the first rewrite, stays the first sort key, and is
 * put back when the feature is turned off.
 */

const PROVIDERS = ['claude', 'codex']
/** Points above the reserve at which a window stops its account taking new conversations, and must be back above to release it. */
const HOLD_MARGIN = 3
const RELEASE_MARGIN = 5
/** Resets closer than this keep their current order, so a reset time that drifts between readings doesn't swap accounts. */
const RESET_SLACK_MS = 3_600_000
/** How long an account may be missing from CPA's list before its saved priority is forgotten. */
const FORGET_AFTER_MS = 10 * 60_000

export type OrderTier = 'first' | 'unknown' | 'held'

export interface OrderPlacement {
  tier: OrderTier
  /** 1-based position among the provider's enabled accounts. */
  rank: number
  of: number
  /** When the weekly limit resets (ms), if known. */
  weeklyResetsAt?: number
  /** For `held`: the windows close to their reserve, and when the last of them resets (ms). */
  windows?: ReserveWindow[]
  releaseAt?: number
  /** The account's own priority, the first sort key; restored when the feature is off. */
  original: number
  /** The priority the console gives it in CPA. */
  effective: number
}

db.exec(`CREATE TABLE IF NOT EXISTS account_order (
  name TEXT PRIMARY KEY,
  original INTEGER NOT NULL,
  priority INTEGER,
  previous INTEGER,
  pending INTEGER NOT NULL DEFAULT 0,
  held TEXT NOT NULL DEFAULT '[]'
)`)

interface Row {
  name: string
  /** The account's own priority. */
  original: number
  /** The priority the console last set, or null before its first write. */
  priority: number | null
  /** The one it set before that: CPA can put it back when a concurrent PATCH lands on a stale copy. */
  previous: number | null
  /** Asked CPA to set `priority` but not yet seen it applied. */
  pending: boolean
  /** Windows holding the account back; each is released only once clear of RELEASE_MARGIN. */
  held: ReserveWindow[]
}

function rows() {
  const all = db.prepare('SELECT name, original, priority, previous, pending, held FROM account_order').all() as
    { name: string; original: number; priority: number | null; previous: number | null; pending: number; held: string }[]
  return new Map<string, Row>(all.map((r) => [r.name, { ...r, pending: !!r.pending, held: JSON.parse(r.held) as ReserveWindow[] }]))
}

const save = db.prepare(`
  INSERT INTO account_order (name, original, priority, previous, pending, held) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET original = excluded.original, priority = excluded.priority, previous = excluded.previous,
    pending = excluded.pending, held = excluded.held`)
const saveRow = (r: Row) => save.run(r.name, r.original, r.priority, r.previous, r.pending ? 1 : 0, JSON.stringify(r.held))
const removeRow = db.prepare('DELETE FROM account_order WHERE name = ?')

export const orderEnabled = () => readState().smartOrder !== false

/** Priority only decides the order under fill-first; under round robin, distinct priorities would stop the rotation. */
const orderActive = () => orderEnabled() && readCpaConfig()?.strategy === 'fill-first'

export function setOrderEnabled(on: boolean) {
  updateState({ smartOrder: on })
}

/** Saves an account's own priority while the console manages the effective one; the next pass applies it. */
export function setOwnPriority(name: string, priority: number) {
  const row = rows().get(name)
  saveRow(row ? { ...row, original: priority } : { name, original: priority, priority: null, previous: null, pending: false, held: [] })
}

/** Where the last pass put each enabled account, by file name. */
let placements: Record<string, OrderPlacement> = {}

export function orderStatus() {
  const cfg = readCpaConfig()
  const active = orderActive()
  return {
    enabled: orderEnabled(),
    active,
    strategy: cfg?.strategy ?? null,
    affinity: cfg?.sessionAffinity ?? false,
    accounts: active ? placements : {},
    /** Each managed account's own priority, by file name. */
    own: active ? Object.fromEntries([...rows().values()].map((r) => [r.name, r.original])) : {},
  }
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

/** Tier of an account. Each window is held at HOLD_MARGIN and released past RELEASE_MARGIN, on its own. */
function place(provider: string, reading: LimitReading | undefined, held: ReserveWindow[], overridden: boolean, limits: ReserveLimits, now: number) {
  const windows: ReserveWindow[] = []
  let weeklyResetsAt: number | undefined
  let releaseAt: number | undefined
  for (const w of limitWindows(provider, reading, now)) {
    const id = RESERVE_WINDOWS[w.label]
    if (!id) continue
    if (id === 'weekly') weeklyResetsAt = w.resetsAt
    // Enabled by hand while reserved: the user wants it used.
    if (overridden) continue
    if (w.left * 100 > limits[id] + (held.includes(id) ? RELEASE_MARGIN : HOLD_MARGIN) + 1e-9) continue
    windows.push(id)
    if (w.resetsAt !== undefined) releaseAt = Math.max(releaseAt ?? 0, w.resetsAt)
  }
  if (windows.length) return { tier: 'held' as const, windows, weeklyResetsAt, releaseAt }
  // A week that has reset (or never started) keeps its full capacity until a week after its next use.
  return { tier: weeklyResetsAt === undefined ? ('unknown' as const) : ('first' as const), weeklyResetsAt }
}

type Ranked = { f: Listed; row: Row; current: number; p: ReturnType<typeof place> }

/** Held accounts last, then the user's own priority, then accounts with a weekly reading before those without. */
const group = (a: Ranked) => [a.p.tier === 'held' ? 1 : 0, -a.row.original, a.p.tier === 'unknown' ? 1 : 0]
/** Within a group: earliest weekly reset first, or for held accounts, the soonest release. */
const resetKey = (a: Ranked) => (a.p.tier === 'held' ? a.p.releaseAt : a.p.weeklyResetsAt)
const sameGroup = (a: Ranked, b: Ranked) => group(a).every((v, i) => v === group(b)[i])
const byName = (a: Ranked, b: Ranked) => (a.f.name < b.f.name ? -1 : a.f.name > b.f.name ? 1 : 0)

function rank(accounts: Ranked[]) {
  accounts.sort((a, b) => {
    const ga = group(a)
    const gb = group(b)
    for (let i = 0; i < ga.length; i++) if (ga[i] !== gb[i]) return ga[i] - gb[i]
    const ka = resetKey(a)
    const kb = resetKey(b)
    if (ka === undefined || kb === undefined) return (ka === undefined ? 1 : 0) - (kb === undefined ? 1 : 0) || byName(a, b)
    // Start from the current order (new accounts after it), then by reset.
    const pa = a.row.priority ?? -Infinity
    const pb = b.row.priority ?? -Infinity
    return (pa !== pb ? pb - pa : 0) || ka - kb || byName(a, b)
  })
  // Move an account ahead only if it resets more than RESET_SLACK_MS sooner: each swap removes one
  // such inversion, so this ends.
  for (let swapped = true; swapped; ) {
    swapped = false
    for (let i = 0; i + 1 < accounts.length; i++) {
      const [a, b] = [accounts[i], accounts[i + 1]]
      const ka = resetKey(a)
      const kb = resetKey(b)
      if (ka === undefined || kb === undefined || !sameGroup(a, b) || kb >= ka - RESET_SLACK_MS) continue
      ;[accounts[i], accounts[i + 1]] = [b, a]
      swapped = true
    }
  }
  return accounts
}

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
  const overrides = reserveStatus().accounts
  const next: Record<string, OrderPlacement> = {}
  for (const provider of PROVIDERS) {
    // Disabled accounts (by the user or the reserve) take no traffic, so they keep whatever they have.
    const accounts = files.filter((f) => f.provider === provider && !f.disabled).map((f): Ranked => {
      const current = listedPriority(f)
      let row = tracked.get(f.name)
      if (!row) {
        // Saved before the first rewrite.
        row = { name: f.name, original: current, priority: null, previous: null, pending: false, held: [] }
        saveRow(row)
      } else if (!row.pending && row.priority !== null && current !== row.priority && current !== row.previous) {
        // Changed outside the console's order: that is the account's own priority from now on.
        row = { ...row, original: current }
        saveRow(row)
      }
      const p = place(provider, readings[f.name], row.held, !!overrides[f.name]?.overridden, limits, now)
      const held = p.tier === 'held' ? p.windows : []
      if (held.join() !== row.held.join()) {
        row = { ...row, held }
        saveRow(row)
      }
      return { f, row, current, p }
    })
    if (!accounts.length) continue

    // Counted up from the lowest own priority, so accounts stay above a fallback the user put below them (e.g. an API key at -1).
    const base = Math.min(...accounts.map((a) => a.row.original))
    const ranked = rank(accounts)
    for (const [i, { f, row, current, p }] of ranked.entries()) {
      const priority = base + ranked.length - 1 - i
      next[f.name] = { ...p, rank: i + 1, of: ranked.length, original: row.original, effective: priority }
      if (current === priority && row.priority === priority && !row.pending) continue
      await attempt(f.name, async () => {
        const previous = row.priority === priority ? row.previous : row.priority
        if (current === priority) {
          saveRow({ ...row, priority, previous, pending: false })
          return
        }
        // Saved first, so a write CPA applies but reports as failed isn't taken for the user's own edit.
        saveRow({ ...row, priority, previous, pending: true })
        await setPriority(f.name, priority)
        saveRow({ ...row, priority, previous, pending: false })
        console.log(`Account order: ${f.name} priority ${current} → ${priority} (${p.tier})`)
      })
    }
  }
  placements = next
}
