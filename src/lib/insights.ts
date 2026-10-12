import { queryOptions, useQuery } from '@tanstack/react-query'
import { format, isSameDay, addDays } from 'date-fns'
import { consoleApi } from './api'
import { queries } from './queries'
import type { CacheBreakCause, CacheBreakReport, DigestReport, ForecastReport, WindowForecast } from '../../server/insights-types.ts'

export type * from '../../server/insights-types.ts'

export const insightQueries = {
  forecast: () =>
    queryOptions({
      queryKey: ['console', 'insights', 'forecast'],
      queryFn: () => consoleApi<ForecastReport>('/insights/forecast'),
      refetchInterval: 60_000,
    }),
  cacheBreaks: (days = 7) =>
    queryOptions({
      queryKey: ['console', 'insights', 'cache-breaks', days],
      queryFn: () => consoleApi<CacheBreakReport>('/insights/cache-breaks', { query: { days, tz: new Date().getTimezoneOffset() } }),
      refetchInterval: 60_000,
    }),
  digest: () =>
    queryOptions({
      queryKey: ['console', 'insights', 'digest'],
      queryFn: () => consoleApi<DigestReport>('/insights/digest'),
      refetchInterval: 5 * 60_000,
    }),
}

/** Credential file name → the account's display name. */
export function useAccountNames() {
  const { data } = useQuery({ ...queries.credentials(), refetchInterval: false })
  const map = new Map((data?.files ?? []).map((c) => [c.name, c.email || c.label || c.name]))
  return (name: string) => map.get(name) ?? name.replace(/\.json$/, '')
}

/** A rough time ahead: "in about 2h" when close, else "Thu ~14:00" (rounded to the hour). */
export function fmtAbout(t: number, now: number) {
  const ms = t - now
  if (ms < 90 * 60_000) return `in about ${Math.max(5, Math.round(ms / 300_000) * 5)}m`
  if (ms < 5 * 3_600_000) return `in about ${Math.round(ms / 3_600_000)}h`
  const hour = Math.round(t / 3_600_000) * 3_600_000
  return `${fmtDay(hour, now)} ~${format(hour, 'HH:mm')}`
}

/** An exact time ahead: "today 09:00", "tomorrow 09:00", "Sat 09:00", or "Oct 21 09:00" beyond a week. */
export function fmtAt(t: number, now: number) {
  return `${fmtDay(t, now)} ${format(t, 'HH:mm')}`
}

function fmtDay(t: number, now: number) {
  if (isSameDay(t, now)) return 'today'
  if (isSameDay(t, addDays(now, 1))) return 'tomorrow'
  return t - now < 6 * 86_400_000 ? format(t, 'EEE') : format(t, 'MMM d')
}

/** A span of history: "3 days", "9h". */
export function fmtSpan(ms: number) {
  const h = Math.round(ms / 3_600_000)
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h}h` : `${Math.max(1, Math.round(ms / 60_000))}m`
}

/** An amount of capacity in account-windows: "60% of an account's weekly limit", "1.3 accounts' weekly limits". */
export function fmtAccounts(n: number, limit = 'weekly limit') {
  if (n <= 0) return 'none'
  if (n < 0.005) return `<1% of an account's ${limit}`
  if (n < 0.995) return `${Math.round(n * 100)}% of an account's ${limit}`
  return n < 1.05 ? `one account's ${limit}` : `${+n.toFixed(1)} accounts' ${limit}s`
}

export type Tone = 'good' | 'warn' | 'bad' | 'idle'

/** The forecast of a pool's weekly limits in one sentence, and how worrying it is. */
export function weeklySentence(f: WindowForecast, now: number): { text: string; tone: Tone } {
  const reset = f.nextResetAt ? `first weekly reset ${fmtAt(f.nextResetAt, now)}` : undefined
  switch (f.status) {
    case 'learning':
      return f.needMs
        ? { text: `Not enough history yet. The forecast starts once there is a day of limit readings, ${fmtAbout(now + f.needMs, now)}.`, tone: 'idle' }
        : { text: 'No limit readings yet. They come with the next request each account serves.', tone: 'idle' }
    case 'idle':
      return { text: `No weekly use in the last ${fmtSpan(f.basisMs)}.`, tone: 'good' }
    case 'dry':
      return { text: `At its reserve now${f.backAt ? `; capacity comes back ${fmtAt(f.backAt, now)}` : ''}.`, tone: 'bad' }
    case 'runs-out': {
      const before = f.nextResetAt === undefined || f.dryAt! < f.nextResetAt
      const when = fmtAbout(f.dryAt!, now)
      return before
        ? { text: `At this pace the pool reaches its reserve ${when}${reset ? `; ${reset}` : ''}.`, tone: 'warn' }
        : { text: `At this pace the pool reaches its reserve ${when}${f.backAt ? `; capacity comes back ${fmtAt(f.backAt, now)}` : ''}.`, tone: 'warn' }
    }
    case 'lasts':
      return { text: `At this pace the weekly limits last beyond the next ${fmtSpan(f.horizonMs)}${reset ? `; ${reset}` : ''}.`, tone: 'good' }
  }
}

/** The 5-hour view, only when it matters: the pool's 5-hour capacity running out soon. */
export function fiveHourSentence(f: WindowForecast, now: number) {
  const reset = f.backAt ?? f.nextResetAt
  if (f.status === 'dry') return `5-hour limits are at their reserve${reset ? ` until ${fmtAt(reset, now)}` : ''}.`
  if (f.status === 'runs-out') return `5-hour limits run out ${fmtAbout(f.dryAt!, now)} at this pace${f.backAt ? `, back ${fmtAt(f.backAt, now)}` : ''}.`
  return undefined
}

export const CAUSES: Record<CacheBreakCause, { label: string; phrase: (n: number) => string }> = {
  reserve: { label: 'Moved by the account reserve', phrase: (n) => `the reserve moved ${n}` },
  'extra-usage': { label: 'Moved off an account on paid extra usage', phrase: (n) => `${n} moved off an account on paid extra usage` },
  limit: { label: 'Moved off an account at its limit', phrase: (n) => `${n} moved off an account at its limit` },
  failure: { label: 'Moved after a failed request', phrase: (n) => `${n} moved after a failed request` },
  moved: { label: 'Moved to another account', phrase: (n) => `${n} moved to another account` },
  idle: { label: 'Idle longer than the cache lasts', phrase: (n) => `${n} sat idle too long` },
  compaction: { label: 'Conversation compacted', phrase: (n) => `${n} were compacted` },
  unknown: { label: 'No clear cause', phrase: (n) => `${n} had no clear cause` },
}
