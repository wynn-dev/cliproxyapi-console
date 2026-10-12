import { recordCredentialLimits } from './limit-history.ts'
import { management } from './management.ts'
import { applyOrder } from './order.ts'
import { applyReserve } from './reserve.ts'
import { db } from './usage.ts'

/**
 * CPA learns each account's usage limits from upstream response headers and keeps them in memory
 * only, so after every restart they are unknown until the account serves another request. The
 * console keeps the last reading per account.
 */

db.exec('CREATE TABLE IF NOT EXISTS limits (name TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, signals TEXT NOT NULL)')

export interface ListedCredential {
  name: string
  provider?: string
  disabled?: boolean
  quota?: { observed_at?: string; signals?: Record<string, string> }
}

const upsert = db.prepare(`
  INSERT INTO limits (name, observed_at, signals) VALUES (?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET observed_at = excluded.observed_at, signals = excluded.signals
  WHERE excluded.observed_at > limits.observed_at`)

/** Stores a reading unless a newer one is already stored. Also used by the idle-account limit checks. */
export function saveReading(name: string, observedAt: number, signals: Record<string, string>) {
  upsert.run(name, observedAt, JSON.stringify(signals))
}

async function record() {
  const res = await management('/credentials')
  if (!res?.ok) return
  const { files } = (await res.json()) as { files?: ListedCredential[] }
  for (const f of files ?? []) {
    const at = Date.parse(f.quota?.observed_at ?? '')
    const signals = f.quota?.signals ?? {}
    if (at && Object.keys(signals).length) saveReading(f.name, at, signals)
  }
  recordCredentialLimits(files ?? [])
  return files ?? []
}

/** The last limit reading per credential file name. */
export function limitReadings() {
  const rows = db.prepare('SELECT name, observed_at, signals FROM limits').all() as { name: string; observed_at: number; signals: string }[]
  return Object.fromEntries(rows.map((r) => [r.name, { observed_at: new Date(r.observed_at).toISOString(), signals: JSON.parse(r.signals) as Record<string, string> }]))
}

/** Often enough that the account reserve stops an account close to its threshold. */
const POLL_MS = 5_000

export function startLimitRecorder() {
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const files = await record()
      if (files) await applyReserve(files, limitReadings())
      if (files) await applyOrder(files, limitReadings())
    } catch {
      // CPA restarting or busy: try again on the next tick.
    } finally {
      busy = false
    }
  }, POLL_MS)
}
