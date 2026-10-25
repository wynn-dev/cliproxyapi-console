import { applyFable } from './fable.ts'
import { applyFallback } from './fallback.ts'
import { recordCredentialLimits } from './limit-history.ts'
import { management } from './management.ts'
import { applyOrder } from './order.ts'
import { applyRelease } from './release.ts'
import { applyReserve } from './reserve.ts'
import { applySignIn } from './sign-in.ts'
import { db } from './usage.ts'

/**
 * CPA learns each account's usage limits from upstream response headers and keeps them in memory
 * only, so after every restart they are unknown until the account serves another request. The
 * console keeps the last reading per account.
 */

db.exec('CREATE TABLE IF NOT EXISTS limits (name TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, signals TEXT NOT NULL)')

/** The fields of CPA's credential list the console acts on. */
export interface ListedCredential {
  name: string
  provider?: string
  disabled?: boolean
  auth_index?: string
  email?: string
  status?: string
  status_message?: string
  unavailable?: boolean
  next_retry_after?: string
  modtime?: string
  created_at?: string
  last_refresh?: string
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

/** Stages whose last run failed, so a failure that repeats every tick is logged once. */
const stageFailing = new Set<string>()

/** Often enough that the account reserve stops an account close to its threshold. */
const POLL_MS = 5_000

export function startLimitRecorder() {
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const files = await record()
      if (files) {
        const readings = limitReadings()
        // Sign-in first: an account that needs one is held whatever its limits say. Each stage runs
        // even when one before it failed.
        const stages: [string, () => Promise<void>][] = [
          ['Sign-in check', () => applySignIn(files)],
          ['Account reserve', () => applyReserve(files, readings)],
          ['Fable reserve', () => applyFable(files, readings)],
          ['Release', () => applyRelease(files, readings)],
          ['Account order', () => applyOrder(files, readings)],
          ['API key fallback', () => applyFallback(files)],
        ]
        for (const [label, stage] of stages) {
          await stage().then(
            () => stageFailing.delete(label),
            (err: Error) => {
              if (!stageFailing.has(label)) console.error(`${label}: ${err.message}`)
              stageFailing.add(label)
            },
          )
        }
      }
    } catch {
      // CPA restarting or busy: try again on the next tick.
    } finally {
      busy = false
    }
  }, POLL_MS)
}
