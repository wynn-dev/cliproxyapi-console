import { hasReading, limitWindows, type LimitReading } from '../../server/limit-windows.ts'

export * from '../../server/limit-windows.ts'

/**
 * CPA's live reading and the console's stored one (kept across restarts, or from a limit check):
 * the newer one, and the other for the model-scoped limits a limit check doesn't report.
 */
export function accountReadings(live: LimitReading | undefined, stored: LimitReading | undefined) {
  if (!hasReading(live)) return { reading: stored }
  if (!hasReading(stored)) return { reading: live }
  return Date.parse(stored.observed_at ?? '') > Date.parse(live.observed_at ?? '') ? { reading: stored, older: live } : { reading: live, older: stored }
}

export interface PoolWeekly {
  provider: string
  accounts: number
  /** Weekly limit left across the accounts, in account-weeks (0 to `accounts`). */
  left: number
  /** Accounts without a weekly reading, counted as unused. */
  unread: number
  /** The soonest weekly reset among the accounts, and how much of an account-week it gives back. */
  nextReset?: { at: number; gain: number }
}

/**
 * Every account's weekly limit of a provider added up, each account counting the same whatever its
 * plan, like the run-out forecast. Accounts turned off by hand are left out, accounts held back by
 * the console stay in; accounts that haven't reported their limits yet count as unused.
 */
export function poolWeekly(accounts: { provider: string; reading?: LimitReading }[], now: number): PoolWeekly[] {
  const out = new Map<string, PoolWeekly>()
  for (const { provider, reading } of accounts) {
    const p = out.get(provider) ?? { provider, accounts: 0, left: 0, unread: 0 }
    out.set(provider, p)
    p.accounts++
    const w = limitWindows(provider, reading, now).find((w) => w.label === 'Weekly')
    if (!w) {
      p.left++
      p.unread++
      continue
    }
    p.left += w.left
    if (w.resetsAt === undefined) continue
    if (!p.nextReset || w.resetsAt < p.nextReset.at) p.nextReset = { at: w.resetsAt, gain: 1 - w.left }
    else if (w.resetsAt === p.nextReset.at) p.nextReset.gain += 1 - w.left
  }
  return [...out.values()]
}
