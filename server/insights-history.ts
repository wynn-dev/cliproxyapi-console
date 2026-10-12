import { listedCredentials, type LimitSample } from './limit-history.ts'
import { RESERVE_WINDOWS, type ReserveWindow } from './limit-windows.ts'
import { reserveStatus } from './reserve.ts'

/** Helpers the insights share for reading limit history. */

export const POOL_PROVIDERS = ['claude', 'codex']

export interface ProviderAccount {
  name: string
  priority: number
  /**
   * Whether the provider can draw on it: enabled, or held back by the console until a reset. An
   * account disabled by hand, or held until someone signs it in again, is out of the pool, though
   * its use still counts towards the pace.
   */
  inPool: boolean
}

/** Every Claude and Codex account CPA lists, by provider. */
export function accounts() {
  const held = reserveStatus().accounts
  const out = new Map<string, ProviderAccount[]>(POOL_PROVIDERS.map((p) => [p, []]))
  for (const c of listedCredentials()) {
    if (!c.provider || !out.has(c.provider)) continue
    const hold = held[c.name]
    out.get(c.provider)!.push({ name: c.name, priority: c.priority ?? 0, inPool: !c.disabled || (!!hold && hold.reason !== 'signed-out') })
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
 * Share of a window used from `from` on. Rises add up; after a reset, use starts again from zero; a
 * drop without a reset (the provider correcting itself) counts as nothing. Gaps don't matter: the
 * next reading still shows what was used meanwhile. A rise that started before `from` (from the
 * sample before it) counts in proportion to the part of it after `from`.
 */
export function usedSince(samples: LimitSample[], from: number) {
  let total = 0
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]]
    if (b.ts <= from) continue
    const reset =
      (a.resetsAt !== null && b.ts >= a.resetsAt) ||
      (b.used! < a.used! && a.resetsAt !== null && b.resetsAt !== null && b.resetsAt - a.resetsAt > RESET_SLACK_MS)
    const rise = reset ? b.used! : Math.max(0, b.used! - a.used!)
    total += a.ts >= from ? rise : (rise * (b.ts - from)) / (b.ts - a.ts)
  }
  return total
}

const KINDS: ReserveWindow[] = ['5h', 'weekly']
const STEP = 5 * 60_000

/**
 * Time in [from, to) the pool was dry: every account that had a reading by then at its reserve or
 * limit. An account only counts from its first sample, so history needs the sample before `from`.
 * Accounts in `unused` without any sample (with fill-first, ones that never served) count as free
 * throughout. `stretches` are the dry spans themselves, [start, end) in ms.
 */
export function dryTime(names: string[], history: ReturnType<typeof byAccount>, reserve: Record<ReserveWindow, number>, from: number, to: number, unused: string[] = []) {
  const neverRead = unused.some((name) => KINDS.every((kind) => !history.get(name)?.[kind]?.length))
  const out = { dryMs: 0, longestDryMs: 0, dryStretches: 0, stretches: [] as [number, number][] }
  let stretch = 0
  for (let t = from; t < to; t += STEP) {
    let known = neverRead
    let free = neverRead
    for (const name of names) {
      const windows = KINDS.map((kind) => ({ kind, s: sampleAt(history.get(name)?.[kind], t) })).filter((w) => w.s)
      if (!windows.length) continue
      known = true
      if (windows.every(({ kind, s }) => leftAt(s!, t) > reserve[kind] / 100 + 1e-9)) {
        free = true
        break
      }
    }
    const step = Math.min(STEP, to - t)
    if (known && !free) {
      if (!stretch) {
        out.dryStretches++
        out.stretches.push([t, t])
      }
      stretch += step
      out.stretches.at(-1)![1] = t + step
      out.dryMs += step
      out.longestDryMs = Math.max(out.longestDryMs, stretch)
    } else stretch = 0
  }
  return out
}
