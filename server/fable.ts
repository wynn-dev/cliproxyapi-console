import { limitWindows, type LimitReading } from './limit-windows.ts'
import type { ListedCredential } from './limits.ts'
import { credentialFile, patchCredential } from './management.ts'
import { holdsExtraUsage, reserveLimits } from './reserve.ts'
import { db } from './usage.ts'

/**
 * Fable reserve: Claude's Fable models have their own weekly limit (the `7d_oi` window). Once it is
 * down to its reserve, the console adds the Fable models to that account's `excluded_models`, so
 * CPA routes Fable requests to other accounts while the account keeps serving every other model.
 * When the window resets, it removes exactly what it added; models the user excluded stay.
 *
 * It also holds Fable when that window ran out and the account bills its owner for extra usage on
 * it, even with the reserve off: Fable is the only limit spent then, so the rest of the account
 * stays in rotation.
 */

/** CPA matches `*` anywhere in a pattern, case-insensitively, against the account's model ids. */
export const FABLE_PATTERN = 'claude-fable-*'
const LABEL = 'Fable'

db.exec(`CREATE TABLE IF NOT EXISTS fable_hold (
  name TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  added TEXT NOT NULL,
  billing INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0
)`)

interface Hold {
  name: string
  /** When the Fable window resets (ms). */
  until: number
  /** Patterns the console added to the file's excluded_models. */
  added: string[]
  /** Held because the Fable limit ran out with extra usage on, not for the reserve. */
  billing: boolean
  /** Asked CPA to add the patterns but not yet seen them in the file. */
  pending: boolean
}

function holds() {
  const all = db.prepare('SELECT name, until, added, billing, pending FROM fable_hold').all() as
    { name: string; until: number; added: string; billing: number; pending: number }[]
  return new Map<string, Hold>(all.map((r) => [r.name, { ...r, added: JSON.parse(r.added) as string[], billing: !!r.billing, pending: !!r.pending }]))
}

const save = db.prepare(`
  INSERT INTO fable_hold (name, until, added, billing, pending) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET until = excluded.until, added = excluded.added, billing = excluded.billing, pending = excluded.pending`)
const saveHold = (h: Hold) => save.run(h.name, h.until, JSON.stringify(h.added), h.billing ? 1 : 0, h.pending ? 1 : 0)
const remove = db.prepare('DELETE FROM fable_hold WHERE name = ?')

/** Accounts whose Fable models are held back, by file name. */
export const fableStatus = () => Object.fromEntries([...holds().values()].map((h) => [h.name, { until: h.until, billing: h.billing }]))

/** What the console added to an account's excluded_models, so a copy of its fields can leave it out. */
export const fableAdded = (name: string) => holds().get(name)?.added ?? []

/** The file's own excluded models; `excluded-models` is CPA's legacy spelling. */
export function excludedModels(file: Record<string, unknown>) {
  const raw = file.excluded_models ?? file['excluded-models']
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : []
}

const BILLING = new Set(['allowed', 'allowed_warning'])

/** Extra usage is on and the reading came from a served request (Retry-After comes with a rejected one). */
function overageAllowed(reading: LimitReading | undefined) {
  const s = Object.fromEntries(Object.entries(reading?.signals ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim().toLowerCase()]))
  return BILLING.has(s['anthropic-ratelimit-unified-overage-status']) && !s['retry-after']
}

/** Whether the account's Fable models should be held, and until when. */
function trip(reading: LimitReading | undefined, now: number) {
  const w = limitWindows('claude', reading, now).find((w) => w.label === LABEL)
  // Without a reset time the models could never be released.
  if (!w || w.resetsAt === undefined) return { seen: !!w }
  const pct = reserveLimits().fable
  const billing = holdsExtraUsage() && w.level === 'exhausted' && overageAllowed(reading)
  const short = (pct > 0 && w.left <= pct / 100 + 1e-9) || billing
  return { seen: true, short: short ? { until: w.resetsAt, billing: billing && !(pct > 0 && w.left <= pct / 100 + 1e-9) } : undefined }
}

/** Accounts whose last update failed, so a failure that repeats every tick is logged once. */
const failing = new Set<string>()

/** Brings each Claude account's Fable exclusion in line with its Fable window. `files` is CPA's full credential list. */
export async function applyFable(files: ListedCredential[], readings: Record<string, LimitReading>, now = Date.now()) {
  const tracked = holds()
  for (const f of files) {
    const held = tracked.get(f.name)
    tracked.delete(f.name)
    if (f.provider !== 'claude') continue
    try {
      await applyOne(f.name, held, trip(readings[f.name], now), now)
      failing.delete(f.name)
    } catch (err) {
      if (!failing.has(f.name)) console.error(`Fable reserve: ${(err as Error).message}`)
      failing.add(f.name)
    }
  }
  for (const h of tracked.values()) if (now >= h.until) remove.run(h.name)
}

async function applyOne(name: string, held: Hold | undefined, { seen, short }: ReturnType<typeof trip>, now: number) {
  if (short) {
    if (held && !held.pending) {
      if (held.until !== short.until || held.billing !== short.billing) saveHold({ ...held, ...short })
      return
    }
    const current = excludedModels(await credentialFile(name))
    const has = current.some((m) => m.toLowerCase() === FABLE_PATTERN)
    // Excluded already: by the user, unless a write of ours CPA reported as failed went through.
    if (has && !held) return
    const hold: Hold = { name, ...short, added: [FABLE_PATTERN], pending: true }
    saveHold(hold)
    if (!has) {
      await patchCredential(name, { excluded_models: [...current, FABLE_PATTERN] })
      console.log(`Fable reserve: holding Fable models on ${name}${short.billing ? ': its Fable limit ran out and it is using paid extra usage' : ''}`)
    }
    saveHold({ ...hold, pending: false })
    return
  }
  if (!held) return
  // No Fable reading since the hold is no sign the window recovered.
  if (!seen && now < held.until) return
  const current = excludedModels(await credentialFile(name))
  const added = new Set(held.added.map((m) => m.toLowerCase()))
  const next = current.filter((m) => !added.has(m.toLowerCase()))
  if (next.length !== current.length) {
    await patchCredential(name, { excluded_models: next.length ? next : null })
    console.log(`Fable reserve: released Fable models on ${name}`)
  }
  remove.run(name)
}
