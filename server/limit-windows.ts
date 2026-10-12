/**
 * Usage limits per account, read from the rate-limit headers CPA last saw for it
 * (`anthropic-ratelimit-unified-*` for Claude, `x-codex-*` for Codex). Shared by the server (the
 * account reserve) and the SPA, so it imports nothing.
 */

export interface LimitReading {
  observed_at?: string
  signals: Record<string, string>
}

export interface LimitWindow {
  id: string
  label: string
  /** Share of the limit used, 0 to 1. */
  used: number
  /** Share of the limit left, 0 to 1. Zero once the provider rejects requests, even below 100% used. */
  left: number
  /** When the window resets (ms). Absent when unknown or already passed. */
  resetsAt?: number
  /** The window reset after the reading was taken, so nothing has been used since. */
  reset: boolean
  level: 'ok' | 'warning' | 'exhausted'
}

const num = (v: string | undefined) => {
  const n = Number(v)
  return v != null && v.trim() !== '' && Number.isFinite(n) ? n : undefined
}

export type ReserveWindow = '5h' | 'weekly'
/** The windows the account reserve covers, by the label limitWindows gives them. Model-scoped ones (Fable) are left to CPA. */
export const RESERVE_WINDOWS: Partial<Record<string, ReserveWindow>> = { '5h': '5h', Weekly: 'weekly' }

const CLAUDE_LABELS: Record<string, string> = { '5h': '5h', '7d': 'Weekly', '7d_oi': 'Fable' }

function windowLabel(minutes: number | undefined, slot: string) {
  if (!minutes) return slot === 'primary' ? '5h' : 'Weekly'
  if (Math.abs(minutes - 10_080) < 60) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`
}

const titleCase = (s: string) => s.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase())

export const hasReading = (r: LimitReading | undefined): r is LimitReading => !!r && Object.keys(r.signals ?? {}).length > 0

export function limitWindows(provider: string, reading: LimitReading | undefined, now: number): LimitWindow[] {
  if (!hasReading(reading)) return []
  const s = Object.fromEntries(Object.entries(reading.signals).map(([k, v]) => [k.toLowerCase(), v]))
  const observedAt = Date.parse(reading.observed_at ?? '') || now
  const out: LimitWindow[] = []
  const add = (w: { id: string; label: string; used: number; resetsAt?: number; rejected?: boolean; warned?: boolean }) => {
    const reset = w.resetsAt !== undefined && w.resetsAt <= now
    const used = reset ? 0 : Math.min(1, Math.max(0, w.used))
    const level = reset ? 'ok' : w.rejected || w.used >= 1 ? 'exhausted' : w.warned || w.used >= 0.8 ? 'warning' : 'ok'
    out.push({ id: w.id, label: w.label, used, left: level === 'exhausted' ? 0 : 1 - used, resetsAt: reset ? undefined : w.resetsAt, reset, level })
  }

  if (provider === 'claude') {
    const prefix = 'anthropic-ratelimit-unified-'
    const ids = Object.keys(s)
      .filter((k) => k.startsWith(prefix) && k.endsWith('-utilization'))
      .map((k) => k.slice(prefix.length, -'-utilization'.length))
      .filter((id) => id !== 'overage')
    const rank = (id: string) => (id in CLAUDE_LABELS ? Object.keys(CLAUDE_LABELS).indexOf(id) : 99)
    for (const id of ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      const used = num(s[`${prefix}${id}-utilization`])
      if (used === undefined) continue
      const reset = num(s[`${prefix}${id}-reset`])
      const status = s[`${prefix}${id}-status`]
      add({ id, label: CLAUDE_LABELS[id] ?? id, used, resetsAt: reset ? reset * 1000 : undefined, rejected: status === 'rejected', warned: status === 'allowed_warning' })
    }
  } else if (provider === 'codex') {
    const windows: { scope: string; slot: string }[] = []
    for (const k of Object.keys(s)) {
      const m = /^x-codex-(?:(.+)-)?(primary|secondary)-used-percent$/.exec(k)
      if (m) windows.push({ scope: m[1] ?? '', slot: m[2] })
    }
    windows.sort((a, b) => a.scope.localeCompare(b.scope) || a.slot.localeCompare(b.slot))
    for (const { scope, slot } of windows) {
      const base = `x-codex-${scope ? `${scope}-` : ''}${slot}-`
      const used = num(s[`${base}used-percent`])
      if (used === undefined) continue
      const resetAt = num(s[`${base}reset-at`])
      const resetAfter = num(s[`${base}reset-after-seconds`])
      const label = windowLabel(num(s[`${base}window-minutes`]), slot)
      const name = scope && (s[`x-codex-${scope}-limit-name`] || titleCase(scope.replace(/^additional-/, '')))
      add({
        id: `${scope}:${slot}`,
        label: name ? `${name} · ${label}` : label,
        used: used / 100,
        resetsAt: resetAt ? resetAt * 1000 : resetAfter !== undefined ? observedAt + resetAfter * 1000 : undefined,
      })
    }
  }
  return out
}

export interface ExtraUsage {
  /** Labels of the windows that ran out, as limitWindows gives them. */
  windows: string[]
  /** When the account stops billing extra usage: the reset of the window that ran out (ms). */
  until: number
}

const BILLING = new Set(['allowed', 'allowed_warning'])
/** The limits shared by every model. Others (Fable) only reject their own model, which CPA handles per model. */
const SHARED = new Set(['5h', '7d'])
/** How long to hold when the reading says extra usage is billing but not until when. */
const DEFAULT_HOLD_MS = 5 * 3_600_000

/**
 * Whether a Claude account is serving requests on paid extra usage, which bills its owner. Anthropic
 * keeps serving such an account once a shared limit runs out (its window, or the overall status,
 * reads `rejected`) as long as its overage claim stays allowed. Claude Code reads the overall
 * status the same way; the per-window check also catches a reading where only the window says so.
 * These headers are undocumented. Codex reports a credit balance but nothing that says credits are
 * being spent, so it is left out.
 */
export function extraUsage(provider: string, reading: LimitReading | undefined, now: number): ExtraUsage | undefined {
  if (provider !== 'claude' || !hasReading(reading)) return undefined
  const p = 'anthropic-ratelimit-unified-'
  const s = Object.fromEntries(Object.entries(reading.signals).map(([k, v]) => [k.toLowerCase(), v.trim().toLowerCase()]))
  // Retry-After comes with a rejected request, which was not billed.
  if (!BILLING.has(s[`${p}overage-status`]) || s['retry-after']) return undefined

  const windows = limitWindows(provider, reading, now)
  // A model-scoped window (Fable) that ran out turns the overall status `rejected` too. With both
  // shared windows reported and allowed, and the representative claim not naming one, only that
  // model bills, and the Fable reserve holds just that model (fable.ts). Callers only ask while
  // extra-usage holds are on, which the Fable hold follows too.
  const shared = windows.filter((w) => SHARED.has(w.id))
  const sharedOk =
    shared.length === SHARED.size &&
    shared.every((w) => w.level !== 'exhausted' && s[`${p}${w.id}-status`] !== 'rejected') &&
    !/(^|[^a-z_])(5h|7d|five_hour|seven_day)($|[^a-z_])/.test(s[`${p}representative-claim`] ?? '')
  const modelOnly = sharedOk && windows.some((w) => !SHARED.has(w.id) && w.level === 'exhausted')
  const rejected = s[`${p}status`] === 'rejected' && !modelOnly
  // Every response carries every window, so a model-scoped window that ran out only means billing
  // while the overall status says so too.
  const out = windows.filter((w) => w.level === 'exhausted' && w.resetsAt !== undefined && (SHARED.has(w.id) || rejected))
  if (out.length) return { windows: out.map((w) => w.label), until: Math.max(...out.map((w) => w.resetsAt!)) }
  // Once a window has reset since the reading, it no longer says anything about now.
  if (!rejected || windows.some((w) => w.reset)) return undefined

  // No window says which one ran out: fall back to the overall reset unless it is the end of the
  // extra-usage billing period, then to the soonest window reset, then to a few hours.
  const reset = num(s[`${p}reset`])
  const observedAt = Date.parse(reading.observed_at ?? '') || now
  if (reset && reset !== num(s[`${p}overage-reset`]) && reset * 1000 > now && reset * 1000 - observedAt <= 7 * 86_400_000 + 3_600_000) {
    return { windows: [], until: reset * 1000 }
  }
  const soonest = windows.filter((w) => w.resetsAt !== undefined).sort((a, b) => a.resetsAt! - b.resetsAt!)[0]
  const until = soonest?.resetsAt ?? observedAt + DEFAULT_HOLD_MS
  return until > now ? { windows: [], until } : undefined
}
