import { type PoolAccount, availability } from './availability.ts'
import { RESERVE_WINDOWS, limitWindows, type LimitReading } from './limit-windows.ts'
import type { ListedCredential } from './limits.ts'
import { type Row, releasesWhenAllHeld, removeRow, reserveLimits, rows, saveRow, setDisabled, shortfall } from './reserve.ts'

/**
 * Opt-in: when every account of a provider is held back, release the account the reserve holds
 * with the most left, so clients keep working. Paid extra usage and a needed sign-in are never
 * released. The account stays released until another account of that provider has been available
 * for a while (so a short cooldown ending does not flap it), until its own limit resets, or until
 * the setting is turned off. It waits until none has been available for a couple of minutes, so a
 * cooldown about to end doesn't release one. Only one account per provider is released at a time,
 * and only when holds (not just cooldowns or errors) leave the provider without an account.
 */

const PROVIDERS = new Set(['claude', 'codex'])
/** How long another account must stay available before a released one is held again. */
const STABLE_MS = 5 * 60_000
/** How long no account may be available before one is released. */
const EMPTY_MS = 2 * 60_000

/** Per provider: since when an account other than a released one has been available. */
const availableSince = new Map<string, number>()
/** Per provider: since when no account has been available. */
const emptySince = new Map<string, number>()

/** The least left of an account's reserved windows, 0 to 1. */
function leftOf(f: ListedCredential, reading: LimitReading | undefined, now: number) {
  const left = limitWindows(f.provider!, reading, now)
    .filter((w) => RESERVE_WINDOWS[w.label])
    .map((w) => w.left)
  return left.length ? Math.min(...left) : -1
}

/** Accounts whose last update failed, so a failure that repeats every tick is logged once. */
const failing = new Set<string>()

async function attempt(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    failing.delete(name)
  } catch (err) {
    if (!failing.has(name)) console.error(`Account reserve: ${(err as Error).message}`)
    failing.add(name)
  }
}

export async function applyRelease(files: ListedCredential[], readings: Record<string, LimitReading>, now = Date.now()) {
  const on = releasesWhenAllHeld()
  const tracked = rows()
  const held = (f: ListedCredential) => {
    const r = tracked.get(f.name)
    return r && !r.overridden ? r : undefined
  }
  for (const provider of PROVIDERS) {
    const accounts = files.filter((f) => f.provider === provider)
    const released: ListedCredential[] = []
    for (const f of accounts.filter((f) => tracked.get(f.name)?.released)) {
      const row = tracked.get(f.name)!
      if (!f.disabled) {
        if (row.pending) saveRow({ ...row, pending: false })
        released.push(f)
      }
      // The enable never went through: still held.
      else if (row.pending) saveRow({ ...row, overridden: false, released: false, pending: false })
      // Disabled after it was released: by the user, so theirs.
      else removeRow(f.name)
    }
    const others = accounts.filter((f) => !tracked.get(f.name)?.released && availability(f as PoolAccount, held(f), now).state === 'available')
    if (others.length) availableSince.set(provider, availableSince.get(provider) ?? now)
    else availableSince.delete(provider)

    for (const f of released) {
      if (on && !(others.length && now - availableSince.get(provider)! >= STABLE_MS)) continue
      await attempt(f.name, () => hold(f, tracked.get(f.name)!, readings[f.name], now, on ? ': another account is available again' : ''))
    }
    // One released account per provider at a time, even once it runs out too, so an outage can't
    // drain several owners' reserves. And only holds count: accounts merely cooling down or failing
    // come back on their own.
    const holds = accounts.some((f) => held(f))
    const empty = on && !others.length && !released.length && holds
    if (!empty) {
      emptySince.delete(provider)
      continue
    }
    // Wait out short gaps, such as cooldowns about to end.
    emptySince.set(provider, emptySince.get(provider) ?? now)
    if (now - emptySince.get(provider)! < EMPTY_MS) continue

    const candidates = accounts.filter((f) => {
      const r = held(f)
      return r?.reason === 'reserve' && !r.pending && f.disabled
    })
    const best = candidates.sort((a, b) => leftOf(b, readings[b.name], now) - leftOf(a, readings[a.name], now))[0]
    if (!best) continue
    await attempt(best.name, async () => {
      const row = { ...tracked.get(best.name)!, overridden: true, released: true }
      // Saved first, so an enable CPA applies but reports as failed is still ours.
      saveRow({ ...row, pending: true })
      await setDisabled(best.name, false, `: every ${provider} account was held back`)
      saveRow({ ...row, pending: false })
    })
  }
}

/** Puts a released account back under the reserve, if it still needs it. */
async function hold(f: ListedCredential, row: Row, reading: LimitReading | undefined, now: number, why: string) {
  const { short } = shortfall(f.provider!, reading, reserveLimits(), now)
  if (!short) {
    removeRow(f.name)
    return
  }
  // Saved first, so a disable CPA applies but reports as failed is still ours.
  saveRow({ ...row, ...short, overridden: false, released: false, pending: true })
  await setDisabled(f.name, true, why)
  saveRow({ ...row, ...short, overridden: false, released: false, pending: false })
}
