import { limitWindows, type LimitReading } from './limit-windows.ts'
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

export type ReserveWindow = '5h' | 'weekly'
export type ReserveLimits = Record<ReserveWindow, number>

const DEFAULT_LIMITS: ReserveLimits = { '5h': 5, weekly: 5 }
const PROVIDERS = new Set(['claude', 'codex'])
/** The windows the reserve covers, by the label limitWindows gives them. Model-scoped ones (Fable) are left to CPA. */
const WINDOW_LABELS: Record<string, ReserveWindow> = { '5h': '5h', Weekly: 'weekly' }

db.exec(`CREATE TABLE IF NOT EXISTS reserve (
  name TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  windows TEXT NOT NULL,
  overridden INTEGER NOT NULL DEFAULT 0
)`)

interface Row {
  name: string
  /** When the windows below their reserve reset (ms). */
  until: number
  windows: ReserveWindow[]
  /** Enabled by hand while reserved: left alone until `until`. */
  overridden: boolean
}

function rows() {
  const all = db.prepare('SELECT name, until, windows, overridden FROM reserve').all() as { name: string; until: number; windows: string; overridden: number }[]
  return new Map(all.map((r) => [r.name, { ...r, windows: JSON.parse(r.windows) as ReserveWindow[], overridden: !!r.overridden }]))
}

const save = db.prepare(`
  INSERT INTO reserve (name, until, windows, overridden) VALUES (?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET until = excluded.until, windows = excluded.windows, overridden = excluded.overridden`)
const saveRow = (r: Row) => save.run(r.name, r.until, JSON.stringify(r.windows), r.overridden ? 1 : 0)
const removeRow = db.prepare('DELETE FROM reserve WHERE name = ?')

export const reserveLimits = (): ReserveLimits => ({ ...DEFAULT_LIMITS, ...readState().reserve })

export function setReserveLimits(patch: Partial<ReserveLimits>) {
  updateState({ reserve: { ...reserveLimits(), ...patch } })
}

/** Accounts the reserve holds back, or that were enabled by hand while held back, by file name. */
export function reserveStatus() {
  return {
    limits: reserveLimits(),
    accounts: Object.fromEntries([...rows().values()].map(({ name, ...r }) => [name, r])),
  }
}

/** The windows of an account at or below their reserve, and when the last of them resets. */
function shortfall(provider: string, reading: LimitReading | undefined, limits: ReserveLimits, now: number) {
  const windows: ReserveWindow[] = []
  let until = 0
  for (const w of limitWindows(provider, reading, now)) {
    const id = WINDOW_LABELS[w.label]
    // Without a reset time the account could never be enabled again.
    if (!id || !limits[id] || w.resetsAt === undefined) continue
    if (w.left > limits[id] / 100 + 1e-9) continue
    windows.push(id)
    until = Math.max(until, w.resetsAt)
  }
  return windows.length ? { windows, until } : undefined
}

async function setDisabled(name: string, disabled: boolean) {
  const res = await management('/credentials/status', { method: 'PATCH', body: { name, disabled } })
  if (!res?.ok) throw new Error(`Could not ${disabled ? 'disable' : 'enable'} ${name}`)
  console.log(`Account reserve: ${disabled ? 'disabled' : 'enabled'} ${name}`)
}

/** Brings each account's enabled state in line with the reserve. `files` is CPA's full credential list. */
export async function applyReserve(files: ListedCredential[], readings: Record<string, LimitReading>, now = Date.now()) {
  const limits = reserveLimits()
  const tracked = rows()
  for (const f of files) {
    let row = tracked.get(f.name)
    tracked.delete(f.name)
    if (!f.provider || !PROVIDERS.has(f.provider)) continue
    if (row?.overridden) {
      if (now < row.until) continue
      removeRow.run(f.name)
      row = undefined
    }
    const short = shortfall(f.provider, readings[f.name], limits, now)
    if (short) {
      if (row && !f.disabled) {
        // Enabled by hand while reserved.
        saveRow({ name: f.name, ...short, overridden: true })
      } else if (row) {
        if (row.until !== short.until || row.windows.join() !== short.windows.join()) saveRow({ name: f.name, ...short, overridden: false })
      } else if (!f.disabled) {
        await setDisabled(f.name, true)
        saveRow({ name: f.name, ...short, overridden: false })
      }
      // Disabled by the user: theirs to enable.
    } else if (row) {
      if (f.disabled) await setDisabled(f.name, false)
      removeRow.run(f.name)
    }
  }
  // Deleted credentials.
  for (const name of tracked.keys()) removeRow.run(name)
}
