import { credentialByIndex, historyStarts, limitHistory, type LimitSample } from './limit-history.ts'
import type { ReserveWindow } from './limit-windows.ts'
import { cacheBreaks, summarizeBreaks } from './insights-cache.ts'
import { accounts, byAccount, dryTime, leftAt } from './insights-history.ts'
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
const KINDS: ReserveWindow[] = ['5h', 'weekly']

export function digest(now = Date.now()): DigestReport {
  const from = now - WEEK
  const reserve = reserveLimits()
  const history = byAccount(limitHistory(from, now, undefined, { previous: true }))
  const starts = historyStarts()
  // Every account CPA lists, so one disabled by hand during the week still counts for the time it served.
  const members = accounts()
  const all = [...members.values()].flat()
  const firstSample = Math.min(...all.map((m) => starts.get(m.name) ?? Infinity))
  const free = (s: LimitSample, t: number, kind: ReserveWindow) => leftAt(s, t) > reserve[kind] / 100 + 1e-9

  const pools: DigestPool[] = []
  for (const [provider, list] of members) {
    if (!list.length) continue
    const names = list.map((a) => a.name)
    pools.push({ provider, accounts: list.length, ...dryTime(names, history, reserve, from, now) })
  }

  const traffic = db
    .prepare('SELECT auth_index AS authIndex, COUNT(*) AS requests, TOTAL(failed) AS failed, TOTAL(total_tokens) AS tokens FROM requests WHERE ts >= ? AND ts < ? GROUP BY auth_index')
    .all(from, now) as { authIndex: string; requests: number; failed: number; tokens: number }[]
  const byName = new Map<string, (typeof traffic)[number]>()
  for (const r of traffic) {
    const name = credentialByIndex(r.authIndex)?.name
    if (name) byName.set(name, r)
  }

  const rows: DigestAccount[] = []
  for (const [provider, list] of members) {
    for (const { name } of list) {
      const windows = history.get(name) ?? {}
      // No sample this week: the account served nothing. Otherwise the sample from before the
      // week says where the window stood when the week began.
      const samples = windows.weekly ?? []
      const weekly = samples.some((s) => s.ts >= from) ? samples.map((s) => 1 - leftAt(s, Math.max(s.ts, from))) : []
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
      rows.push({
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
    pools,
    accounts: rows,
    cacheBreaks: { sessions, ...summarizeBreaks(breaks) },
    requests: traffic.reduce((s, r) => s + r.requests, 0),
    failed: traffic.reduce((s, r) => s + r.failed, 0),
  }
}
