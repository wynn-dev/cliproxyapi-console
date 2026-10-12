import { hasReading, type LimitReading } from '../../server/limit-windows.ts'

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
