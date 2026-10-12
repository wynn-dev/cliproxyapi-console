import { credentialByIndex, historyStarts, limitHistory, type LimitSample } from './limit-history.ts'
import type { ReserveWindow } from './limit-windows.ts'
import { cacheBreaks, summarizeBreaks } from './insights-cache.ts'
import { byAccount, leftAt, pools, sampleAt } from './insights-history.ts'
import type { DigestAccount, DigestPool, DigestReport } from './insights-types.ts'
import { reserveLimits } from './reserve.ts'
import { db } from './usage.ts'

/**
 * Weekly digest: the facts behind a plain-language summary of the last 7 days. The SPA words them.
 *
 * Not here yet, from other work in progress: requests CPA turned away while the pool was dry
 * (item 11) and value at API prices per account (item 12). Both belong next to `requests` below
 * once usage.ts records them.
 */

const WEEK = 7 * 86_400_000
const STEP = 5 * 60_000
const KINDS: ReserveWindow[] = ['5h', 'weekly']

export function digest(now = Date.now()): DigestReport {
  const from = now - WEEK
  const reserve = reserveLimits()
  const history = byAccount(limitHistory(from, now, undefined, { previous: true }))
  const starts = historyStarts()
  const members = pools()
  const all = [...members.values()].flat()
  const firstSample = Math.min(...all.map((m) => starts.get(m.name) ?? Infinity))
  const start = Math.max(from, firstSample)
  const free = (s: LimitSample, t: number, kind: ReserveWindow) => leftAt(s, t) > reserve[kind] / 100 + 1e-9

  // Dry time: every account of the pool at its reserve or limit. An account without a reading yet is
  // counted as free, as CPA would still try it.
  const dryTime: DigestPool[] = []
  for (const [provider, accounts] of members) {
    if (!accounts.length) continue
    const p: DigestPool = { provider, accounts: accounts.length, dryMs: 0, longestDryMs: 0, dryStretches: 0 }
    let stretch = 0
    for (let t = start; t < now; t += STEP) {
      const dry = accounts.every(({ name }) =>
        KINDS.some((kind) => {
          const s = sampleAt(history.get(name)?.[kind], t)
          return !!s && !free(s, t, kind)
        }),
      )
      const step = Math.min(STEP, now - t)
      if (dry) {
        if (!stretch) p.dryStretches++
        stretch += step
        p.dryMs += step
        p.longestDryMs = Math.max(p.longestDryMs, stretch)
      } else stretch = 0
    }
    dryTime.push(p)
  }

  const traffic = db
    .prepare('SELECT auth_index AS authIndex, COUNT(*) AS requests, TOTAL(failed) AS failed, TOTAL(total_tokens) AS tokens FROM requests WHERE ts >= ? AND ts < ? GROUP BY auth_index')
    .all(from, now) as { authIndex: string; requests: number; failed: number; tokens: number }[]
  const byName = new Map<string, (typeof traffic)[number]>()
  for (const r of traffic) {
    const name = credentialByIndex(r.authIndex)?.name
    if (name) byName.set(name, r)
  }

  const accounts: DigestAccount[] = []
  for (const [provider, list] of members) {
    for (const { name } of list) {
      const windows = history.get(name) ?? {}
      // The sample from before the week says where the window stood when the week began.
      const weekly = (windows.weekly ?? []).map((s) => 1 - leftAt(s, Math.max(s.ts, from)))
      let reserveHits = 0
      for (const kind of KINDS) {
        const samples = windows[kind] ?? []
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i]
          if (s.ts < from || free(s, s.ts, kind)) continue
          const before = samples[i - 1]
          if (!before || free(before, s.ts, kind)) reserveHits++
        }
      }
      const t = byName.get(name)
      accounts.push({
        name,
        provider,
        peakWeekly: weekly.length ? Math.max(...weekly) : undefined,
        reserveHits,
        requests: t?.requests ?? 0,
        failed: t?.failed ?? 0,
        tokens: t?.tokens ?? 0,
      })
    }
  }

  const { breaks, sessions } = cacheBreaks(from, now)
  return {
    from,
    to: now,
    historyFrom: firstSample > from && Number.isFinite(firstSample) ? firstSample : undefined,
    pools: dryTime,
    accounts,
    cacheBreaks: { sessions, ...summarizeBreaks(breaks) },
    requests: traffic.reduce((s, r) => s + r.requests, 0),
    failed: traffic.reduce((s, r) => s + r.failed, 0),
  }
}
