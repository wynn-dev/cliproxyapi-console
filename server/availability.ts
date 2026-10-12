/**
 * Which accounts can take requests right now, and how many per provider. Shared by the server
 * (releasing a reserved account when none can) and the SPA (Overview), so it imports nothing.
 */

export type Availability = 'available' | 'reserved' | 'extra-usage' | 'signed-out' | 'cooling' | 'disabled'

export interface PoolAccount {
  name: string
  provider: string
  disabled?: boolean
  status?: string
  unavailable?: boolean
  next_retry_after?: string
}

/** A hold the console has in force on an account (not one overridden by hand). */
export interface PoolHold {
  reason: 'reserve' | 'extra-usage' | 'signed-out'
  /** When it ends (ms); 0 for a hold that waits for a new sign-in. */
  until: number
}

export function availability(a: PoolAccount, hold: PoolHold | undefined, now: number): { state: Availability; until?: number } {
  if (hold) return { state: hold.reason === 'reserve' ? 'reserved' : hold.reason, until: hold.until || undefined }
  if (a.disabled || a.status === 'disabled') return { state: 'disabled' }
  // Cooling down as a whole (a model-only cooldown leaves the account usable), or failing.
  if (a.unavailable || a.status === 'error') {
    const retry = Date.parse(a.next_retry_after ?? '')
    return { state: 'cooling', until: retry > now ? retry : undefined }
  }
  return { state: 'available' }
}

export interface ProviderAvailability {
  provider: string
  total: number
  available: number
  /** Accounts that cannot take requests, by why, with the soonest one back. */
  held: Partial<Record<Exclude<Availability, 'available'>, { count: number; until?: number }>>
}

export function poolAvailability(accounts: PoolAccount[], holdOf: (name: string) => PoolHold | undefined, now: number): ProviderAvailability[] {
  const out = new Map<string, ProviderAvailability>()
  for (const a of accounts) {
    const p = out.get(a.provider) ?? { provider: a.provider, total: 0, available: 0, held: {} }
    out.set(a.provider, p)
    p.total++
    const { state, until } = availability(a, holdOf(a.name), now)
    if (state === 'available') {
      p.available++
      continue
    }
    const h = (p.held[state] ??= { count: 0 })
    h.count++
    if (until && (!h.until || until < h.until)) h.until = until
  }
  return [...out.values()]
}
