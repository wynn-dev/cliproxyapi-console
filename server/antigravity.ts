import { excludedModels } from './fable.ts'
import { ANTIGRAVITY_FAMILIES, limitWindows, type LimitReading } from './limit-windows.ts'
import type { ListedCredential } from './limits.ts'
import { credentialFile, patchCredential } from './management.ts'
import { reserveLimits } from './reserve.ts'
import { db } from './usage.ts'

/**
 * Antigravity reserve: a Gemini subscription signed in through Antigravity has a quota per model
 * family (Gemini, Claude, GPT-OSS; see limit-checks.ts), not one for the whole account. Once a
 * family is down to the 5-hour reserve, the console adds its models to that account's
 * `excluded_models`, so CPA routes them to other accounts while the account keeps serving the other
 * families. When the family's quota resets, it removes exactly what it added; models the user
 * excluded stay. The same as the Fable reserve (fable.ts), once per family.
 */

/** CPA matches `*` anywhere in a pattern, case-insensitively, against the account's model ids. */
const pattern = (family: string) => `${family}-*`

db.exec(`CREATE TABLE IF NOT EXISTS antigravity_hold (
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  until INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, family)
)`)

interface Hold {
  name: string
  family: string
  /** When the family's quota resets (ms). */
  until: number
  /** Asked CPA to add the pattern but not yet seen it in the file. */
  pending: boolean
}

const key = (name: string, family: string) => `${name}\n${family}`

function holds() {
  const all = db.prepare('SELECT name, family, until, pending FROM antigravity_hold').all() as { name: string; family: string; until: number; pending: number }[]
  return new Map<string, Hold>(all.map((r) => [key(r.name, r.family), { ...r, pending: !!r.pending }]))
}

const save = db.prepare(`
  INSERT INTO antigravity_hold (name, family, until, pending) VALUES (?, ?, ?, ?)
  ON CONFLICT (name, family) DO UPDATE SET until = excluded.until, pending = excluded.pending`)
const saveHold = (h: Hold) => save.run(h.name, h.family, h.until, h.pending ? 1 : 0)
const remove = db.prepare('DELETE FROM antigravity_hold WHERE name = ? AND family = ?')

/** Families held back per account, by file name, then by the label limitWindows gives them: when each is back. */
export function antigravityStatus() {
  const out: Record<string, Record<string, number>> = {}
  for (const h of holds().values()) (out[h.name] ??= {})[ANTIGRAVITY_FAMILIES[h.family] ?? h.family] = h.until
  return out
}

/** What the console added to an account's excluded_models, so a copy of its fields can leave it out. */
export const antigravityAdded = (name: string) => [...holds().values()].filter((h) => h.name === name).map((h) => pattern(h.family))

/** Accounts whose last update failed, so a failure that repeats every tick is logged once. */
const failing = new Set<string>()

/** Brings each Antigravity account's exclusions in line with its quotas. `files` is CPA's full credential list. */
export async function applyAntigravity(files: ListedCredential[], readings: Record<string, LimitReading>, now = Date.now()) {
  const tracked = holds()
  const pct = reserveLimits()['5h']
  for (const f of files) {
    if (f.provider !== 'antigravity') continue
    const windows = limitWindows('antigravity', readings[f.name], now)
    for (const family of Object.keys(ANTIGRAVITY_FAMILIES)) {
      const held = tracked.get(key(f.name, family))
      tracked.delete(key(f.name, family))
      const w = windows.find((w) => w.id === family)
      // Without a reset time the models could never be released.
      const short = w && w.resetsAt !== undefined && pct > 0 && w.left <= pct / 100 + 1e-9 ? w.resetsAt : undefined
      try {
        await applyOne(f.name, family, held, short, !!w, now)
        failing.delete(key(f.name, family))
      } catch (err) {
        if (!failing.has(key(f.name, family))) console.error(`Antigravity reserve: ${(err as Error).message}`)
        failing.add(key(f.name, family))
      }
    }
  }
  for (const h of tracked.values()) if (now >= h.until) remove.run(h.name, h.family)
}

async function applyOne(name: string, family: string, held: Hold | undefined, until: number | undefined, seen: boolean, now: number) {
  const label = ANTIGRAVITY_FAMILIES[family]
  if (until !== undefined) {
    if (held && !held.pending) {
      if (held.until !== until) saveHold({ ...held, until })
      return
    }
    const current = excludedModels(await credentialFile(name))
    const has = current.some((m) => m.toLowerCase() === pattern(family))
    // Excluded already: by the user, unless a write of ours CPA reported as failed went through.
    if (has && !held) return
    const hold: Hold = { name, family, until, pending: true }
    saveHold(hold)
    if (!has) {
      await patchCredential(name, { excluded_models: [...current, pattern(family)] })
      console.log(`Antigravity reserve: holding ${label} models on ${name}`)
    }
    saveHold({ ...hold, pending: false })
    return
  }
  if (!held) return
  // No reading of the family since the hold is no sign its quota recovered.
  if (!seen && now < held.until) return
  const current = excludedModels(await credentialFile(name))
  const next = current.filter((m) => m.toLowerCase() !== pattern(family))
  if (next.length !== current.length) {
    await patchCredential(name, { excluded_models: next.length ? next : null })
    console.log(`Antigravity reserve: released ${label} models on ${name}`)
  }
  remove.run(name, family)
}
