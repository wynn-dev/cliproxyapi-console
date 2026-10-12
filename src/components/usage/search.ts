import { getRouteApi } from '@tanstack/react-router'
import type { UsageParams } from '@/lib/queries'

export const RANGES = {
  '1h': { ms: 3_600_000, label: 'Last hour' },
  '24h': { ms: 86_400_000, label: 'Last 24 hours' },
  '7d': { ms: 7 * 86_400_000, label: 'Last 7 days' },
  '30d': { ms: 30 * 86_400_000, label: 'Last 30 days' },
  '90d': { ms: 90 * 86_400_000, label: 'Last 90 days' },
} as const

export type RangeKey = keyof typeof RANGES
export const DEFAULT_RANGE: RangeKey = '24h'

/**
 * URL state of the usage page. Client keys are secrets, so the URL only carries the last
 * KEY_SUFFIX characters; the full key is resolved from the facets of the selected range.
 */
export interface UsageSearch {
  range?: RangeKey
  model?: string
  provider?: string
  credential?: string
  key?: string
  status?: 'ok' | 'failed' | 'turned_away'
}

export type FilterKey = Exclude<keyof UsageSearch, 'range'>

export const KEY_SUFFIX = 8
export const keySuffix = (apiKey: string) => apiKey.slice(-KEY_SUFFIX)

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export function validateUsageSearch(s: Record<string, unknown>): UsageSearch {
  return {
    range: typeof s.range === 'string' && s.range in RANGES ? (s.range as RangeKey) : undefined,
    model: str(s.model),
    provider: str(s.provider),
    credential: str(s.credential),
    key: str(s.key),
    status: s.status === 'ok' || s.status === 'failed' || s.status === 'turned_away' ? s.status : undefined,
  }
}

export const usageRoute = getRouteApi('/_app/usage')

export const hasFilters = (s: UsageSearch) => !!(s.model || s.provider || s.credential || s.key || s.status)

/** Server-side filter params (without the time window) for the current search. */
export function filterParams(s: UsageSearch, apiKeys: string[] | undefined): Omit<UsageParams, 'from' | 'to'> {
  return {
    model: s.model,
    provider: s.provider,
    authIndex: s.credential,
    // An unresolved suffix matches nothing, which is the truthful answer for a key without traffic in range.
    apiKey: s.key ? (apiKeys?.find((k) => k.endsWith(s.key!)) ?? s.key) : undefined,
    status: s.status,
  }
}

const BUCKET_NAMES: Record<number, string> = {
  60_000: 'per minute',
  300_000: 'per 5 minutes',
  900_000: 'per 15 minutes',
  3_600_000: 'per hour',
  10_800_000: 'per 3 hours',
  21_600_000: 'per 6 hours',
  86_400_000: 'per day',
}
export const bucketName = (ms: number) => BUCKET_NAMES[ms] ?? ''

/** Why CPA turned a request away, from the reason server/access-log.ts records. */
export function turnedAwayReason(reason: string) {
  if (reason === 'cooldown') return 'Every account was cooling down'
  if (reason === 'no_account') return 'No account available for this model'
  if (reason === 'client_key') return 'Client key not accepted'
  return 'Rejected before reaching an account'
}
