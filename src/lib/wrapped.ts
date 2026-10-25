import type { ShareSummary } from './types'

/**
 * What the wrapped slides show beyond the summary itself, worked out in the browser from the hourly
 * series, so days, weekdays and hours are the viewer's own (DST included).
 */

/** Every slide is one 16:9 image, the size X shows uncropped in the timeline. */
export const W = 1200
export const H = 675

/** Where the console lives, for the slide footer. */
export const REPO = 'github.com/wynn-dev/cliproxyapi-console'

const ACCENTS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-7)', 'var(--chart-5)', 'var(--chart-4)']
export const accentFor = (i: number) => ACCENTS[i % ACCENTS.length]

export type Personality = 'early-bird' | 'daytime' | 'evening' | 'night-owl'

/** Local hours of each part of the day; night wraps past midnight. */
export const DAY_PARTS: Record<Personality, { hours: number[]; title: string; when: string; line: (share: string) => string }> = {
  'early-bird': { hours: [5, 6, 7, 8], title: 'Early bird', when: 'Busiest from 5 to 9 am', line: (p) => `${p} of your tokens came between 5 and 9 am` },
  daytime: { hours: [9, 10, 11, 12, 13, 14, 15, 16], title: 'Daytime builder', when: 'Busiest from 9 am to 5 pm', line: (p) => `${p} of your tokens came between 9 am and 5 pm` },
  evening: { hours: [17, 18, 19, 20, 21], title: 'Evening hacker', when: 'Busiest from 5 to 10 pm', line: (p) => `${p} of your tokens came between 5 and 10 pm` },
  'night-owl': { hours: [22, 23, 0, 1, 2, 3, 4], title: 'Night owl', when: 'Busiest from 10 pm to 5 am', line: (p) => `${p} of your tokens came between 10 pm and 5 am` },
}

/** Rough sizes for the "by the numbers" comparisons. */
const TOKENS_PER_WORD = 4 / 3
/** A 90,000-word novel. */
const NOVEL_TOKENS = 90_000 * TOKENS_PER_WORD
/** War and Peace: about 587,000 words. */
const WAR_AND_PEACE_TOKENS = 587_000 * TOKENS_PER_WORD
const READING_WPM = 250

export interface Streak {
  days: number
  /** 0-based days of the month. */
  start: number
  end: number
}

export interface Award {
  id: string
  title: string
  line: string
}

export function deriveWrapped(s: ShareSummary, month: string, days: number) {
  const [y, m] = month.split('-').map(Number)
  const perDay = Array.from({ length: days }, () => 0)
  const byHour = Array.from({ length: 24 }, () => 0)
  // Monday first.
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  let peak: { t: number; tokens: number } | null = null
  let weekend = 0
  for (const h of s.hours) {
    const d = new Date(h.t)
    perDay[d.getDate() - 1] += h.tokens
    byHour[d.getHours()] += h.tokens
    const weekday = (d.getDay() + 6) % 7
    grid[weekday][d.getHours()] += h.tokens
    if (weekday >= 5) weekend += h.tokens
    if (!peak || h.tokens > peak.tokens) peak = h
  }
  const total = byHour.reduce((a, b) => a + b, 0)
  const busiest = perDay.reduce((best, n, i) => (n > perDay[best] ? i : best), 0)

  let streak: Streak = { days: 0, start: 0, end: 0 }
  for (let i = 0, run = 0; i < days; i++) {
    run = perDay[i] > 0 ? run + 1 : 0
    if (run > streak.days) streak = { days: run, start: i - run + 1, end: i }
  }

  // The part of the day with the most tokens per hour, so the 8-hour day doesn't win by length.
  const parts = (Object.keys(DAY_PARTS) as Personality[]).map((id) => {
    const tokens = DAY_PARTS[id].hours.reduce((a, h) => a + byHour[h], 0)
    return { id, tokens, density: tokens / DAY_PARTS[id].hours.length }
  })
  const top = parts.reduce((a, b) => (b.density > a.density ? b : a))

  const words = s.tokens / TOKENS_PER_WORD
  const numbers = {
    novels: s.output / NOVEL_TOKENS,
    warAndPeace: s.tokens / WAR_AND_PEACE_TOKENS,
    /** Years for one person to read every token, nonstop. */
    readingYears: words / READING_WPM / 60 / 24 / 365,
    perActiveDay: s.requests / Math.max(1, perDay.filter((n) => n > 0).length),
  }

  return {
    firstWeekday: (new Date(y, m - 1, 1).getDay() + 6) % 7,
    perDay,
    busiest,
    byHour,
    grid,
    peak,
    activeDays: perDay.filter((n) => n > 0).length,
    streak,
    personality: { id: top.id, share: total ? top.tokens / total : 0 },
    weekendShare: total ? weekend / total : 0,
    numbers,
  }
}

export type Wrapped = ReturnType<typeof deriveWrapped>

const pct = (n: number) => `${Math.round(n * 100)}%`
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** Up to six awards the month earned, the most striking first. */
export function awards(s: ShareSummary, w: Wrapped): Award[] {
  const out: Award[] = []
  const add = (ok: boolean | null | undefined, a: Award) => ok && out.push(a)
  const topShare = s.topModel && s.tokens ? s.topModel.tokens / s.tokens : 0
  add(s.tokens >= 1e9, { id: 'billion', title: 'Token billionaire', line: `${compact.format(s.tokens)} tokens in one month` })
  add(s.tokens >= 1e8 && s.tokens < 1e9, { id: 'hundred-million', title: 'Nine-figure month', line: `${compact.format(s.tokens)} tokens and counting` })
  add(!!s.planPrice && s.value >= s.planPrice * 5, { id: 'value', title: 'Value hunter', line: `${Math.floor(s.value / (s.planPrice ?? 1))}× the plan price in API value` })
  add(s.cacheHitRate != null && s.cacheHitRate >= 0.85, { id: 'cache', title: 'Cache wizard', line: `${pct(s.cacheHitRate ?? 0)} of input read from cache` })
  add(w.streak.days >= 7, { id: 'streak', title: 'Iron streak', line: `${w.streak.days} days in a row` })
  add(w.personality.share > 0, { id: w.personality.id, title: DAY_PARTS[w.personality.id].title, line: DAY_PARTS[w.personality.id].when })
  add((s.sessions.longest?.requests ?? 0) >= 200, { id: 'marathon', title: 'Marathoner', line: `${s.sessions.longest?.requests} requests in one conversation` })
  add(w.weekendShare >= 0.35, { id: 'weekend', title: 'Weekend warrior', line: `${pct(w.weekendShare)} of tokens on weekends` })
  add(topShare >= 0.7, { id: 'loyal', title: 'Model loyalist', line: `${pct(topShare)} on ${s.topModel?.model}` })
  add(topShare < 0.7 && s.topModels.length >= 4, { id: 'explorer', title: 'Model explorer', line: `${s.topModels.length}+ models in the mix` })
  return out.slice(0, 6)
}
