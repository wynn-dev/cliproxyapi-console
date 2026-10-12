import { RESERVE_WINDOWS, limitWindows, type LimitReading, type ReserveWindow } from './limit-windows.ts'
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
 */

export type ReserveLimits = Record<ReserveWindow, number>

const DEFAULT_LIMITS: ReserveLimits = { '5h': 5, weekly: 5 }
const PROVIDERS = new Set(['claude', 'codex'])

db.exec(`CREATE TABLE IF NOT EXISTS reserve (
  name TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  windows TEXT NOT NULL,
  overridden INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0
)`)

interface Row {
  name: string
  /** When the windows below their reserve reset (ms). */
  until: number
  windows: ReserveWindow[]
  /** Enabled by hand while reserved: left alone until `until`. */
  overridden: boolean
  /** Asked CPA to disable it but not yet seen disabled. */
  pending: boolean
}

function rows() {
  const all = db.prepare('SELECT name, until, windows, overridden, pending FROM reserve').all() as
    { name: string; until: number; windows: string; overridden: number; pending: number }[]
  return new Map<string, Row>(all.map((r) => [r.name, { ...r, windows: JSON.parse(r.windows) as ReserveWindow[], overridden: !!r.overridden, pending: !!r.pending }]))
}

const save = db.prepare(`
  INSERT INTO reserve (name, until, windows, overridden, pending) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET until = excluded.until, windows = excluded.windows, overridden = excluded.overridden, pending = excluded.pending`)
const saveRow = (r: Row) => save.run(r.name, r.until, JSON.stringify(r.windows), r.overridden ? 1 : 0, r.pending ? 1 : 0)
const removeRow = db.prepare('DELETE FROM reserve WHERE name = ?')

export const reserveLimits = (): ReserveLimits => ({ ...DEFAULT_LIMITS, ...readState().reserve })

export function setReserveLimits(patch: Partial<ReserveLimits>) {
  updateState({ reserve: { ...reserveLimits(), ...patch } })
}

/** Accounts the reserve holds back, or that were enabled by hand while held back, by file name. */
export function reserveStatus() {
  return {
    limits: reserveLimits(),
    accounts: Object.fromEntries([...rows().values()].map((r) => [r.name, { until: r.until, windows: r.windows, overridden: r.overridden }])),
  }
}

/**
 * The windows of an account at or below their reserve and when the last of them resets, plus every
 * reserved window the reading covers at all.
 */
function shortfall(provider: string, reading: LimitReading | undefined, limits: ReserveLimits, now: number) {
  const windows: ReserveWindow[] = []
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

async function setDisabled(name: string, disabled: boolean) {
  const res = await management('/credentials/status', { method: 'PATCH', body: { name, disabled } })
  if (!res?.ok) throw new Error(`could not ${disabled ? 'disable' : 'enable'} ${name}${res ? ` (HTTP ${res.status})` : ''}`)
  console.log(`Account reserve: ${disabled ? 'disabled' : 'enabled'} ${name}`)
}

/** Accounts whose last update failed, so a failure that repeats every tick is logged once. */
const failing = new Set<string>()

/** Brings each account's enabled state in line with the reserve. `files` is CPA's full credential list. */
export async function applyReserve(files: ListedCredential[], readings: Record<string, LimitReading>, now = Date.now()) {
  const limits = reserveLimits()
  const tracked = rows()
  for (const f of files) {
    const row = tracked.get(f.name)
    tracked.delete(f.name)
    if (!f.provider || !PROVIDERS.has(f.provider)) continue
    try {
      await applyOne(f, row, shortfall(f.provider, readings[f.name], limits, now), limits, now)
      failing.delete(f.name)
    } catch (err) {
      // Retried next tick; other accounts still get their turn.
      if (!failing.has(f.name)) console.error(`Account reserve: ${(err as Error).message}`)
      failing.add(f.name)
    }
  }
  // Credentials no longer listed (deleted, or briefly missing): forget them once their windows reset.
  for (const row of tracked.values()) if (now >= row.until) removeRow.run(row.name)
}

async function applyOne(f: ListedCredential, row: Row | undefined, { short, seen }: ReturnType<typeof shortfall>, limits: ReserveLimits, now: number) {
  if (row?.overridden) {
    if (now < row.until) return
    removeRow.run(f.name)
    row = undefined
  }
  if (short) {
    if (row && !row.pending && !f.disabled) {
      // Enabled by hand while reserved.
      saveRow({ name: f.name, ...short, overridden: true, pending: false })
    } else if (row?.pending || (!row && !f.disabled)) {
      // Saved first, so a disable CPA applies but reports as failed is still ours.
      saveRow({ name: f.name, ...short, overridden: false, pending: true })
      if (!f.disabled) await setDisabled(f.name, true)
      saveRow({ name: f.name, ...short, overridden: false, pending: false })
    } else if (row && (row.until !== short.until || row.windows.join() !== short.windows.join())) {
      saveRow({ ...row, ...short })
    }
    // Disabled by the user: theirs to enable.
    return
  }
  if (!row) return
  // A response can carry rate-limit headers without a window's utilization; that is no sign the
  // window recovered. Hold the account until each window that tripped shows up above its reserve,
  // its reserve is turned off, or it resets.
  if (now < row.until && row.windows.some((id) => limits[id] && !seen.has(id))) return
  if (f.disabled) await setDisabled(f.name, false)
  removeRow.run(f.name)
}
