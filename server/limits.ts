import { keyMatchesConfig } from './auth.ts'
import { readState } from './state.ts'
import { supervisor } from './supervisor.ts'
import { db } from './usage.ts'

/**
 * CPA learns each account's usage limits from upstream response headers and keeps them in memory
 * only, so after every restart they are unknown until the account serves another request. The
 * console keeps the last reading per account.
 */

db.exec('CREATE TABLE IF NOT EXISTS limits (name TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, signals TEXT NOT NULL)')

interface ListedCredential {
  name: string
  quota?: { observed_at?: string; signals?: Record<string, string> }
}

const upsert = db.prepare(`
  INSERT INTO limits (name, observed_at, signals) VALUES (?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET observed_at = excluded.observed_at, signals = excluded.signals
  WHERE excluded.observed_at > limits.observed_at`)

async function record() {
  const key = readState().managementKey
  // Never send a stale key: CPA bans 127.0.0.1 (i.e. the console) after five failures.
  if (supervisor.state !== 'running' || !supervisor.port || !keyMatchesConfig(key)) return
  const res = await fetch(`http://127.0.0.1:${supervisor.port}/v8/management/credentials`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return
  const { files } = (await res.json()) as { files?: ListedCredential[] }
  for (const f of files ?? []) {
    const at = Date.parse(f.quota?.observed_at ?? '')
    const signals = f.quota?.signals ?? {}
    if (at && Object.keys(signals).length) upsert.run(f.name, at, JSON.stringify(signals))
  }
}

/** The last limit reading per credential file name. */
export function limitReadings() {
  const rows = db.prepare('SELECT name, observed_at, signals FROM limits').all() as { name: string; observed_at: number; signals: string }[]
  return Object.fromEntries(rows.map((r) => [r.name, { observed_at: new Date(r.observed_at).toISOString(), signals: JSON.parse(r.signals) as Record<string, string> }]))
}

export function startLimitRecorder() {
  setInterval(() => void record().catch(() => {}), 30_000)
}
