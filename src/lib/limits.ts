import { hasReading, limitWindows, type LimitReading } from '../../server/limit-windows.ts'

export * from '../../server/limit-windows.ts'

/**
 * CPA's live reading and the console's stored one (kept across restarts, or from a limit check):
 * the newer one, and the other for the model-scoped limits the newer one may lack.
 */
export function accountReadings(live: LimitReading | undefined, stored: LimitReading | undefined) {
  if (!hasReading(live)) return { reading: stored }
  if (!hasReading(stored)) return { reading: live }
  return Date.parse(stored.observed_at ?? '') > Date.parse(live.observed_at ?? '') ? { reading: stored, older: live } : { reading: live, older: stored }
}

export interface PoolLimit {
  provider: string
  /** The limit added up, by the label limitWindows gives it. */
  label: string
  accounts: number
  /** How much of the limit is left across the accounts, in accounts' worth (0 to `accounts`). */
  left: number
  /** Accounts without a reading, counted as unused. */
  unread: number
  /** The soonest reset among the accounts, and how much of one account's limit it gives back. */
  nextReset?: { at: number; gain: number }
}

/** The limits worth adding up: the weekly one, and for Claude the Fable models' own. */
const pooled = (provider: string) => (provider === 'claude' ? ['Weekly', 'Fable'] : ['Weekly'])

/**
 * Each provider's weekly limit added up over its accounts, each account counting the same whatever
 * its plan, like the run-out forecast; and Claude's Fable limit the same way. Accounts that haven't
 * reported their limits yet count as unused. A reading without the window falls back to the `older`
 * reading for Fable, as the account's own meters do; with neither, the account is left out, unless
 * the console holds it for that window (`holds`, by label, when the hold ends), which counts it as
 * used up.
 */
export function poolLimits(
  accounts: { provider: string; reading?: LimitReading; older?: LimitReading; holds?: Partial<Record<string, number>> }[],
  now: number,
): PoolLimit[] {
  const out = new Map<string, PoolLimit>()
  for (const { provider, reading, older, holds } of accounts) {
    for (const label of pooled(provider)) {
      const key = `${provider}:${label}`
      const p = out.get(key) ?? { provider, label, accounts: 0, left: 0, unread: 0 }
      // Set even when this account ends up left out, so pools keep the order of the accounts.
      out.set(key, p)
      const hold = holds?.[label]
      const w =
        limitWindows(provider, reading, now).find((w) => w.label === label) ??
        (label === 'Weekly' ? undefined : limitWindows(provider, older, now).find((w) => w.label === label))
      const window = w ?? (!hasReading(reading) ? { left: 1, resetsAt: undefined } : hold !== undefined ? { left: 0, resetsAt: hold || undefined } : undefined)
      if (!window) continue
      p.accounts++
      p.left += window.left
      if (!hasReading(reading)) p.unread++
      // A reset that gives nothing back says nothing about when capacity returns.
      const gain = 1 - window.left
      if (window.resetsAt === undefined || gain < 0.005) continue
      if (!p.nextReset || window.resetsAt < p.nextReset.at) p.nextReset = { at: window.resetsAt, gain }
      else if (window.resetsAt === p.nextReset.at) p.nextReset.gain += gain
    }
  }
  return [...out.values()].filter((p) => p.accounts > 0)
}
