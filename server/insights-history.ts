import { listedCredentials, type LimitSample } from './limit-history.ts'
import { RESERVE_WINDOWS, type ReserveWindow } from './limit-windows.ts'
import { reserveStatus } from './reserve.ts'

/** Helpers the insights share for reading limit history. */

export const POOL_PROVIDERS = ['claude', 'codex']

/**
 * The accounts each provider can draw on: enabled ones, and ones the reserve holds back until a
 * reset. An account disabled by hand is out of the pool.
 */
export function pools() {
  const held = reserveStatus().accounts
  const out = new Map<string, { name: string; priority: number }[]>(POOL_PROVIDERS.map((p) => [p, []]))
  for (const c of listedCredentials()) {
    if (!c.provider || !out.has(c.provider) || (c.disabled && !held[c.name])) continue
    out.get(c.provider)!.push({ name: c.name, priority: c.priority ?? 0 })
  }
  return out
}

/** Samples of the reserve's windows (5h, weekly) by credential, oldest first. Other windows are dropped. */
export function byAccount(samples: LimitSample[]) {
  const out = new Map<string, Partial<Record<ReserveWindow, LimitSample[]>>>()
  for (const s of samples) {
    const kind = RESERVE_WINDOWS[s.label]
    if (!kind || s.used === null) continue
    let windows = out.get(s.name)
    if (!windows) out.set(s.name, (windows = {}))
    ;(windows[kind] ??= []).push(s)
  }
  // Rows come per window id; a provider renaming a window would interleave two of them.
  for (const windows of out.values()) for (const list of Object.values(windows)) list.sort((a, b) => a.ts - b.ts)
  return out
}

/** The last sample at or before `t`, from samples sorted by time. */
export function sampleAt(samples: LimitSample[] | undefined, t: number) {
  if (!samples?.length || samples[0].ts > t) return undefined
  let [lo, hi] = [0, samples.length - 1]
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].ts <= t) lo = mid
    else hi = mid - 1
  }
  return samples[lo]
}

/** Share of a window left at `t`, judging by a sample taken before it: all of it once the window has reset. */
export function leftAt(s: LimitSample, t: number) {
  if (s.resetsAt !== null && s.resetsAt <= t) return 1
  return s.status === 'exhausted' ? 0 : 1 - (s.used ?? 0)
}

/** Reset times move a second or two between readings when derived from "resets in N seconds". */
const RESET_SLACK_MS = 60_000

/**
 * Share of a window used across its samples. Rises add up; after a reset, use starts again from
 * zero; a drop without a reset (the provider correcting itself) counts as nothing. Gaps between
 * samples don't matter: the next reading still shows what was used meanwhile.
 */
export function usedAcross(samples: LimitSample[]) {
  let total = 0
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]]
    const reset =
      (a.resetsAt !== null && b.ts >= a.resetsAt) ||
      (b.used! < a.used! && a.resetsAt !== null && b.resetsAt !== null && b.resetsAt - a.resetsAt > RESET_SLACK_MS)
    total += reset ? b.used! : Math.max(0, b.used! - a.used!)
  }
  return total
}
