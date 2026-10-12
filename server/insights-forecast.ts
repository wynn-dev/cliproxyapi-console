import { historyStarts, limitHistory } from './limit-history.ts'
import { RESERVE_WINDOWS, hasReading, limitWindows, type ReserveWindow } from './limit-windows.ts'
import { limitReadings } from './limits.ts'
import { accounts, byAccount, dryTime, usedSince } from './insights-history.ts'
import type { ForecastReport, WindowForecast } from './insights-types.ts'
import { type ReserveLimits, reserveLimits, reserveStatus } from './reserve.ts'

/**
 * Run-out forecast: when each provider's pool reaches its reserve if use goes on at the pace of the
 * last few days. The pace is the total use of the window across the provider's accounts, as far as
 * limit history saw it (an account's readings only come with requests it serves). Capacity is the
 * pool's, and comes back per account at its reset.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

const WINDOWS: Record<ReserveWindow, { period: number; lookback: number; minHistory: number; horizon: number }> = {
  // Three days smooth out the daily rhythm of work; a whole day is the least that covers it once.
  weekly: { period: 7 * DAY, lookback: 3 * DAY, minHistory: DAY, horizon: 14 * DAY },
  '5h': { period: 5 * HOUR, lookback: 6 * HOUR, minHistory: HOUR, horizon: DAY },
}

export interface SimAccount {
  name: string
  priority: number
  /** Capacity above the reserve now, and after a reset (1 minus the reserve), in account-windows. */
  left: number
  full: number
  resetsAt?: number
}

/**
 * When the pool runs down to its reserve, using `perMs` of capacity at a steady pace. Between
 * resets the drain is linear, so this steps from reset to reset. Accounts drain in the order CPA's
 * fill-first routing uses them (priority, then file name). Before the first reset the order makes
 * no difference; after it, it decides how much capacity an account still had when its reset
 * replaced it, and so how much the reset adds. A reset is assumed to come once per period after
 * the known one.
 */
export function simulate(accounts: SimAccount[], perMs: number, period: number, now: number, horizon: number) {
  const pool = accounts.map((a) => ({ ...a })).sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  const end = now + horizon
  let t = now
  for (;;) {
    const next = Math.min(...pool.map((a) => a.resetsAt ?? Infinity))
    const total = pool.reduce((s, a) => s + a.left, 0)
    const dryAt = t + total / perMs
    if (dryAt <= Math.min(next, end)) return { dryAt, backAt: Number.isFinite(next) ? next : undefined }
    if (next > end) return {}
    let need = perMs * (next - t)
    for (const a of pool) {
      const take = Math.min(a.left, need)
      a.left -= take
      need -= take
    }
    t = next
    for (const a of pool) {
      if (a.resetsAt === undefined || a.resetsAt > t) continue
      a.left = a.full
      while (a.resetsAt <= t) a.resetsAt += period
    }
  }
}

interface Inputs {
  /** Every account of the provider, for the pace; the pool's, for when it is dry. */
  names: string[]
  pool: string[]
  starts: Map<string, number>
  reserve: ReserveLimits
  now: number
}

function windowForecast(kind: ReserveWindow, accounts: SimAccount[], read: number, stale: number, { names, pool, starts, reserve, now }: Inputs): WindowForecast {
  const { period, lookback, minHistory, horizon } = WINDOWS[kind]
  const left = accounts.reduce((s, a) => s + a.left, 0)
  const nextResetAt = Math.min(...accounts.map((a) => a.resetsAt ?? Infinity))
  const base = { left, read, stale, horizonMs: horizon, basisMs: 0, nextResetAt: Number.isFinite(nextResetAt) ? nextResetAt : undefined }
  if (!read) return { ...base, status: 'learning' }
  if (left <= 1e-9) return { ...base, status: 'dry', backAt: base.nextResetAt }

  const first = Math.min(...names.map((n) => starts.get(n) ?? Infinity))
  const from = Math.max(now - lookback, first)
  const history = byAccount(limitHistory(from, now + 1, undefined, { previous: true }).filter((s) => names.includes(s.name)))
  // While the pool was dry nothing could be used, so that time says nothing about the pace.
  const basisMs = Number.isFinite(from) ? now - from - dryTime(pool, history, reserve, from, now, pool).dryMs : 0
  if (basisMs < minHistory) return { ...base, status: 'learning', needMs: minHistory - basisMs }

  let used = 0
  for (const windows of history.values()) used += usedSince(windows[kind] ?? [], from)
  const perHour = used / (basisMs / HOUR)
  const out = { ...base, basisMs, perHour }
  if (used <= 0) return { ...out, status: 'idle' }
  const { dryAt, backAt } = simulate(accounts, perHour / HOUR, period, now, horizon)
  return dryAt === undefined ? { ...out, status: 'lasts' } : { ...out, status: 'runs-out', dryAt, backAt }
}

/** A reading this old may well be out of date: the account served nothing since. */
const STALE_MS = 12 * HOUR

export function forecast(now = Date.now()): ForecastReport {
  const reserve = reserveLimits()
  const readings = limitReadings()
  const held = reserveStatus().accounts
  const starts = historyStarts()
  const providers = []
  for (const [provider, all] of accounts()) {
    const members = all.filter((a) => a.inPool)
    if (!members.length) continue
    const sim: Record<ReserveWindow, SimAccount[]> = { weekly: [], '5h': [] }
    const read: Record<ReserveWindow, number> = { weekly: 0, '5h': 0 }
    const stale: Record<ReserveWindow, number> = { weekly: 0, '5h': 0 }
    for (const m of members) {
      const reading = readings[m.name]
      const old = now - (Date.parse(reading?.observed_at ?? '') || now) > STALE_MS
      const windows: Partial<Record<ReserveWindow, { left: number; resetsAt?: number }>> = {}
      for (const w of limitWindows(provider, reading, now)) {
        const kind = RESERVE_WINDOWS[w.label]
        if (kind) windows[kind] = w
      }
      for (const kind of ['weekly', '5h'] as const) {
        const w = windows[kind]
        const full = 1 - reserve[kind] / 100
        const hold = held[m.name]
        let a: SimAccount
        if (w) a = { name: m.name, priority: m.priority, left: Math.max(0, w.left - reserve[kind] / 100), full, resetsAt: w.resetsAt }
        // No reading at all: the account served nothing the console saw (with fill-first, one
        // further down the order), so its whole limit is still there.
        else if (!hasReading(reading)) a = { name: m.name, priority: m.priority, left: full, full }
        // A reading can lack a window; the reserve then holds the account until that window resets.
        else if (hold?.windows.includes(kind)) a = { name: m.name, priority: m.priority, left: 0, full, resetsAt: hold.until }
        else continue
        // An account held back for its weekly limit has no 5-hour capacity to give either.
        const weekly = sim.weekly.find((s) => s.name === m.name)
        if (kind === '5h' && weekly && weekly.left <= 1e-9) Object.assign(a, { left: 0, full: 0 })
        sim[kind].push(a)
        if (!w) continue
        read[kind]++
        if (old) stale[kind]++
      }
    }
    const inputs = { names: all.map((a) => a.name), pool: members.map((m) => m.name), starts, reserve, now }
    providers.push({
      provider,
      accounts: members.length,
      weekly: windowForecast('weekly', sim.weekly, read.weekly, stale.weekly, inputs),
      fiveHour: windowForecast('5h', sim['5h'], read['5h'], stale['5h'], inputs),
    })
  }
  return { at: now, reserve, providers }
}
