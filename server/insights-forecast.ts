import { historyStarts, limitHistory } from './limit-history.ts'
import { RESERVE_WINDOWS, limitWindows, type ReserveWindow } from './limit-windows.ts'
import { limitReadings } from './limits.ts'
import { byAccount, pools, usedAcross } from './insights-history.ts'
import type { ForecastReport, WindowForecast } from './insights-types.ts'
import { reserveLimits } from './reserve.ts'

/**
 * Run-out forecast: when each provider's pool reaches its reserve if use goes on at the pace of the
 * last few days. The pace is the pool's total use of the window, read from limit history, so it
 * includes the owners' own use. Capacity comes back per account at its reset.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

const WINDOWS: Record<ReserveWindow, { period: number; lookback: number; minHistory: number; horizon: number }> = {
  // Three days smooth out the daily rhythm of work; half a day is the least that says anything.
  weekly: { period: 7 * DAY, lookback: 3 * DAY, minHistory: 12 * HOUR, horizon: 14 * DAY },
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
 * fill-first routing uses them (priority, then file name); that only decides which capacity a
 * reset throws away, not the total. A reset is assumed to come once per period after the known one.
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

function windowForecast(kind: ReserveWindow, names: string[], accounts: SimAccount[], read: number, now: number, starts: Map<string, number>): WindowForecast {
  const { period, lookback, minHistory, horizon } = WINDOWS[kind]
  const left = accounts.reduce((s, a) => s + a.left, 0)
  const nextResetAt = Math.min(...accounts.map((a) => a.resetsAt ?? Infinity))
  const base = { left, read, horizonMs: horizon, basisMs: 0, nextResetAt: Number.isFinite(nextResetAt) ? nextResetAt : undefined }
  if (!read) return { ...base, status: 'learning' }
  if (left <= 1e-9) return { ...base, status: 'dry', backAt: base.nextResetAt }

  const first = Math.min(...names.map((n) => starts.get(n) ?? Infinity))
  const from = Math.max(now - lookback, first)
  const basisMs = Number.isFinite(from) ? now - from : 0
  if (basisMs < minHistory) return { ...base, status: 'learning', needMs: minHistory - basisMs }

  const history = byAccount(limitHistory(from, now + 1).filter((s) => names.includes(s.name)))
  let used = 0
  for (const windows of history.values()) used += usedAcross(windows[kind] ?? [])
  const perHour = used / (basisMs / HOUR)
  const out = { ...base, basisMs, perHour }
  if (used <= 0) return { ...out, status: 'idle' }
  const { dryAt, backAt } = simulate(accounts, perHour / HOUR, period, now, horizon)
  return dryAt === undefined ? { ...out, status: 'lasts' } : { ...out, status: 'runs-out', dryAt, backAt }
}

export function forecast(now = Date.now()): ForecastReport {
  const reserve = reserveLimits()
  const readings = limitReadings()
  const starts = historyStarts()
  const providers = []
  for (const [provider, members] of pools()) {
    if (!members.length) continue
    const sim: Record<ReserveWindow, SimAccount[]> = { weekly: [], '5h': [] }
    for (const m of members) {
      const windows: Partial<Record<ReserveWindow, { left: number; resetsAt?: number }>> = {}
      for (const w of limitWindows(provider, readings[m.name], now)) {
        const kind = RESERVE_WINDOWS[w.label]
        if (kind) windows[kind] = w
      }
      for (const kind of ['weekly', '5h'] as const) {
        const w = windows[kind]
        if (!w) continue
        const full = 1 - reserve[kind] / 100
        const a: SimAccount = { name: m.name, priority: m.priority, left: Math.max(0, w.left - reserve[kind] / 100), full, resetsAt: w.resetsAt }
        // An account held back for its weekly limit has no 5-hour capacity to give either.
        const weekly = sim.weekly.find((s) => s.name === m.name)
        if (kind === '5h' && weekly && weekly.left <= 1e-9) Object.assign(a, { left: 0, full: 0 })
        sim[kind].push(a)
      }
    }
    const names = members.map((m) => m.name)
    providers.push({
      provider,
      accounts: members.length,
      weekly: windowForecast('weekly', names, sim.weekly, sim.weekly.length, now, starts),
      fiveHour: windowForecast('5h', names, sim['5h'], sim['5h'].length, now, starts),
    })
  }
  return { at: now, reserve, providers }
}
